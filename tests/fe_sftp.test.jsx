import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { mockInvoke, mockShowConfirm, mockShowError, mockShowSuccess, mockShowPasswordPrompt } = vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockShowConfirm: vi.fn(),
    mockShowError: vi.fn(),
    mockShowSuccess: vi.fn(),
    mockShowPasswordPrompt: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mockInvoke
}));

vi.mock('../src/utils/NotificationSystem', () => ({
    showConfirm: mockShowConfirm,
    showError: mockShowError,
    showSuccess: mockShowSuccess,
    showPasswordPrompt: mockShowPasswordPrompt
}));

import SftpProvider, { useSftp } from '../src/providers/SftpProvider';

const STORAGE_KEY = 'fileExplorerSftpConnections';

function renderSftpHarness() {
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
    return {
        getApi: () => api
    };
}

describe('SftpProvider (BUG-007, BUG-026, TP-FE-STATE-01, TP-FE-STATE-06, TP-IPC-03)', () => {
    beforeEach(() => {
        localStorage.clear();
        mockInvoke.mockReset();
        mockShowConfirm.mockReset();
        mockShowError.mockReset();
        mockShowSuccess.mockReset();
        mockShowPasswordPrompt.mockReset();
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    test('TP-FE-STATE-01: migrates legacy passwords from localStorage, strips them immediately, and never logs secrets', async () => {
        const legacyConnections = [
            {
                name: 'prod',
                host: 'sftp.example.com',
                port: 2222,
                username: 'alice',
                password: 'super-secret-password'
            }
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(legacyConnections));

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'store_sftp_credentials') return null;
            if (cmd === 'load_dir') {
                return JSON.stringify({
                    sftp_directory: '/home/alice',
                    directories: [],
                    files: ['/home/alice/readme.txt']
                });
            }
            return null;
        });

        const { getApi } = renderSftpHarness();

        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('store_sftp_credentials', {
                connectionKey: 'alice@sftp.example.com:2222',
                password: 'super-secret-password'
            });
        });

        // Password must be stripped from localStorage immediately
        const storedRaw = localStorage.getItem(STORAGE_KEY);
        expect(storedRaw).not.toContain('super-secret-password');
        const storedParsed = JSON.parse(storedRaw);
        expect(storedParsed).toHaveLength(1);
        expect(storedParsed[0]).not.toHaveProperty('password');

        // Navigate and verify password is not sent from localStorage (empty string lets Rust read credential store)
        await act(async () => {
            await getApi().loadSftpDirectory('sftp:prod:/home/alice');
        });

        expect(mockInvoke).toHaveBeenCalledWith('load_dir', {
            host: 'sftp.example.com',
            port: 2222,
            username: 'alice',
            password: '',
            directory: '/home/alice'
        });

        // No console.log or console.error leaked the secret
        const allLogged = [
            ...logSpy.mock.calls.flat(),
            ...errorSpy.mock.calls.flat()
        ].map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
        expect(allLogged.join(' ')).not.toContain('super-secret-password');
        expect(logSpy).not.toHaveBeenCalled();
    });

    test('R3: a stale SFTP response cannot replace active connection or directory', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([
            { name: 'A', host: 'a.invalid', port: 22, username: 'test' },
            { name: 'B', host: 'b.invalid', port: 22, username: 'test' },
        ]));
        let resolve;
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'load_dir') {
                if (args.host === 'a.invalid') return new Promise((r) => { resolve = r; });
                return JSON.stringify({ directories: [], files: [] });
            }
            return null;
        });
        const { getApi } = renderSftpHarness();
        let current = true;
        let pending;
        act(() => { pending = getApi().loadSftpDirectory('sftp:A:/old', { isCurrent: () => current }); });
        await waitFor(() => expect(resolve).toBeTypeOf('function'));
        current = false;
        await act(async () => { await getApi().loadSftpDirectory('sftp:B:/new'); });
        await act(async () => {
            resolve(JSON.stringify({ directories: [], files: [] }));
            expect(await pending).toBeNull();
        });
        expect(getApi().currentSftpConnection.name).toBe('B');
        expect(getApi().currentSftpPath).toBe('/new');
    });

    test('AUDIT: stale directory request must not open a new trust dialog', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([
            { name: 'A', host: 'a.invalid', port: 22, username: 'test' },
            { name: 'B', host: 'b.invalid', port: 22, username: 'test' },
        ]));
        let rejectOld;
        mockShowConfirm.mockResolvedValue(false);
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'load_dir') {
                if (args.host === 'a.invalid') return new Promise((_, reject) => { rejectOld = reject; });
                return JSON.stringify({ directories: [], files: [] });
            }
            return null;
        });
        const { getApi } = renderSftpHarness();
        let current = true;
        let pending;
        act(() => { pending = getApi().loadSftpDirectory('sftp:A:/old', { isCurrent: () => current }); });
        await waitFor(() => expect(rejectOld).toBeTypeOf('function'));
        current = false;
        await act(async () => { await getApi().loadSftpDirectory('sftp:B:/new'); });
        await act(async () => { rejectOld('HOST_KEY_UNTRUSTED:SHA256:fixture'); await pending; });
        expect(getApi().currentSftpConnection.name).toBe('B');
        expect(mockShowConfirm).not.toHaveBeenCalled();
    });

    test.each(['trust', 'sudo'])('R3.4: stale %s confirmation cannot start another IPC operation', async (kind) => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([
            { name: 'A', host: 'a.invalid', port: 22, username: 'test' },
            { name: 'B', host: 'b.invalid', port: 22, username: 'test' },
        ]));
        let confirm;
        const prompt = kind === 'trust' ? mockShowConfirm : mockShowPasswordPrompt;
        prompt.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'load_dir') {
                if (args.host === 'a.invalid') throw new Error(kind === 'trust'
                    ? 'HOST_KEY_UNTRUSTED:SHA256:fixture' : 'Permission denied');
                return JSON.stringify({ directories: [], files: [] });
            }
            return null;
        });
        const { getApi } = renderSftpHarness();
        let current = true;
        let pending;
        act(() => { pending = getApi().loadSftpDirectory('sftp:A:/old', { isCurrent: () => current }); });
        await waitFor(() => expect(confirm).toBeTypeOf('function'));
        current = false;
        await act(async () => { await getApi().loadSftpDirectory('sftp:B:/new'); });
        await act(async () => { confirm(kind === 'trust' ? true : 'fixture-password'); expect(await pending).toBeNull(); });
        expect(getApi().currentSftpConnection.name).toBe('B');
        expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === 'trust_sftp_host_key' || cmd === 'ssh_sudo_exec')).toHaveLength(0);
        expect(mockInvoke.mock.calls.filter(([cmd, args]) => cmd === 'load_dir' && args.host === 'a.invalid')).toHaveLength(1);
    });

    test('TP-FE-STATE-06: parseSftpPath handles @ in path, : in connection name, and numeric port in sftp:// URLs', async () => {
        const connections = [
            { name: 'conn', host: 'host.internal', port: 2222, username: 'dev' },
            { name: 'prod:eu', host: 'eu.example.com', port: 22, username: 'ops' }
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));

        const { getApi } = renderSftpHarness();

        await waitFor(() => {
            expect(getApi().sftpConnections).toHaveLength(2);
        });

        const atPath = getApi().parseSftpPath('sftp:conn:app/@types');
        expect(atPath).toEqual({
            connection: expect.objectContaining({ name: 'conn', port: 2222 }),
            remotePath: 'app/@types',
            connectionName: 'conn'
        });

        const colonConnPath = getApi().parseSftpPath('sftp:prod:eu:/var/www');
        expect(colonConnPath).toEqual({
            connection: expect.objectContaining({ name: 'prod:eu', host: 'eu.example.com' }),
            remotePath: '/var/www',
            connectionName: 'prod:eu'
        });

        const urlPath = getApi().parseSftpPath('sftp://dev@host.internal:2222/app');
        expect(urlPath).toEqual({
            connection: expect.objectContaining({ name: 'conn', port: 2222 }),
            remotePath: '/app',
            connectionName: 'conn'
        });
    });

    test('TP-FE-STATE-06: normalizes Windows backslashes, filters ./.. entries, maps FileEntry shape, and preserves state on error', async () => {
        const connections = [
            { name: 'winbox', host: '10.0.0.5', port: 22, username: 'admin' }
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));

        mockInvoke.mockResolvedValueOnce(
            JSON.stringify({
                sftp_directory: '/srv',
                directories: ['.', '..', './.', '.\\..', '.\\subdir', '/var\\log'],
                files: ['.\\notes.txt', '/srv\\app.log']
            })
        );

        const { getApi } = renderSftpHarness();
        await waitFor(() => {
            expect(getApi().sftpConnections).toHaveLength(1);
        });

        let data;
        await act(async () => {
            data = await getApi().loadSftpDirectory('sftp:winbox:/srv');
        });

        expect(data.directories).toEqual([
            {
                name: 'subdir',
                path: 'sftp:winbox:subdir',
                isDirectory: true,
                is_symlink: false,
                size_in_bytes: 0,
                last_modified: null,
                sub_file_count: 0,
                sub_dir_count: 0,
                size: 0,
                modified: null
            },
            {
                name: 'log',
                path: 'sftp:winbox:/var/log',
                isDirectory: true,
                is_symlink: false,
                size_in_bytes: 0,
                last_modified: null,
                sub_file_count: 0,
                sub_dir_count: 0,
                size: 0,
                modified: null
            }
        ]);

        expect(data.files).toEqual([
            {
                name: 'notes.txt',
                path: 'sftp:winbox:notes.txt',
                isDirectory: false,
                is_symlink: false,
                size_in_bytes: 0,
                last_modified: null,
                size: 0,
                modified: null
            },
            {
                name: 'app.log',
                path: 'sftp:winbox:/srv/app.log',
                isDirectory: false,
                is_symlink: false,
                size_in_bytes: 0,
                last_modified: null,
                size: 0,
                modified: null
            }
        ]);

        expect(getApi().currentSftpConnection).toEqual(expect.objectContaining({ name: 'winbox' }));
        expect(getApi().currentSftpPath).toBe('/srv');

        // Simulate load_dir failure on next navigation: previous state must not be clobbered
        mockInvoke.mockRejectedValueOnce(new Error('Connection timed out'));
        let failedData;
        await act(async () => {
            failedData = await getApi().loadSftpDirectory('sftp:winbox:/broken');
        });

        expect(failedData).toBeNull();
        expect(getApi().currentSftpConnection).toEqual(expect.objectContaining({ name: 'winbox' }));
        expect(getApi().currentSftpPath).toBe('/srv');
        expect(mockShowError).toHaveBeenCalled();
    });

    test('TP-IPC-03: rejects invalid/empty port before calling invoke', async () => {
        const connections = [
            { name: 'badport', host: 'example.com', port: '', username: 'user' }
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));

        const { getApi } = renderSftpHarness();
        await waitFor(() => {
            expect(getApi().sftpConnections).toHaveLength(1);
        });

        let result;
        await act(async () => {
            result = await getApi().loadSftpDirectory('sftp:badport:/');
        });

        expect(result).toBeNull();
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining('Invalid SFTP port'));
    });

    test('HOST_KEY_UNTRUSTED: prompts user with showConfirm, trusts key on confirm, and retries operation', async () => {
        const connections = [
            { name: 'newserver', host: 'new.example.com', port: 2222, username: 'alice' }
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));

        const fingerprint = 'SHA256:abc123testfingerprint';
        mockInvoke
            .mockRejectedValueOnce(`HOST_KEY_UNTRUSTED:${fingerprint}`)
            .mockResolvedValueOnce(null) // trust_sftp_host_key
            .mockResolvedValueOnce(
                JSON.stringify({
                    sftp_directory: '/',
                    directories: ['/etc'],
                    files: []
                })
            );
        mockShowConfirm.mockResolvedValueOnce(true);

        const { getApi } = renderSftpHarness();
        await waitFor(() => {
            expect(getApi().sftpConnections).toHaveLength(1);
        });

        let result;
        await act(async () => {
            result = await getApi().loadSftpDirectory('sftp:newserver:/');
        });

        expect(mockShowConfirm).toHaveBeenCalledWith(
            expect.stringContaining(fingerprint),
            'Untrusted SSH Host Key'
        );
        expect(mockInvoke).toHaveBeenNthCalledWith(2, 'trust_sftp_host_key', {
            host: 'new.example.com',
            port: 2222,
            expectedFingerprint: fingerprint
        });
        expect(mockInvoke).toHaveBeenNthCalledWith(3, 'load_dir', {
            host: 'new.example.com',
            port: 2222,
            username: 'alice',
            password: '',
            directory: '/'
        });
        expect(result.directories).toHaveLength(1);
        expect(getApi().currentSftpPath).toBe('/');
    });

    test('HOST_KEY_UNTRUSTED: aborts without calling trust_sftp_host_key when user cancels', async () => {
        const connections = [
            { name: 'newserver', host: 'new.example.com', port: 22, username: 'alice' }
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));

        mockInvoke.mockRejectedValueOnce('HOST_KEY_UNTRUSTED:SHA256:declinedkey');
        mockShowConfirm.mockResolvedValueOnce(false);

        const { getApi } = renderSftpHarness();
        await waitFor(() => {
            expect(getApi().sftpConnections).toHaveLength(1);
        });

        let result;
        await act(async () => {
            result = await getApi().loadSftpDirectory('sftp:newserver:/');
        });

        expect(result).toBeNull();
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
    });

    test('deleteSftpItem does not fall back to delete_directory_sftp on authentication errors', async () => {
        const connections = [
            { name: 'prod', host: 'sftp.example.com', port: 22, username: 'alice' }
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));

        mockInvoke.mockRejectedValueOnce(new Error('Authentication failed'));

        const { getApi } = renderSftpHarness();
        await waitFor(() => {
            expect(getApi().sftpConnections).toHaveLength(1);
        });

        let ok;
        await act(async () => {
            ok = await getApi().deleteSftpItem('sftp:prod:/file.txt');
        });

        expect(ok).toBe(false);
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockInvoke).toHaveBeenCalledWith('delete_file_sftp', expect.any(Object));
    });
});
