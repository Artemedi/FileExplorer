import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { mockInvoke, mockListen, mockStart, mockWrite, mockNavigation } = vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockListen: vi.fn(),
    mockStart: vi.fn(),
    mockWrite: vi.fn(),
    mockNavigation: { path: "sftp:Test:/test", load: vi.fn(), navigate: vi.fn(), execute: vi.fn() },
}));
const connection = { name: 'Test', host: 'test.invalid', username: 'test', port: 22 };

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mockListen }));
vi.mock('../src/providers/HistoryProvider', () => ({
    useHistory: () => ({ currentPath: mockNavigation.path, navigateTo: mockNavigation.navigate }),
}));
vi.mock('../src/providers/FileSystemProvider', () => ({
    useFileSystem: () => ({ loadDirectory: mockNavigation.load }),
}));
vi.mock('../src/providers/SettingsProvider', () => ({
    useSettings: () => ({ settings: { terminal_height: 240, terminal_sync_explorer_to_terminal: true } }),
}));
vi.mock('../src/providers/SftpProvider', () => ({
    useSftp: () => ({
        isSftpPath: (path) => path?.startsWith('sftp:'),
        parseSftpPath: (path) => {
            const [, name, remotePath] = path.split(':');
            return { connection: { ...connection, name }, remotePath };
        },
        createSftpUrl: (conn, dir) => 'sftp:' + conn.name + ':' + dir,
        executeSshCommand: mockNavigation.execute,
        startSshPty: mockStart,
    }),
}));
vi.mock('../src/components/terminal/XtermSshView', () => ({
    default: ({ sessionId, isVisible, registerController, onData }) => {
        React.useEffect(() => {
            registerController(sessionId, { write: (data) => mockWrite(data, sessionId), getBufferText: () => '' });
            return () => registerController(sessionId, null);
        }, [sessionId]);
        return <div data-testid={sessionId} style={{ display: isVisible ? undefined : "none" }}><button onClick={() => onData("test input")}>Send input</button></div>;
    },
}));

import Terminal from '../src/components/terminal/Terminal';
import { ExplorerTabsContext } from '../src/components/tabs/TabManager';

describe('TERM-R1 PTY lifecycle', () => {
    let listeners;
    const emit = (event, payload) => act(() => listeners[event]({ payload }));

    beforeEach(() => {
        vi.clearAllMocks();
        listeners = {};
        mockInvoke.mockResolvedValue(null);
        mockStart.mockReset().mockResolvedValue('pty-1');
        mockNavigation.path = 'sftp:Test:/test';
        mockNavigation.load.mockReset().mockResolvedValue(true);
        mockNavigation.navigate.mockReset();
        mockNavigation.execute.mockReset().mockResolvedValue({ exit_code: 0, stdout: '/test' });
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
        expect(mockWrite).toHaveBeenCalledWith('early text', 'pty-early');
        emit('ssh-pty-exit', { session_id: 'pty-early', reason: 'closed' });
        mockStart.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
        fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
        await screen.findByRole('button', { name: 'Connecting…' });
        emit('ssh-pty-exit', { session_id: 'pty-fast', reason: 'early exit' });
        await act(async () => resolve('pty-fast'));
        expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeEnabled();
        expect(screen.queryByTestId('pty-fast')).not.toBeInTheDocument();
    });

    test('rejected input is visible, pauses subsequent input and is never replayed', async () => {
        mockInvoke.mockImplementation(async (command, args) => {
            if (command === 'ssh_write_pty' && args.data === 'test input') {
                throw new Error('queue full');
            }
            return null;
        });
        render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        const send = await screen.findByRole('button', { name: 'Send input' });
        fireEvent.click(send);
        expect(await screen.findByRole('alert')).toHaveTextContent('queue full');
        fireEvent.click(send);
        expect(mockInvoke.mock.calls.filter(([cmd, args]) =>
            cmd === 'ssh_write_pty' && args.data === 'test input')).toHaveLength(1);
        mockInvoke.mockResolvedValue(null);
        fireEvent.click(screen.getByRole('button', { name: 'Resume input' }));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(mockInvoke.mock.calls.filter(([cmd, args]) =>
            cmd === 'ssh_write_pty' && args.data === 'test input')).toHaveLength(1);
        fireEvent.click(send);
        await waitFor(() => expect(mockInvoke.mock.calls.filter(([cmd, args]) =>
            cmd === 'ssh_write_pty' && args.data === 'test input')).toHaveLength(2));
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

    test('R2: duplicate same profile and confirmed cwd creates three isolated PTYs', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2').mockResolvedValueOnce('pty-3');
        render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        const original = await screen.findByTestId('pty-1');
        emit('ssh-pty-output', { session_id: 'pty-1', data: '\x1b]7;file://db/test\x07\x1b]133;C\x07' });
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate SSH' }));
        const second = await screen.findByTestId('pty-2');
        expect(second).toBeVisible();
        expect(original).not.toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate SSH' }));
        const third = await screen.findByTestId('pty-3');
        expect(third).toBeVisible();
        expect(second).not.toBeVisible();
        expect(mockStart).toHaveBeenCalledTimes(3);
        expect(mockStart.mock.calls.map((args) => args[1])).toEqual(['/test', '/test', '/test']);
        expect(mockInvoke).not.toHaveBeenCalledWith('ssh_close_pty', expect.anything());
        for (const id of ['pty-1', 'pty-2', 'pty-3']) {
            emit('ssh-pty-output', { session_id: id, data: 'output:' + id });
            expect(mockWrite).toHaveBeenCalledWith('output:' + id, id);
        }
        fireEvent.click(screen.getByRole('button', { name: 'Send input' }));
        expect(mockInvoke).toHaveBeenCalledWith('ssh_write_pty', { sessionId: 'pty-3', data: 'test input' });
        fireEvent.click(screen.getByText('SSH: Test'));
        expect(original).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Send input' }));
        expect(mockInvoke).toHaveBeenCalledWith('ssh_write_pty', { sessionId: 'pty-1', data: 'test input' });
        fireEvent.click(screen.getByText('SSH: Test #2').parentElement.querySelector('[title="Close terminal tab"]'));
        expect(mockInvoke).toHaveBeenCalledWith('ssh_close_pty', { sessionId: 'pty-2' });
        expect(mockInvoke).not.toHaveBeenCalledWith('ssh_close_pty', { sessionId: 'pty-1' });
        expect(mockInvoke).not.toHaveBeenCalledWith('ssh_close_pty', { sessionId: 'pty-3' });
        expect(screen.getByTestId('pty-1')).toBe(original);
        expect(screen.getByTestId('pty-3')).toBe(third);
    });

    test('R2: confirmed directory belongs to its shell; independent shell never drives explorer', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2').mockResolvedValueOnce('pty-3');
        const { rerender } = render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        await screen.findByTestId('pty-1');
        emit('ssh-pty-output', { session_id: 'pty-1', data: '\x1b]7;file://db/confirmed\x07' });
        await waitFor(() => expect(mockNavigation.load).toHaveBeenCalledWith('sftp:Test:/confirmed', expect.objectContaining({ isCurrent: expect.any(Function) })));
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate SSH' }));
        await screen.findByTestId('pty-2');
        expect(mockStart.mock.calls[1][1]).toBe('/confirmed');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        mockNavigation.load.mockClear();
        mockNavigation.navigate.mockClear();
        mockInvoke.mockClear();
        emit('ssh-pty-output', { session_id: 'pty-2', data: '\x1b]7;file://db/independent\x07\x1b]133;A\x07' });
        emit('ssh-pty-output', { session_id: 'pty-1', data: '\x1b]7;file://db/background\x07\x1b]133;A\x07' });
        expect(mockNavigation.load).not.toHaveBeenCalled();
        expect(mockNavigation.navigate).not.toHaveBeenCalled();
        mockNavigation.path = 'sftp:Test:/elsewhere';
        rerender(<Terminal isOpen={true} onToggle={vi.fn()} />);
        expect(screen.getByTestId('pty-2')).toBeVisible();
        expect(mockInvoke.mock.calls.filter(([cmd, args]) =>
            cmd === 'ssh_write_pty' && args.data?.startsWith(' cd -- '))).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate SSH' }));
        await screen.findByTestId('pty-3');
        expect(mockStart.mock.calls[2][1]).toBe('/independent');
    });

    test('R2: repeated explicit SSH opens create independent sessions even in one render', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2').mockResolvedValueOnce('pty-3');
        render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        await screen.findByTestId('pty-1');
        act(() => {
            window.dispatchEvent(new CustomEvent('open-ssh-terminal', { detail: { connection } }));
            window.dispatchEvent(new CustomEvent('open-ssh-terminal', { detail: { connection } }));
        });
        expect(await screen.findByTestId('pty-2')).not.toBeVisible();
        expect(await screen.findByTestId('pty-3')).toBeVisible();
        expect(mockStart).toHaveBeenCalledTimes(3);
        expect(mockStart.mock.calls.map((args) => args[1])).toEqual(['/test', '.', '.']);
    });

    test('R2: exit and reconnect one independent tab leaves other PTYs alive', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2').mockResolvedValueOnce('pty-3');
        render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        const original = await screen.findByTestId('pty-1');
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate SSH' }));
        await screen.findByTestId('pty-2');
        emit('ssh-pty-exit', { session_id: 'pty-2', reason: 'transport lost' });
        fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
        expect(await screen.findByTestId('pty-3')).toBeVisible();
        expect(screen.getByText('SSH: Test #2')).toBeInTheDocument();
        emit('ssh-pty-output', { session_id: 'pty-2', data: 'stale output' });
        emit('ssh-pty-exit', { session_id: 'pty-2', reason: 'stale exit' });
        expect(mockWrite).not.toHaveBeenCalledWith('stale output', expect.anything());
        expect(screen.getByTestId('pty-1')).toBe(original);
        expect(screen.getByTestId('pty-3')).toBeVisible();
        expect(mockInvoke).not.toHaveBeenCalledWith('ssh_close_pty', { sessionId: 'pty-1' });
    });

    test('R2: reopening an explorer terminal after closing it does not reuse its logical ID', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2');
        const { rerender } = render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        await screen.findByTestId('pty-1');
        fireEvent.click(screen.getByText('SSH: Test').parentElement.querySelector('[title="Close terminal tab"]'));
        mockNavigation.path = 'sftp:Test:/new';
        rerender(<Terminal isOpen={true} onToggle={vi.fn()} />);
        expect(await screen.findByTestId('pty-2')).toBeVisible();
        expect(mockStart.mock.calls[1][1]).toBe('/new');
        emit('ssh-pty-exit', { session_id: 'pty-1', reason: 'stale exit' });
        expect(screen.getByTestId('pty-2')).toBeVisible();
    });

    test('R2: different saved profiles at the same endpoint have different linked shells', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2');
        const { rerender } = render(<Terminal isOpen={true} onToggle={vi.fn()} />);
        const original = await screen.findByTestId('pty-1');
        mockNavigation.path = 'sftp:Other:/test';
        rerender(<Terminal isOpen={true} onToggle={vi.fn()} />);
        expect(await screen.findByTestId('pty-2')).toBeVisible();
        expect(original).not.toBeVisible();
        expect(mockStart.mock.calls.map(([conn]) => conn.name)).toEqual(['Test', 'Other']);
        mockNavigation.path = 'sftp:Test:/test';
        rerender(<Terminal isOpen={true} onToggle={vi.fn()} />);
        expect(original).toBeVisible();
        expect(mockStart).toHaveBeenCalledTimes(2);
    });

    test('R3: same path in two Explorer tabs selects independent linked PTYs; closing one unlinks it', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2');
        let scope = { tabId: 'A', revision: 1, switching: false };
        let tabs = [{ id: 'A', path: mockNavigation.path }, { id: 'B', path: mockNavigation.path }];
        const tree = () => (
            <ExplorerTabsContext.Provider value={{ scope, getScope: () => scope, tabs }}>
                <Terminal isOpen={true} onToggle={vi.fn()} />
            </ExplorerTabsContext.Provider>
        );
        const { rerender } = render(tree());
        const first = await screen.findByTestId('pty-1');
        scope = { tabId: 'B', revision: 2, switching: false };
        rerender(tree());
        const second = await screen.findByTestId('pty-2');
        expect(second).toBeVisible();
        expect(first).not.toBeVisible();
        expect(mockStart.mock.calls.map((args) => args[1])).toEqual(['/test', '/test']);
        emit('ssh-pty-output', { session_id: 'pty-1', data: '\x1b]7;file://db/background\x07' });
        expect(mockNavigation.load).not.toHaveBeenCalled();
        tabs = tabs.filter((tab) => tab.id !== 'A');
        rerender(tree());
        expect(mockInvoke).not.toHaveBeenCalledWith('ssh_close_pty', { sessionId: 'pty-1' });
        expect(screen.getByTestId('pty-1')).toBe(first);
        expect(screen.getByTestId('pty-2')).toBe(second);
        fireEvent.click(screen.getByText('SSH: Test #1'));
        expect(first).toBeVisible();
        expect(screen.getByRole('button', { name: 'Refresh CWD' })).toBeVisible();
        emit('ssh-pty-output', { session_id: 'pty-1', data: '\x1b]7;file://db/unlinked\x07' });
        expect(mockNavigation.load).not.toHaveBeenCalled();
    });

    test('R3.1: late non-PTY cd cannot navigate after A to B to A', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2');
        let scope = { tabId: 'A', revision: 1, switching: false };
        const tabs = [{ id: 'A', path: mockNavigation.path }, { id: 'B', path: mockNavigation.path }];
        let resolve;
        mockNavigation.execute.mockImplementation((conn, command) => {
            if (command.includes('cd ')) return new Promise((r) => { resolve = r; });
            return Promise.resolve({ exit_code: 0, stdout: '/test' });
        });
        const tree = () => (
            <ExplorerTabsContext.Provider value={{ scope, getScope: () => scope, tabs }}>
                <Terminal isOpen={true} onToggle={vi.fn()} />
            </ExplorerTabsContext.Provider>
        );
        const { rerender } = render(tree());
        await screen.findByTestId('pty-1');
        fireEvent.click(screen.getByRole('button', { name: 'Stop PTY' }));
        const input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: 'cd /late' } });
        fireEvent.submit(input.closest('form'));
        await waitFor(() => expect(resolve).toBeTypeOf('function'));
        scope = { tabId: 'B', revision: 2, switching: false };
        rerender(tree());
        await screen.findByTestId('pty-2');
        scope = { tabId: 'A', revision: 3, switching: false };
        rerender(tree());
        await act(async () => resolve({ exit_code: 0, stdout: '/late' }));
        expect(mockNavigation.load).not.toHaveBeenCalled();
        expect(screen.getByText('[SSH] Directory: /late')).toBeInTheDocument();
    });

    test('R3: A to B to A rejects late navigation even when the path and owner match again', async () => {
        mockStart.mockResolvedValueOnce('pty-1').mockResolvedValueOnce('pty-2');
        let scope = { tabId: 'A', revision: 1, switching: false };
        const tabs = [{ id: 'A', path: mockNavigation.path }, { id: 'B', path: mockNavigation.path }];
        let resolve;
        mockNavigation.load.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
        const tree = () => (
            <ExplorerTabsContext.Provider value={{ scope, getScope: () => scope, tabs }}>
                <Terminal isOpen={true} onToggle={vi.fn()} />
            </ExplorerTabsContext.Provider>
        );
        const { rerender } = render(tree());
        const first = await screen.findByTestId('pty-1');
        emit('ssh-pty-output', { session_id: 'pty-1', data: '\x1b]7;file://db/old/child\x07' });
        await waitFor(() => expect(mockNavigation.load).toHaveBeenCalledTimes(1));
        const guard = mockNavigation.load.mock.calls[0][1].isCurrent;
        expect(guard()).toBe(true);
        scope = { tabId: 'B', revision: 2, switching: true };
        rerender(tree());
        expect(guard()).toBe(false);
        expect(mockStart).toHaveBeenCalledTimes(1);
        scope = { ...scope, switching: false };
        rerender(tree());
        await screen.findByTestId('pty-2');
        scope = { tabId: 'A', revision: 3, switching: false };
        rerender(tree());
        expect(first).toBeVisible();
        expect(guard()).toBe(false);
        await act(async () => resolve(false));
        expect(mockNavigation.load).toHaveBeenCalledTimes(1);
        expect(mockNavigation.navigate).not.toHaveBeenCalled();
    });
});
