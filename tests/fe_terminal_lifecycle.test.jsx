import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { mockInvoke, mockListen, mockStart, mockWrite } = vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockListen: vi.fn(),
    mockStart: vi.fn(),
    mockWrite: vi.fn(),
}));
const connection = { name: 'Test', host: 'test.invalid', username: 'test', port: 22 };

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mockListen }));
vi.mock('../src/providers/HistoryProvider', () => ({
    useHistory: () => ({ currentPath: 'sftp:Test:/test', navigateTo: vi.fn() }),
}));
vi.mock('../src/providers/FileSystemProvider', () => ({
    useFileSystem: () => ({ loadDirectory: vi.fn() }),
}));
vi.mock('../src/providers/SettingsProvider', () => ({
    useSettings: () => ({ settings: { terminal_height: 240 } }),
}));
vi.mock('../src/providers/SftpProvider', () => ({
    useSftp: () => ({
        isSftpPath: (path) => path?.startsWith('sftp:'),
        parseSftpPath: () => ({ connection, remotePath: '/test' }),
        createSftpUrl: () => 'sftp:Test:/test',
        executeSshCommand: async () => ({ exit_code: 0, stdout: '/test' }),
        startSshPty: mockStart,
    }),
}));
vi.mock('../src/components/terminal/XtermSshView', () => ({
    default: ({ sessionId, registerController }) => {
        React.useEffect(() => {
            registerController(sessionId, { write: mockWrite, getBufferText: () => '' });
            return () => registerController(sessionId, null);
        }, [sessionId]);
        return <div data-testid={sessionId} />;
    },
}));

import Terminal from '../src/components/terminal/Terminal';

describe('TERM-R1 PTY lifecycle', () => {
    let listeners;
    const emit = (event, payload) => act(() => listeners[event]({ payload }));

    beforeEach(() => {
        vi.clearAllMocks();
        listeners = {};
        mockInvoke.mockResolvedValue(null);
        mockStart.mockResolvedValue('pty-1');
        mockListen.mockImplementation(async (name, handler) => {
            listeners[name] = handler;
            return () => delete listeners[name];
        });
    });

    afterEach(cleanup);

    test('hide and show preserves the PTY and terminal view; unmount closes it', async () => {
        const { rerender, unmount } = render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        const view = await screen.findByTestId('pty-1');
        rerender(<Terminal isOpen={false} onToggle={vi.fn()} />);
        expect(view).not.toBeVisible();
        expect(mockInvoke).not.toHaveBeenCalledWith('ssh_close_pty', expect.anything());
        rerender(<Terminal isOpen={true} onToggle={vi.fn()} />);
        expect(screen.getByTestId('pty-1')).toBe(view);
        expect(mockStart).toHaveBeenCalledTimes(1);
        unmount();
        expect(mockInvoke).toHaveBeenCalledWith('ssh_close_pty', { sessionId: 'pty-1' });
    });

    test('exit enables explicit reconnect; stale exit cannot clear the new PTY', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2');
        render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        await screen.findByTestId('pty-1');
        emit('ssh-pty-exit', { session_id: 'pty-1', reason: 'transport lost' });
        const reconnect = await screen.findByRole('button', { name: 'Reconnect' });
        expect(mockStart).toHaveBeenCalledTimes(1);
        fireEvent.click(reconnect);
        await screen.findByTestId('pty-2');
        emit('ssh-pty-exit', { session_id: 'pty-1', reason: 'stale event' });
        expect(screen.getByTestId('pty-2')).toBeVisible();
        expect(mockStart).toHaveBeenCalledTimes(2);
    });

    test('connecting tab cannot launch twice and late completion after close is released', async () => {
        let resolve;
        mockStart.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
        render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        const connecting = await screen.findByRole('button', { name: 'Connecting…' });
        expect(connecting).toBeDisabled();
        fireEvent.click(connecting);
        expect(mockStart).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByText('SSH: Test').parentElement.querySelector('[title="Close terminal tab"]'));
        await act(async () => resolve('late-pty'));
        expect(mockInvoke).toHaveBeenCalledWith('ssh_close_pty', { sessionId: 'late-pty' });
        expect(screen.queryByTestId('late-pty')).not.toBeInTheDocument();
    });

    test('early output is replayed and an exit before the start response is not lost', async () => {
        let resolve;
        mockStart.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
        render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        await screen.findByRole('button', { name: 'Connecting…' });
        emit('ssh-pty-output', { session_id: 'pty-early', data: 'early text' });
        await act(async () => resolve('pty-early'));
        await screen.findByTestId('pty-early');
        expect(mockWrite).toHaveBeenCalledWith('early text');
        emit('ssh-pty-exit', { session_id: 'pty-early', reason: 'closed' });
        mockStart.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
        fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
        await screen.findByRole('button', { name: 'Connecting…' });
        emit('ssh-pty-exit', { session_id: 'pty-fast', reason: 'early exit' });
        await act(async () => resolve('pty-fast'));
        expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeEnabled();
        expect(screen.queryByTestId('pty-fast')).not.toBeInTheDocument();
    });

    test('failed startup is not retried automatically and can be retried explicitly', async () => {
        mockStart.mockRejectedValueOnce(new Error('authentication failed')).mockResolvedValueOnce('pty-retry');
        render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        const reconnect = await screen.findByRole('button', { name: 'Reconnect' });
        expect(mockStart).toHaveBeenCalledTimes(1);
        fireEvent.click(reconnect);
        await screen.findByTestId('pty-retry');
        expect(mockStart).toHaveBeenCalledTimes(2);
    });
});
