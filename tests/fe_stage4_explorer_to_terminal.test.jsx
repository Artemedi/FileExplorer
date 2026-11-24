import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { mockInvoke, mockListen } = vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockListen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: mockListen,
}));

vi.mock('../src/utils/NotificationSystem', () => ({
    showError: vi.fn(),
    showConfirm: vi.fn().mockResolvedValue(true),
    showSuccess: vi.fn(),
    showPasswordPrompt: vi.fn().mockResolvedValue(null),
}));

import SettingsPanel from '../src/components/settings/SettingsPanel';
import Terminal from '../src/components/terminal/Terminal';
import { SettingsContext } from '../src/providers/SettingsProvider';
import { HistoryContext } from '../src/providers/HistoryProvider';
import { FileSystemContext } from '../src/providers/FileSystemProvider';
import SftpProvider from '../src/providers/SftpProvider';
import { ThemeContext } from '../src/providers/ThemeProvider';

afterEach(() => {
    cleanup();
});

describe('SettingsPanel explorer-to-terminal sync option', () => {
    test('renders and toggles terminal_sync_explorer_to_terminal', () => {
        mockInvoke.mockResolvedValue(false);
        const updateSetting = vi.fn();
        render(
            <ThemeContext.Provider value={{ theme: 'light', setTheme: vi.fn() }}>
                <SettingsContext.Provider
                    value={{
                        settings: {
                            theme: 'light',
                            default_view: 'grid',
                            font_size: 'Medium',
                            accent_color: '#0672ef',
                            terminal_height: 240,
                            terminal_sync_explorer_to_terminal: false,
                        },
                        updateSetting,
                        resetSettings: vi.fn(),
                        isLoading: false,
                    }}
                >
                    <SettingsPanel isOpen={true} onClose={vi.fn()} />
                </SettingsContext.Provider>
            </ThemeContext.Provider>
        );

        fireEvent.click(screen.getByText('settings.advanced'));
        const checkbox = screen.getByLabelText('Sync explorer navigation to SSH terminal (cd)');
        expect(checkbox).not.toBeChecked();
        fireEvent.click(checkbox);
        expect(updateSetting).toHaveBeenCalledWith('terminal_sync_explorer_to_terminal', true);
    });
});

describe('Terminal explorer-to-terminal cd synchronization', () => {
    let listeners;

    beforeEach(() => {
        localStorage.clear();
        mockInvoke.mockReset();
        mockListen.mockReset();
        listeners = {};
        mockListen.mockImplementation(async (eventName, cb) => {
            listeners[eventName] = cb;
            return () => {};
        });
        localStorage.setItem(
            'fileExplorerSftpConnections',
            JSON.stringify([{ name: 'SevasTest', host: '10.92.239.23', port: 22, username: 'vitakor' }])
        );
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'ssh_start_pty') return 'pty-1';
            if (cmd === 'ssh_execute_command') return JSON.stringify({ stdout: '/home/vitakor', stderr: '', exit_code: 0 });
            if (cmd === 'ssh_write_pty') return null;
            return null;
        });
    });

    function renderTerminalTree(currentPath, syncEnabled) {
        return render(
            <SettingsContext.Provider
                value={{
                    settings: {
                        terminal_height: 240,
                        terminal_sync_explorer_to_terminal: syncEnabled,
                    },
                    updateSetting: vi.fn(),
                }}
            >
                <SftpProvider>
                    <HistoryContext.Provider value={{ currentPath, navigateTo: vi.fn() }}>
                        <FileSystemContext.Provider value={{ loadDirectory: vi.fn().mockResolvedValue(true) }}>
                            <Terminal isOpen={true} onToggle={vi.fn()} />
                        </FileSystemContext.Provider>
                    </HistoryContext.Provider>
                </SftpProvider>
            </SettingsContext.Provider>
        );
    }

    test('writes escaped cd command only when enabled and shell is idle, and skips when busy', async () => {
        const { rerender } = renderTerminalTree('sftp:SevasTest:/home/vitakor', true);

        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('ssh_start_pty', expect.any(Object));
            expect(listeners['ssh-pty-output']).toBeTypeOf('function');
        });

        // Mark shell hook installed & idle at /home/vitakor
        act(() => {
            listeners['ssh-pty-output']({
                payload: {
                    session_id: 'pty-1',
                    data: '\x1b]7;file://db/home/vitakor\x07\x1b]133;A\x07',
                },
            });
        });

        mockInvoke.mockClear();

        // Navigate explorer to path with space & single quote -> should send cd
        rerender(
            <SettingsContext.Provider
                value={{
                    settings: {
                        terminal_height: 240,
                        terminal_sync_explorer_to_terminal: true,
                    },
                    updateSetting: vi.fn(),
                }}
            >
                <SftpProvider>
                    <HistoryContext.Provider value={{ currentPath: "sftp:SevasTest:/var/my dir/it's", navigateTo: vi.fn() }}>
                        <FileSystemContext.Provider value={{ loadDirectory: vi.fn().mockResolvedValue(true) }}>
                            <Terminal isOpen={true} onToggle={vi.fn()} />
                        </FileSystemContext.Provider>
                    </HistoryContext.Provider>
                </SftpProvider>
            </SettingsContext.Provider>
        );

        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('ssh_write_pty', {
                sessionId: 'pty-1',
                data: " cd -- '/var/my dir/it'\\''s'\n",
            });
        });

        // Mark shell busy (e.g. running mc / vim) -> explorer navigation must NOT write cd
        act(() => {
            listeners['ssh-pty-output']({
                payload: {
                    session_id: 'pty-1',
                    data: '\x1b]133;C\x07',
                },
            });
        });
        mockInvoke.mockClear();

        rerender(
            <SettingsContext.Provider
                value={{
                    settings: {
                        terminal_height: 240,
                        terminal_sync_explorer_to_terminal: true,
                    },
                    updateSetting: vi.fn(),
                }}
            >
                <SftpProvider>
                    <HistoryContext.Provider value={{ currentPath: 'sftp:SevasTest:/etc', navigateTo: vi.fn() }}>
                        <FileSystemContext.Provider value={{ loadDirectory: vi.fn().mockResolvedValue(true) }}>
                            <Terminal isOpen={true} onToggle={vi.fn()} />
                        </FileSystemContext.Provider>
                    </HistoryContext.Provider>
                </SftpProvider>
            </SettingsContext.Provider>
        );

        expect(mockInvoke).not.toHaveBeenCalledWith('ssh_write_pty', expect.anything());
    });
});
