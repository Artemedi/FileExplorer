import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const { mockInvoke, mockShowError, mockShowConfirm, mockShowSuccess } = vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockShowError: vi.fn(),
    mockShowConfirm: vi.fn(),
    mockShowSuccess: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mockInvoke,
}));

vi.mock('../src/utils/NotificationSystem', () => ({
    showError: mockShowError,
    showConfirm: mockShowConfirm,
    showSuccess: mockShowSuccess,
    showPasswordPrompt: vi.fn().mockResolvedValue(null),
}));

import {
    buildShellIntegrationCommand,
    consumeOscChunk,
    extractOscDirectory,
    extractOscPromptState,
    getParentRemoteDirs,
    isElevationCommand,
} from '../src/utils/terminalOsc';
import SftpProvider, { useSftp } from '../src/providers/SftpProvider';

afterEach(() => {
    cleanup();
});

describe('terminalOsc parser and shell integration helpers', () => {
    test('parses OSC 7 with BEL, ST, and URL-encoded spaces', () => {
        expect(extractOscDirectory('\x1b]7;file://db1/mnt/pg/postgresql/15\x07')).toBe(
            '/mnt/pg/postgresql/15'
        );
        expect(extractOscDirectory('\x1b]7;file:///var/log/my%20app/\x1b\\')).toBe(
            '/var/log/my app'
        );
    });

    test('parses Ubuntu title with space, root prompt, and mc title', () => {
        expect(extractOscDirectory('\x1b]0;vitakor@host: /etc/postgresql\x07')).toBe(
            '/etc/postgresql'
        );
        expect(extractOscDirectory('\x1b]2;root@mis-lpu-dbpg-t:/mnt/pg/postgresql/15/main\x07')).toBe(
            '/mnt/pg/postgresql/15/main'
        );
        expect(extractOscDirectory('\x1b]0;mc [root@mis-lpu-dbpg-t]:/mnt/pg/postgresql/15/main\x07')).toBe(
            '/mnt/pg/postgresql/15/main'
        );
        expect(extractOscDirectory('\x1b]0;mc - /var/lib/pgsql\x07')).toBe('/var/lib/pgsql');
    });

    test('resolves ~ and ~/sub via homeDir and ignores unresolved ~', () => {
        expect(extractOscDirectory('\x1b]0;user@host:~\x07', null)).toBeNull();
        expect(extractOscDirectory('\x1b]0;user@host:~\x07', '/home/vitakor')).toBe(
            '/home/vitakor'
        );
        expect(extractOscDirectory('\x1b]0;user@host: ~/scripts/\x07', '/home/vitakor')).toBe(
            '/home/vitakor/scripts'
        );
    });

    test('buffers partial OSC sequences across chunks including ESC and ST splits', () => {
        const s1 = consumeOscChunk('', 'prompt$ \x1b]0;user@host: /opt');
        expect(s1.completed).toBe('prompt$ ');
        expect(s1.remainingBuffer).toBe('\x1b]0;user@host: /opt');
        expect(extractOscDirectory(s1.completed)).toBeNull();

        const s2 = consumeOscChunk(s1.remainingBuffer, '/app\x1b');
        expect(s2.completed).toBe('');
        expect(s2.remainingBuffer).toBe('\x1b]0;user@host: /opt/app\x1b');

        const s3 = consumeOscChunk(s2.remainingBuffer, '\\$ ');
        expect(s3.remainingBuffer).toBe('');
        expect(extractOscDirectory(s3.completed)).toBe('/opt/app');

        const escSplit1 = consumeOscChunk('', 'text\x1b');
        expect(escSplit1.remainingBuffer).toBe('\x1b');
        const escSplit2 = consumeOscChunk(escSplit1.remainingBuffer, ']7;file://h/srv\x07');
        expect(extractOscDirectory(escSplit2.completed)).toBe('/srv');
    });

    test('tracks OSC 133 prompt idle/busy markers and elevation commands', () => {
        expect(extractOscPromptState('\x1b]133;A\x07')).toBe('idle');
        expect(extractOscPromptState('\x1b]133;C\x07output\x1b]133;A\x07')).toBe('idle');
        expect(extractOscPromptState('\x1b]133;A\x07ls\r\n\x1b]133;C\x07')).toBe('busy');
        expect(extractOscPromptState('plain text')).toBeNull();

        expect(isElevationCommand('sudo -i')).toBe(true);
        expect(isElevationCommand('  sudo -s')).toBe(true);
        expect(isElevationCommand('sudo su -')).toBe(true);
        expect(isElevationCommand('su')).toBe(true);
        expect(isElevationCommand('su - postgres')).toBe(true);
        expect(isElevationCommand('sudo ls /root')).toBe(false);
        expect(isElevationCommand('ls -la')).toBe(false);

        const hookCmd = buildShellIntegrationCommand();
        expect(hookCmd.startsWith(' ')).toBe(true);
        expect(hookCmd.endsWith('clear\n')).toBe(true);
        expect(hookCmd).toContain('PROMPT_COMMAND');
        expect(hookCmd).toContain('ZSH_VERSION');
    });

    test('computes parent directories up to N levels stopping at /', () => {
        expect(getParentRemoteDirs('/mnt/pg/postgresql/15/main', 3)).toEqual([
            '/mnt/pg/postgresql/15',
            '/mnt/pg/postgresql',
            '/mnt/pg',
        ]);
        expect(getParentRemoteDirs('/root', 3)).toEqual(['/']);
        expect(getParentRemoteDirs('/', 3)).toEqual([]);
    });
});

describe('SftpProvider permission denied error reporting', () => {
    beforeEach(() => {
        localStorage.clear();
        mockInvoke.mockReset();
        mockShowError.mockReset();
    });

    test('reports clear permission denied toast instead of Failed to connect', async () => {
        localStorage.setItem(
            'fileExplorerSftpConnections',
            JSON.stringify([{ name: 'SevasTest', host: '10.92.239.23', port: 22, username: 'vitakor' }])
        );
        mockInvoke.mockRejectedValueOnce(new Error('[SFTP(3)] permission denied'));

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
        await waitFor(() => expect(api.sftpConnections).toHaveLength(1));

        let res;
        await act(async () => {
            res = await api.loadSftpDirectory('sftp:SevasTest:/mnt/pg/postgresql/15/main');
        });

        expect(res).toBeNull();
        expect(mockShowError).toHaveBeenCalledWith(
            'Permission denied for "/mnt/pg/postgresql/15/main" (user vitakor)'
        );
    });
});
