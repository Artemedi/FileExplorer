import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { mockInvoke, mockShowError, mockShowConfirm, mockShowSuccess, mockShowPasswordPrompt } = vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockShowError: vi.fn(),
    mockShowConfirm: vi.fn(),
    mockShowSuccess: vi.fn(),
    mockShowPasswordPrompt: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mockInvoke,
}));

vi.mock('../src/utils/NotificationSystem', () => ({
    showError: mockShowError,
    showConfirm: mockShowConfirm,
    showSuccess: mockShowSuccess,
    showPasswordPrompt: mockShowPasswordPrompt,
}));

import { parseSudoFindOutput } from '../src/utils/sftpSudoParser';
import SftpProvider, { useSftp } from '../src/providers/SftpProvider';
import StatusBar from '../src/components/explorer/StatusBar';

afterEach(() => {
    cleanup();
});

describe('parseSudoFindOutput', () => {
    const conn = { name: 'SevasTest', host: '10.92.239.23', port: 22, username: 'vitakor' };
    const mkUrl = (c, p) => `sftp:${c.name}:${p}`;

    test('parses NUL-delimited GNU find records into directories, files, and symlinks', () => {
        const stdout = [
            'd\t4096\t1760000000.0\tpg_wal',
            'f\t1234\t1760000100.5\tpostgresql.conf',
            'l\t14\t1760000200.0\tcurrent_log',
            '',
        ].join('\0');

        const parsed = parseSudoFindOutput(stdout, conn, '/mnt/pg/postgresql/15/main', mkUrl);
        expect(parsed.directories).toHaveLength(1);
        expect(parsed.directories[0]).toMatchObject({
            name: 'pg_wal',
            path: 'sftp:SevasTest:/mnt/pg/postgresql/15/main/pg_wal',
            isDirectory: true,
            is_symlink: false,
            size_in_bytes: 0,
            sub_file_count: 0,
            sub_dir_count: 0,
        });

        expect(parsed.files).toHaveLength(2);
        expect(parsed.files[0]).toMatchObject({
            name: 'postgresql.conf',
            path: 'sftp:SevasTest:/mnt/pg/postgresql/15/main/postgresql.conf',
            isDirectory: false,
            is_symlink: false,
            size_in_bytes: 1234,
        });
        expect(parsed.files[1]).toMatchObject({
            name: 'current_log',
            isDirectory: false,
            is_symlink: true,
        });
    });
});

describe('SftpProvider sudo directory listing and password cache', () => {
    beforeEach(() => {
        localStorage.clear();
        mockInvoke.mockReset();
        mockShowError.mockReset();
        mockShowSuccess.mockReset();
        mockShowPasswordPrompt.mockReset();
        localStorage.setItem(
            'fileExplorerSftpConnections',
            JSON.stringify([{ name: 'SevasTest', host: '10.92.239.23', port: 22, username: 'vitakor' }])
        );
    });

    function renderSftp() {
        let api;
        function Harness() {
            api = useSftp();
            return null;
        }
        render(
            <SftpProvider>
                <Harness />
            </SftpProvider>
        );
        return { getApi: () => api };
    }

    test('falls back to ssh_sudo_exec list_dir on permission denied and reuses session password cache', async () => {
        mockShowPasswordPrompt.mockResolvedValue('secret-sudo');
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'load_dir') {
                throw new Error('[SFTP(3)] permission denied');
            }
            if (cmd === 'ssh_sudo_exec' && args.operation === 'list_dir') {
                return 'd\t4096\t1760000000\tbase\0f\t512\t1760000000\tpg_hba.conf\0';
            }
            return null;
        });

        const { getApi } = renderSftp();
        await waitFor(() => expect(getApi().sftpConnections).toHaveLength(1));

        let res1;
        await act(async () => {
            res1 = await getApi().loadSftpDirectory('sftp:SevasTest:/mnt/pg/postgresql/15/main');
        });
        expect(res1).toMatchObject({
            elevated: true,
            directories: [expect.objectContaining({ name: 'base' })],
            files: [expect.objectContaining({ name: 'pg_hba.conf', size_in_bytes: 512 })],
        });
        expect(mockShowPasswordPrompt).toHaveBeenCalledTimes(1);

        // Second elevated navigation must reuse cached password without re-prompting
        let res2;
        await act(async () => {
            res2 = await getApi().loadSftpDirectory('sftp:SevasTest:/mnt/pg/postgresql/15/main/base');
        });
        expect(res2.elevated).toBe(true);
        expect(mockShowPasswordPrompt).toHaveBeenCalledTimes(1);
        expect(mockShowError).not.toHaveBeenCalled();
    });

    test('evicts cached password and re-prompts once when sudo reports incorrect password', async () => {
        mockShowPasswordPrompt
            .mockResolvedValueOnce('good-pass-1')
            .mockResolvedValueOnce('new-pass-2');

        let sudoAttempts = 0;
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'load_dir') {
                throw new Error('[SFTP(3)] permission denied');
            }
            if (cmd === 'ssh_sudo_exec' && args.operation === 'list_dir') {
                sudoAttempts++;
                if (args.sudoPassword === 'good-pass-1' && sudoAttempts === 2) {
                    throw new Error('Sorry, try again.\nsudo: 1 incorrect password attempt');
                }
                return 'f\t10\t1760000000\tok.txt\0';
            }
            return null;
        });

        const { getApi } = renderSftp();
        await waitFor(() => expect(getApi().sftpConnections).toHaveLength(1));

        await act(async () => {
            await getApi().loadSftpDirectory('sftp:SevasTest:/root/a');
        });
        expect(mockShowPasswordPrompt).toHaveBeenCalledTimes(1);

        // Second call hits incorrect password with cached password -> evicts and re-prompts once
        let res2;
        await act(async () => {
            res2 = await getApi().loadSftpDirectory('sftp:SevasTest:/root/b');
        });
        expect(mockShowPasswordPrompt).toHaveBeenCalledTimes(2);
        expect(res2.files[0].name).toBe('ok.txt');
    });
});

describe('StatusBar elevated sudo badge', () => {
    test('renders sudo badge only when isElevated is true', () => {
        const data = { directories: [], files: [{ name: 'pg.conf', size_in_bytes: 10 }] };
        const { rerender } = render(<StatusBar data={data} selectedItems={[]} isElevated={false} />);
        expect(screen.queryByText('sudo')).not.toBeInTheDocument();

        rerender(<StatusBar data={data} selectedItems={[]} isElevated={true} />);
        expect(screen.getByText('sudo')).toBeInTheDocument();
    });
});
