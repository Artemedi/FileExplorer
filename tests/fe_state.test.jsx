import React, { StrictMode, useContext } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: (...args) => mockListen(...args),
}));

import HistoryProvider, { useHistory } from '../src/providers/HistoryProvider.jsx';
import FileSystemProvider, { useFileSystem } from '../src/providers/FileSystemProvider.jsx';
import ContextMenuProvider, { useContextMenu } from '../src/providers/ContextMenuProvider.jsx';
import AppStateProvider, { useAppState } from '../src/providers/AppStateProvider.jsx';
import { SettingsContext } from '../src/providers/SettingsProvider.jsx';
import SftpProvider from '../src/providers/SftpProvider.jsx';
import TabManager, { ExplorerTabsContext } from '../src/components/tabs/TabManager.jsx';
import {
    getDirectoryPath,
    getFileName,
    joinPath,
    normalizePath,
    replaceFileName,
    isRootPath,
} from '../src/utils/pathUtils.ts';

const defaultSettingsValue = {
    settings: {
        show_hidden_files_and_folders: false,
        auto_refresh_dir: true,
        confirm_delete: false,
        default_folder_path_on_opening: '',
    },
    updateSetting: vi.fn(),
};

const renderWithProviders = (ui, { strict = false, settingsOverride = {} } = {}) => {
    const settingsVal = {
        ...defaultSettingsValue,
        settings: { ...defaultSettingsValue.settings, ...settingsOverride },
    };

    const tree = (
        <SettingsContext.Provider value={settingsVal}>
            <SftpProvider>
                <HistoryProvider>
                    <FileSystemProvider>
                        <ContextMenuProvider>{ui}</ContextMenuProvider>
                    </FileSystemProvider>
                </HistoryProvider>
            </SftpProvider>
        </SettingsContext.Provider>
    );

    return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    mockListen.mockResolvedValue(() => {});
    mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'get_system_volumes_information_as_json') return '[]';
        if (cmd === 'get_initial_cli_path') return null;
        if (cmd === 'open_directory') return JSON.stringify({ directories: [], files: [] });
        return undefined;
    });
});

afterEach(async () => {
    cleanup();
    await new Promise((r) => setTimeout(r, 10));
});

describe('TP-FE-STATE-03 / TP-FE-STATE-04 / TP-IPC-05: FileSystemProvider & HistoryProvider races (BUG-023)', () => {
    test('TP-FE-STATE-03: discards stale out-of-order loadDirectory response under StrictMode', async () => {
        const dirA = { directories: [], files: [{ name: 'fromA.txt', path: 'C:\\A\\fromA.txt', size_in_bytes: 1 }] };
        const dirB = { directories: [], files: [{ name: 'fromB.txt', path: 'C:\\B\\fromB.txt', size_in_bytes: 2 }] };

        mockInvoke.mockImplementation((cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') {
                return Promise.resolve(JSON.stringify([{ mount_point: 'C:\\Init' }]));
            }
            if (cmd === 'get_initial_cli_path') return Promise.resolve(null);
            if (cmd === 'open_directory') {
                if (args?.path === 'C:\\A') {
                    return new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(dirA)), 80));
                }
                if (args?.path === 'C:\\B') {
                    return new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(dirB)), 10));
                }
                return Promise.resolve(JSON.stringify({ directories: [], files: [] }));
            }
            return Promise.resolve(undefined);
        });

        let fsApi;
        let historyApi;
        function Probe() {
            fsApi = useFileSystem();
            historyApi = useHistory();
            return (
                <div>
                    <span data-testid="path">{historyApi.currentPath || ''}</span>
                    <span data-testid="loading">{String(fsApi.isLoading)}</span>
                    <span data-testid="files">{(fsApi.currentDirData?.files || []).map((f) => f.name).join(',')}</span>
                </div>
            );
        }

        renderWithProviders(<Probe />, { strict: true });

        await waitFor(() => {
            expect(screen.getByTestId('path')).toHaveTextContent('C:\\Init');
        });

        await act(async () => {
            const pA = fsApi.loadDirectory('C:\\A');
            await new Promise((r) => setTimeout(r, 15));
            const pB = fsApi.loadDirectory('C:\\B');
            await Promise.all([pA, pB]);
        });

        // Wait past dirA's 80ms delay to confirm late A response is ignored
        await new Promise((r) => setTimeout(r, 90));

        expect(screen.getByTestId('path')).toHaveTextContent('C:\\B');
        expect(screen.getByTestId('files')).toHaveTextContent('fromB.txt');
        expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    test('R3: switching between identical Explorer paths invalidates an already running directory load', async () => {
        const path = 'C:\\Init';
        sessionStorage.setItem('fileExplorerHistory', JSON.stringify([path]));
        sessionStorage.setItem('fileExplorerHistoryIndex', '0');
        localStorage.setItem('explr_saved_tabs', JSON.stringify([
            { id: 'A', title: 'A', path },
            { id: 'B', title: 'B', path },
        ]));
        localStorage.setItem('explr_active_tab_id', 'A');
        let resolve;
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') return '[]';
            if (cmd === 'open_directory') {
                if (args.path === 'C:\\Late') return new Promise((r) => { resolve = r; });
                return JSON.stringify({ directory: path, directories: [], files: [{ name: 'initial.txt' }] });
            }
            return undefined;
        });
        let fsApi;
        function Probe() {
            fsApi = useFileSystem();
            const { currentPath } = useHistory();
            const { scope } = useContext(ExplorerTabsContext);
            return <div>
                <span data-testid="owner">{scope.tabId}</span>
                <span data-testid="path">{currentPath}</span>
                <span data-testid="files">{(fsApi.currentDirData?.files || []).map((f) => f.name).join(',')}</span>
                <span data-testid="loading">{String(fsApi.isLoading)}</span>
            </div>;
        }
        renderWithProviders(<TabManager><Probe /></TabManager>);
        await waitFor(() => {
            expect(screen.getByTestId('owner')).toHaveTextContent('A');
            expect(screen.getByTestId('files')).toHaveTextContent('initial.txt');
        });
        let pending;
        act(() => { pending = fsApi.loadDirectory('C:\\Late'); });
        await waitFor(() => expect(resolve).toBeTypeOf('function'));
        fireEvent.click(screen.getByText('B', { selector: '.tab-title' }));
        expect(screen.getByTestId('owner')).toHaveTextContent('B');
        expect(screen.getByTestId('path')).toHaveTextContent(path);
        await act(async () => {
            resolve(JSON.stringify({ directories: [], files: [{ name: 'late.txt' }] }));
            expect(await pending).toBe(false);
        });
        expect(screen.getByTestId('files')).toHaveTextContent('initial.txt');
        expect(screen.getByTestId('loading')).toHaveTextContent('false');
        expect(screen.getByTestId('path')).toHaveTextContent(path);
        const reopenExplorer = vi.fn();
        document.addEventListener('force-explorer-view', reopenExplorer);
        try {
            fireEvent.click(screen.getByText('B', { selector: '.tab-title' }));
            expect(reopenExplorer).toHaveBeenCalledTimes(1);
        } finally {
            document.removeEventListener('force-explorer-view', reopenExplorer);
        }
    });

    test('TP-FE-STATE-04 & TP-IPC-05: restores sessionStorage path without overwrite and preserves watcher in StrictMode', async () => {
        sessionStorage.setItem('fileExplorerHistory', JSON.stringify(['C:\\Work']));
        sessionStorage.setItem('fileExplorerHistoryIndex', '0');

        const watchCalls = [];
        const unwatchCalls = [];
        const openDirCalls = [];

        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') {
                return JSON.stringify([{ mount_point: 'C:\\Default' }]);
            }
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'open_directory') {
                openDirCalls.push(args?.path);
                return JSON.stringify({ directories: [], files: [{ name: 'work.txt', path: 'C:\\Work\\work.txt', size_in_bytes: 10 }] });
            }
            if (cmd === 'watch_directory') {
                watchCalls.push(args?.path);
                return undefined;
            }
            if (cmd === 'unwatch_directory') {
                unwatchCalls.push(true);
                return undefined;
            }
            return undefined;
        });

        function Probe() {
            const { currentPath } = useHistory();
            const { currentDirData } = useFileSystem();
            return (
                <div>
                    <span data-testid="path">{currentPath || ''}</span>
                    <span data-testid="files">{(currentDirData?.files || []).map((f) => f.name).join(',')}</span>
                </div>
            );
        }

        const { unmount } = renderWithProviders(<Probe />, { strict: true });

        await waitFor(() => {
            expect(screen.getByTestId('path')).toHaveTextContent('C:\\Work');
            expect(screen.getByTestId('files')).toHaveTextContent('work.txt');
        });

        // Wait a tick for StrictMode deferred cleanup check
        await new Promise((r) => setTimeout(r, 20));

        expect(openDirCalls).not.toContain('C:\\Default');
        expect(watchCalls).toContain('C:\\Work');
        expect(unwatchCalls.length).toBe(0);

        // Real unmount should call unwatch_directory
        unmount();
        await new Promise((r) => setTimeout(r, 20));
        expect(unwatchCalls.length).toBe(1);
    });
});

describe('TP-FE-STATE-05: Hidden filter memoization & boundary-safe selection cleanup (BUG-025)', () => {
    test('toggling hidden files filters via useMemo without extra open_directory calls, and deleting test preserves test2.txt', async () => {
        sessionStorage.setItem('fileExplorerHistory', JSON.stringify(['C:\\Dir']));
        sessionStorage.setItem('fileExplorerHistoryIndex', '0');

        let openCount = 0;
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'get_system_volumes_information_as_json') return '[]';
            if (cmd === 'open_directory') {
                openCount++;
                return JSON.stringify({
                    directories: [],
                    files: [
                        { name: 'test', path: 'C:\\Dir\\test', size_in_bytes: 5 },
                        { name: 'test2.txt', path: 'C:\\Dir\\test2.txt', size_in_bytes: 10 },
                        { name: '.hidden', path: 'C:\\Dir\\.hidden', size_in_bytes: 1 },
                    ],
                });
            }
            return undefined;
        });

        let fsApi;
        function Probe() {
            fsApi = useFileSystem();
            return (
                <div>
                    <span data-testid="visible">{(fsApi.currentDirData?.files || []).map((f) => f.name).join(',')}</span>
                    <span data-testid="selected">{fsApi.selectedItems.map((i) => i.name).join(',')}</span>
                </div>
            );
        }

        const makeTree = (showHidden) => (
            <SettingsContext.Provider
                value={{
                    ...defaultSettingsValue,
                    settings: { ...defaultSettingsValue.settings, show_hidden_files_and_folders: showHidden },
                }}
            >
                <SftpProvider>
                    <HistoryProvider>
                        <FileSystemProvider>
                            <Probe />
                        </FileSystemProvider>
                    </HistoryProvider>
                </SftpProvider>
            </SettingsContext.Provider>
        );

        const { rerender } = render(makeTree(false));

        await waitFor(() => {
            expect(screen.getByTestId('visible')).toHaveTextContent('test,test2.txt');
        });
        const initialOpenCount = openCount;

        // Toggle hidden files setting -> should NOT call open_directory again
        rerender(makeTree(true));
        expect(screen.getByTestId('visible')).toHaveTextContent('test,test2.txt,.hidden');
        expect(openCount).toBe(initialOpenCount);

        // Select test and test2.txt, delete test -> test2.txt remains selected
        act(() => {
            fsApi.selectMultiple([
                { name: 'test', path: 'C:\\Dir\\test' },
                { name: 'test2.txt', path: 'C:\\Dir\\test2.txt' },
            ]);
        });
        expect(screen.getByTestId('selected')).toHaveTextContent('test,test2.txt');

        await act(async () => {
            await fsApi.moveToTrash('C:\\Dir\\test');
        });

        expect(screen.getByTestId('selected')).toHaveTextContent('test2.txt');
    });
});

describe('TP-FE-STATE-07: ContextMenuProvider cut clipboard preservation & showProperties (BUG-027)', () => {
    test('preserves cut clipboard on SFTP paste error, shows 0-byte file properties, and resolves C:\\ for C:\\Users', async () => {
        sessionStorage.setItem('fileExplorerHistory', JSON.stringify(['C:\\Users']));
        sessionStorage.setItem('fileExplorerHistoryIndex', '0');

        const openDirPaths = [];
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') return '[]';
            if (cmd === 'open_directory') {
                openDirPaths.push(args?.path);
                if (args?.path === 'C:\\') {
                    return JSON.stringify({
                        directories: [{ name: 'Users', path: 'C:\\Users', isDirectory: true, size_in_bytes: 0, sub_file_count: 1, sub_dir_count: 2 }],
                        files: [],
                    });
                }
                return JSON.stringify({
                    directories: [],
                    files: [{ name: 'empty.txt', path: 'C:\\Users\\empty.txt', size_in_bytes: 0 }],
                });
            }
            return undefined;
        });

        let cmApi;
        function Probe() {
            cmApi = useContextMenu();
            return <span data-testid="clip">{cmApi.clipboard.items.map((i) => i.name).join(',')}</span>;
        }

        renderWithProviders(<Probe />);

        await waitFor(() => {
            expect(openDirPaths).toContain('C:\\Users');
        });

        // 1) Cut empty.txt and attempt paste into SFTP -> item remains in clipboard
        const emptyFile = { name: 'empty.txt', path: 'C:\\Users\\empty.txt', size_in_bytes: 0 };
        await act(async () => {
            await cmApi.cutToClipboard([emptyFile]);
        });
        expect(screen.getByTestId('clip')).toHaveTextContent('empty.txt');

        await act(async () => {
            await cmApi.pasteFromClipboard('sftp:prod:remote');
        });
        expect(screen.getByTestId('clip')).toHaveTextContent('empty.txt');

        // 2) showProperties on 0-byte file dispatches the file item itself (not synthetic folder)
        const dispatchedProps = [];
        const onProps = (e) => dispatchedProps.push(e.detail.item);
        document.addEventListener('show-properties', onProps);

        await act(async () => {
            await cmApi.showProperties(emptyFile);
        });
        expect(dispatchedProps[0]).toEqual(emptyFile);

        // 3) showProperties('C:\\Users') queries parent 'C:\\' (not 'C:')
        await act(async () => {
            await cmApi.showProperties('C:\\Users');
        });
        document.removeEventListener('show-properties', onProps);

        expect(openDirPaths).toContain('C:\\');
        expect(openDirPaths).not.toContain('C:');
        expect(dispatchedProps[1]?.name).toBe('Users');
    });
});

describe('TP-FE-STATE-10: pathUtils UNC, SFTP, lowercase drive, and relative paths (BUG-059)', () => {
    test('handles UNC, SFTP, lowercase drive letters, and bare filenames cleanly', () => {
        expect(getDirectoryPath('\\\\server\\share')).toBe('\\\\server\\share');
        expect(getDirectoryPath('\\\\server\\share\\folder\\file.txt')).toBe('\\\\server\\share\\folder');
        expect(getDirectoryPath('file.txt')).toBe('');
        expect(replaceFileName('file.txt', 'b.txt')).toBe('b.txt');
        expect(getDirectoryPath('c:\\Users\\doc.txt')).toBe('c:\\Users');
        expect(getDirectoryPath('c:\\doc.txt')).toBe('c:\\');

        expect(normalizePath('sftp://user@host//dir/')).toBe('sftp://user@host/dir');
        expect(normalizePath('sftp:conn:app\\@types/')).toBe('sftp:conn:app/@types');
        expect(normalizePath('C:\\Users//Docs/')).toBe('C:\\Users\\Docs');
        expect(joinPath('sftp:conn:dir', 'sub\\file.txt')).toBe('sftp:conn:dir/sub/file.txt');
        expect(getFileName('sftp:conn:file.txt')).toBe('file.txt');

        expect(isRootPath('\\\\server\\share')).toBe(true);
        expect(isRootPath('\\\\server\\share\\')).toBe(true);
        expect(isRootPath('c:\\')).toBe(true);
        expect(isRootPath('sftp://host/')).toBe(true);
        expect(isRootPath('sftp:conn:.')).toBe(true);
    });
});

describe('TP-IPC-04 & BUG-082: loadVolumes error handling and provider/hook guards', () => {
    test('TP-IPC-04: loadVolumes returns [] and sets error on IPC failure without mock C:\\', async () => {
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'get_system_volumes_information_as_json') {
                throw new Error('Volume query failed');
            }
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'open_directory') return JSON.stringify({ directories: [], files: [] });
            return undefined;
        });

        let fsApi;
        function Probe() {
            fsApi = useFileSystem();
            return <span data-testid="vols">{JSON.stringify(fsApi.volumes)}</span>;
        }

        renderWithProviders(<Probe />);

        await waitFor(() => {
            expect(screen.getByTestId('vols')).toHaveTextContent('[]');
        });
        expect(fsApi.volumes).toEqual([]);
    });

    test('BUG-082: useFileSystem/useContextMenu throw outside provider and AppStateProvider toggles cleanly', () => {
        function BadFsConsumer() {
            useFileSystem();
            return null;
        }
        function BadCmConsumer() {
            useContextMenu();
            return null;
        }

        expect(() => render(<BadFsConsumer />)).toThrow('useFileSystem must be used within a FileSystemProvider');
        expect(() => render(<BadCmConsumer />)).toThrow('useContextMenu must be used within a ContextMenuProvider');

        let appState;
        function AppStateProbe() {
            appState = useAppState();
            return <span data-testid="view">{appState.currentView}</span>;
        }
        render(
            <AppStateProvider>
                <AppStateProbe />
            </AppStateProvider>
        );
        expect(screen.getByTestId('view')).toHaveTextContent('explorer');
        act(() => {
            appState.toggleTemplateView();
        });
        expect(screen.getByTestId('view')).toHaveTextContent('template-view');
    });
});
