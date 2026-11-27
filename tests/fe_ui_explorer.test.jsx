import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: (...args) => mockListen(...args),
}));

import I18nProvider from '../src/i18n/index.jsx';
import HistoryProvider, { useHistory } from '../src/providers/HistoryProvider.jsx';
import FileSystemProvider from '../src/providers/FileSystemProvider.jsx';
import ContextMenuProvider, { ContextMenuContext } from '../src/providers/ContextMenuProvider.jsx';
import { SettingsContext } from '../src/providers/SettingsProvider.jsx';
import SftpProvider, { useSftp } from '../src/providers/SftpProvider.jsx';
import FileList from '../src/components/explorer/FileList.jsx';
import DualPane from '../src/components/explorer/DualPane.jsx';
import TabManager from '../src/components/tabs/TabManager.jsx';

const defaultSettingsValue = {
    settings: {
        show_hidden_files_and_folders: true,
        auto_refresh_dir: false,
        confirm_delete: false,
        show_file_extensions: true,
        double_click: 'SelectFilesAndFolders',
        sort_by: 'Name',
        sort_direction: 'Ascending',
        default_folder_path_on_opening: '',
    },
    updateSetting: vi.fn(),
};

const renderWithProviders = (ui, { settingsOverride = {}, contextMenuOverride = null } = {}) => {
    const settingsVal = {
        ...defaultSettingsValue,
        settings: { ...defaultSettingsValue.settings, ...settingsOverride },
    };

    const inner = contextMenuOverride ? (
        <ContextMenuContext.Provider value={contextMenuOverride}>
            {ui}
        </ContextMenuContext.Provider>
    ) : (
        <ContextMenuProvider>{ui}</ContextMenuProvider>
    );

    return render(
        <I18nProvider>
            <SettingsContext.Provider value={settingsVal}>
                <SftpProvider>
                    <HistoryProvider>
                        <FileSystemProvider>{inner}</FileSystemProvider>
                    </HistoryProvider>
                </SftpProvider>
            </SettingsContext.Provider>
        </I18nProvider>
    );
};

const makeDirData = (dirPath, count = 10) => ({
    directories: [
        { name: 'FolderA', path: `${dirPath}\\FolderA`, sub_file_count: 2, last_modified: '2026-01-01 10:00:00' },
    ],
    files: Array.from({ length: count }, (_, idx) => ({
        name: `file${idx + 1}.txt`,
        path: `${dirPath}\\file${idx + 1}.txt`,
        size_in_bytes: (idx + 1) * 100,
        last_modified: `2026-01-${String(idx + 2).padStart(2, '0')} 12:00:00`,
    })),
});

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    mockListen.mockResolvedValue(() => {});
    mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'get_system_volumes_information_as_json') {
            return JSON.stringify([
                { mount_point: 'C:\\', volume_name: 'OS' },
                { mount_point: 'D:\\', volume_name: 'Data' },
                { mount_point: 'E:\\', volume_name: 'Extra' },
            ]);
        }
        if (cmd === 'get_initial_cli_path') return null;
        if (cmd === 'open_directory') return JSON.stringify({ directories: [], files: [] });
        return undefined;
    });
});

afterEach(() => {
    cleanup();
});

describe('TP-FE-UI-04: FileList selection, context menu, ARIA, and SFTP fields (BUG-064)', () => {
    test('supports single click, Shift+Click, Ctrl+Click, right-click preservation/reselection, and ARIA roles', () => {
        const data = makeDirData('C:\\Test', 6);
        const openContextMenu = vi.fn();
        const contextMenuOverride = {
            isOpen: false,
            position: { x: 0, y: 0 },
            target: null,
            items: [],
            clipboard: { operation: null, items: [] },
            isProcessing: false,
            openContextMenu,
            closeContextMenu: vi.fn(),
        };

        function Harness() {
            const [selected, setSelected] = React.useState([]);
            const [focused, setFocused] = React.useState(null);
            const handleSelect = (item, multi) => {
                setSelected((prev) => {
                    if (multi) {
                        const exists = prev.some((i) => i.path === item.path);
                        return exists ? prev.filter((i) => i.path !== item.path) : [...prev, item];
                    }
                    return [item];
                });
            };
            return (
                <div>
                    <span data-testid="selected-names">{selected.map((s) => s.name).join(',')}</span>
                    <FileList
                        data={data}
                        isLoading={false}
                        viewMode="details"
                        targetDirectory={"C:\\Test"}
                        selectedItems={selected}
                        onSelectItem={handleSelect}
                        onSelectMultiple={setSelected}
                        onClearSelection={() => setSelected([])}
                        onLoadDirectory={vi.fn()}
                        onOpenFile={vi.fn()}
                        focusedItem={focused}
                        onSetFocusedItem={setFocused}
                    />
                </div>
            );
        }

        renderWithProviders(<Harness />, { contextMenuOverride });

        const listbox = screen.getByRole('listbox');
        expect(listbox).toHaveAttribute('aria-multiselectable', 'true');
        const options = screen.getAllByRole('option');
        expect(options.length).toBe(7);

        // Single click on file1.txt (index 1, after FolderA)
        fireEvent.click(options[1]);
        expect(screen.getByTestId('selected-names')).toHaveTextContent('file1.txt');
        expect(options[1]).toHaveAttribute('aria-selected', 'true');

        // Shift+Click on file4.txt (index 4)
        fireEvent.click(options[4], { shiftKey: true });
        expect(screen.getByTestId('selected-names')).toHaveTextContent('file1.txt,file2.txt,file3.txt,file4.txt');

        // Ctrl+Click on file2.txt (deselect) and file6.txt (add)
        fireEvent.click(options[2], { ctrlKey: true });
        expect(screen.getByTestId('selected-names')).toHaveTextContent('file1.txt,file3.txt,file4.txt');
        fireEvent.click(options[6], { ctrlKey: true });
        expect(screen.getByTestId('selected-names')).toHaveTextContent('file1.txt,file3.txt,file4.txt,file6.txt');

        // Right-click inside selected group preserves group
        fireEvent.contextMenu(options[3]);
        expect(openContextMenu).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ name: 'file3.txt' }),
            expect.arrayContaining([
                expect.objectContaining({ name: 'file1.txt' }),
                expect.objectContaining({ name: 'file3.txt' }),
            ]),
            expect.objectContaining({ panePath: 'C:\\Test' })
        );

        // Right-click on unselected FolderA re-selects FolderA
        fireEvent.contextMenu(options[0]);
        expect(screen.getByTestId('selected-names')).toHaveTextContent('FolderA');
    });

    test('renders and sorts SFTP entries with size and modified fields without NaN', () => {
        const sftpData = {
            directories: [],
            files: [
                { name: 'b.txt', path: 'sftp:srv:b.txt', size: 2048, modified: '2026-02-01 10:00:00' },
                { name: 'a.txt', path: 'sftp:srv:a.txt', size: 512, modified: null },
            ],
        };

        renderWithProviders(
            <FileList
                data={sftpData}
                isLoading={false}
                viewMode="details"
                selectedItems={[]}
                onSelectItem={vi.fn()}
                onSelectMultiple={vi.fn()}
                onClearSelection={vi.fn()}
                onLoadDirectory={vi.fn()}
                onOpenFile={vi.fn()}
                focusedItem={null}
                onSetFocusedItem={vi.fn()}
            />
        );

        expect(screen.getByText('2 KB')).toBeInTheDocument();
        expect(screen.getByText('512 Bytes')).toBeInTheDocument();

        // Click Modified header to sort by date (should not produce NaN crashes)
        fireEvent.click(screen.getByText('Modified'));
        const options = screen.getAllByRole('option');
        expect(options.map((el) => el.dataset.path)).toEqual(['sftp:srv:a.txt', 'sftp:srv:b.txt']);
    });
});

describe('TP-FE-UI-05: SelectFilesAndFolders double-click mode (BUG-064)', () => {
    test('single click selects without opening; double click opens folder and file', () => {
        const data = makeDirData('C:\\Docs', 2);
        const onLoadDirectory = vi.fn();
        const onOpenFile = vi.fn();

        function Harness() {
            const [selected, setSelected] = React.useState([]);
            const [focused, setFocused] = React.useState(null);
            return (
                <FileList
                    data={data}
                    isLoading={false}
                    viewMode="list"
                    selectedItems={selected}
                    onSelectItem={vi.fn()}
                    onSelectMultiple={setSelected}
                    onClearSelection={() => setSelected([])}
                    onLoadDirectory={onLoadDirectory}
                    onOpenFile={onOpenFile}
                    focusedItem={focused}
                    onSetFocusedItem={setFocused}
                />
            );
        }

        renderWithProviders(<Harness />, {
            settingsOverride: { double_click: 'SelectFilesAndFolders' },
        });

        const options = screen.getAllByRole('option');
        // Single click on folder selects it without opening
        fireEvent.click(options[0]);
        expect(options[0]).toHaveAttribute('aria-selected', 'true');
        expect(onLoadDirectory).not.toHaveBeenCalled();

        // Double click on folder opens it
        fireEvent.doubleClick(options[0]);
        expect(onLoadDirectory).toHaveBeenCalledWith('C:\\Docs\\FolderA');

        // Single click on file selects it without opening
        fireEvent.click(options[1]);
        expect(options[1]).toHaveAttribute('aria-selected', 'true');
        expect(onOpenFile).not.toHaveBeenCalled();

        // Double click on file opens it
        fireEvent.doubleClick(options[1]);
        expect(onOpenFile).toHaveBeenCalledWith('C:\\Docs\\file1.txt');
    });
});

describe('TP-FE-UI-06: Drag-and-Drop in FileList & FileItem (BUG-064, BUG-031)', () => {
    test('blocks self-drop/descendant-drop on FileItem and supports drop on empty folder', async () => {
        const emptyData = { directories: [], files: [] };
        const onRefreshEmpty = vi.fn();

        const { unmount } = renderWithProviders(
            <FileList
                data={emptyData}
                isLoading={false}
                targetDirectory={"C:\\EmptyDir"}
                onRefresh={onRefreshEmpty}
                selectedItems={[]}
                onSelectItem={vi.fn()}
                onSelectMultiple={vi.fn()}
                onClearSelection={vi.fn()}
                onLoadDirectory={vi.fn()}
                onOpenFile={vi.fn()}
                focusedItem={null}
                onSetFocusedItem={vi.fn()}
            />
        );

        const emptyContainer = document.querySelector('.empty-state-container');
        await act(async () => {
            fireEvent.drop(emptyContainer, {
                dataTransfer: {
                    getData: (type) =>
                        type === 'application/json'
                            ? JSON.stringify({ path: 'C:\\Src\\note.txt', name: 'note.txt', isDirectory: false })
                            : '',
                    files: [],
                },
            });
        });

        expect(mockInvoke).toHaveBeenCalledWith('copy_file_or_dir', {
            sourcePath: 'C:\\Src\\note.txt',
            destinationPath: 'C:\\EmptyDir\\note.txt',
        });
        expect(onRefreshEmpty).toHaveBeenCalledWith('C:\\EmptyDir');
        unmount();

        // Self-drop & descendant-drop guard on FileItem
        const folderData = {
            directories: [{ name: 'Sub', path: 'C:\\Root\\Sub', sub_file_count: 0 }],
            files: [],
        };
        const onRefreshFolder = vi.fn();
        renderWithProviders(
            <FileList
                data={folderData}
                isLoading={false}
                targetDirectory="C:\\Root"
                onRefresh={onRefreshFolder}
                selectedItems={[]}
                onSelectItem={vi.fn()}
                onSelectMultiple={vi.fn()}
                onClearSelection={vi.fn()}
                onLoadDirectory={vi.fn()}
                onOpenFile={vi.fn()}
                focusedItem={null}
                onSetFocusedItem={vi.fn()}
            />
        );

        mockInvoke.mockClear();
        const folderOption = screen.getByRole('option');

        // Self-drop onto C:\Root\Sub
        await act(async () => {
            fireEvent.drop(folderOption, {
                dataTransfer: {
                    getData: () => JSON.stringify({ path: 'C:\\Root\\Sub', name: 'Sub', isDirectory: true }),
                    files: [],
                },
            });
        });
        expect(mockInvoke).not.toHaveBeenCalledWith('copy_file_or_dir', expect.anything());

        // Parent-drop: dragging C:\Root into C:\Root\Sub
        await act(async () => {
            fireEvent.drop(folderOption, {
                dataTransfer: {
                    getData: () => JSON.stringify({ path: 'C:\\Root', name: 'Root', isDirectory: true }),
                    files: [],
                },
            });
        });
        expect(mockInvoke).not.toHaveBeenCalledWith('copy_file_or_dir', expect.anything());

        // External file drop onto folder
        await act(async () => {
            fireEvent.drop(folderOption, {
                dataTransfer: {
                    getData: () => '',
                    files: [{ name: 'ext.txt', path: 'D:\\ext.txt' }],
                },
            });
        });
        expect(mockInvoke).toHaveBeenCalledWith('copy_file_or_dir', {
            sourcePath: 'D:\\ext.txt',
            destinationPath: 'C:\\Root\\Sub\\ext.txt',
        });
        expect(onRefreshFolder).toHaveBeenCalled();
    });
});

const DualPaneAfterInit = (props) => {
    const { currentPath } = useHistory();
    if (!currentPath) return null;
    return <DualPane {...props} />;
};

describe('TP-FE-UI-07 & TP-FE-UI-08: DualPane keyboard isolation, drive switch, drop, and Shift+F6 (BUG-029, BUG-030, BUG-031)', () => {
    test('TP-FE-UI-07: isolates keyboard events to active pane and prevents drive click rollback', async () => {
        localStorage.setItem('explr_dual_pane_left', 'C:\\A');
        localStorage.setItem('explr_dual_pane_right', 'D:\\B');

        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') {
                return JSON.stringify([
                    { mount_point: 'C:\\', volume_name: 'OS' },
                    { mount_point: 'D:\\', volume_name: 'Data' },
                    { mount_point: 'E:\\', volume_name: 'Extra' },
                ]);
            }
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'open_directory') {
                if (args?.path === 'C:\\A') {
                    return JSON.stringify(makeDirData('C:\\A', 2));
                }
                if (args?.path === 'D:\\B') {
                    return JSON.stringify(makeDirData('D:\\B', 2));
                }
                if (args?.path === 'E:\\') {
                    return JSON.stringify(makeDirData('E:\\', 1));
                }
                return JSON.stringify({ directories: [], files: [] });
            }
            return undefined;
        });

        renderWithProviders(<DualPaneAfterInit viewMode="list" />);

        await waitFor(() => {
            const panels = document.querySelectorAll('.dual-pane-panel');
            expect(screen.getByText('C:\\A')).toBeInTheDocument();
            expect(screen.getByText('D:\\B')).toBeInTheDocument();
            // The persisted headers can render before either listing is ready.
            expect(within(panels[0]).getAllByRole('option')).toHaveLength(3);
            expect(within(panels[1]).getAllByRole('option')).toHaveLength(3);
        });

        const panels = document.querySelectorAll('.dual-pane-panel');
        // Activate right pane
        await act(async () => {
            fireEvent.click(panels[1]);
        });
        expect(panels[1]).toHaveClass('active');

        // Press ArrowDown: only right pane should move focus/selection, left pane stays untouched
        await act(async () => {
            fireEvent.keyDown(window, { key: 'ArrowDown' });
        });
        const leftOptions = within(panels[0]).getAllByRole('option');
        const rightOptions = within(panels[1]).getAllByRole('option');
        expect(leftOptions.some((el) => el.getAttribute('aria-selected') === 'true')).toBe(false);
        expect(rightOptions.some((el) => el.getAttribute('aria-selected') === 'true')).toBe(true);

        // Click drive E: on inactive left pane — must stay on E:\ and NOT roll back to C:\A
        const leftDriveE = within(panels[0]).getByRole('button', { name: 'E:' });
        await act(async () => {
            fireEvent.click(leftDriveE);
        });

        await waitFor(() => {
            expect(within(panels[0]).getByText('E:\\')).toBeInTheDocument();
        });
        expect(panels[0]).toHaveClass('active');
    });

    test('R3.2: initial layout interaction must not be overwritten by passive initialization', async () => {
        localStorage.setItem('explr_dual_pane_left', 'C:\\A');
        localStorage.setItem('explr_dual_pane_right', 'D:\\B');
        const pending = [];
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') return JSON.stringify([{ mount_point: 'C:\\' }]);
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'open_directory') {
                if (args.path === 'C:\\A' || args.path === 'D:\\B') {
                    return new Promise(resolve => pending.push({ path: args.path, resolve }));
                }
                return JSON.stringify(makeDirData(args.path, 2));
            }
        });
        function EarlyInteraction() {
            const { currentPath } = useHistory();
            React.useLayoutEffect(() => {
                if (!currentPath) return;
                document.querySelectorAll('.dual-pane-panel')[1].click();
            }, [Boolean(currentPath)]);
            if (!currentPath) return null;
            return <><output data-testid="history-path">{currentPath}</output><DualPane viewMode="list" /></>;
        }
        renderWithProviders(<EarlyInteraction />);
        await waitFor(() => expect(pending.some(r => r.path === 'D:\\B')).toBe(true));
        const panels = document.querySelectorAll('.dual-pane-panel');
        await act(async () => pending.splice(0).reverse().forEach(({ path, resolve }) => resolve(JSON.stringify(makeDirData(path, 2)))));
        expect(panels[1]).toHaveClass('active');
        expect(screen.getByTestId('history-path')).toHaveTextContent('D:\\B');
        expect(within(panels[0]).getAllByRole('option')).toHaveLength(3);
        expect(within(panels[1]).getAllByRole('option')).toHaveLength(3);
    });

    test('R3.2: StrictMode replay preserves latest pane ownership and ignores superseded listings', async () => {
        localStorage.setItem('explr_dual_pane_left', 'C:\\A');
        localStorage.setItem('explr_dual_pane_right', 'D:\\B');
        const pending = [];
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') return JSON.stringify([{ mount_point: 'C:\\' }]);
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'open_directory') {
                if (args.path === 'C:\\A' || args.path === 'D:\\B') {
                    return new Promise(resolve => pending.push({ path: args.path, resolve }));
                }
                return JSON.stringify(makeDirData(args.path, 2));
            }
        });
        function Probe() {
            const { currentPath } = useHistory();
            return <output data-testid="history-path">{currentPath}</output>;
        }
        renderWithProviders(<React.StrictMode><Probe /><DualPaneAfterInit viewMode="list" /></React.StrictMode>);
        await waitFor(() => {
            expect(pending.filter(r => r.path === 'C:\\A').length).toBeGreaterThanOrEqual(2);
            expect(pending.filter(r => r.path === 'D:\\B').length).toBeGreaterThanOrEqual(2);
        });
        const panels = document.querySelectorAll('.dual-pane-panel');
        await act(async () => fireEvent.click(panels[1]));
        const latestLeft = pending.findLast(r => r.path === 'C:\\A');
        const latestRight = pending.findLast(r => r.path === 'D:\\B');
        await act(async () => {
            latestRight.resolve(JSON.stringify(makeDirData(latestRight.path, 2)));
            latestLeft.resolve(JSON.stringify(makeDirData(latestLeft.path, 2)));
        });
        expect(screen.getByTestId('history-path')).toHaveTextContent('D:\\B');
        expect(within(panels[0]).getAllByRole('option')).toHaveLength(3);
        expect(within(panels[1]).getAllByRole('option')).toHaveLength(3);
        await act(async () => {
            pending.filter(r => r !== latestLeft && r !== latestRight).forEach(({ path, resolve }) =>
                resolve(JSON.stringify(makeDirData(path, 5))));
        });
        expect(panels[1]).toHaveClass('active');
        expect(screen.getByTestId('history-path')).toHaveTextContent('D:\\B');
        expect(within(panels[0]).getAllByRole('option')).toHaveLength(3);
        expect(within(panels[1]).getAllByRole('option')).toHaveLength(3);
    });

    test('R3.2: switching before initial left load completes keeps right navigation and recovers left listing', async () => {
        localStorage.setItem('explr_dual_pane_left', 'C:\\A');
        localStorage.setItem('explr_dual_pane_right', 'D:\\B');
        const pending = [];
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') return JSON.stringify([{ mount_point: 'C:\\' }]);
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'open_directory') {
                if (args.path === 'C:\\A') return new Promise(resolve => pending.push(resolve));
                return JSON.stringify(makeDirData(args.path, 2));
            }
        });
        function Probe() {
            const { currentPath } = useHistory();
            return <output data-testid="history-path">{currentPath}</output>;
        }
        renderWithProviders(<><Probe /><DualPaneAfterInit viewMode="list" /></>);
        await waitFor(() => expect(pending.length).toBeGreaterThan(0));
        const panels = document.querySelectorAll('.dual-pane-panel');
        await waitFor(() => expect(within(panels[1]).getAllByRole('option')).toHaveLength(3));
        await act(async () => fireEvent.click(panels[1]));
        await waitFor(() => expect(screen.getByTestId('history-path')).toHaveTextContent('D:\\B'));
        await act(async () => pending.splice(0).forEach(resolve => resolve(JSON.stringify(makeDirData('C:\\A', 2)))));
        expect(panels[1]).toHaveClass('active');
        expect(screen.getByTestId('history-path')).toHaveTextContent('D:\\B');
        expect(within(panels[0]).getAllByRole('option')).toHaveLength(3);
        expect(within(panels[0]).getByText('C:\\A')).toBeInTheDocument();
    });

    test('R3.2: failed activation preserves previous active pane and committed history', async () => {
        localStorage.setItem('explr_dual_pane_left', 'C:\\A');
        localStorage.setItem('explr_dual_pane_right', 'D:\\B');
        let rejectRight;
        let rightReads = 0;
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') return JSON.stringify([{ mount_point: 'C:\\' }]);
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'open_directory') {
                if (args.path === 'D:\\B' && ++rightReads > 1) return new Promise((_, reject) => { rejectRight = reject; });
                return JSON.stringify(makeDirData(args.path, 2));
            }
        });
        function Probe() {
            const { currentPath } = useHistory();
            return <output data-testid="history-path">{currentPath}</output>;
        }
        renderWithProviders(<><Probe /><DualPaneAfterInit viewMode="list" /></>);
        const panels = await waitFor(() => {
            const found = document.querySelectorAll('.dual-pane-panel');
            expect(found).toHaveLength(2);
            expect(within(found[0]).getAllByRole('option')).toHaveLength(3);
            expect(within(found[1]).getAllByRole('option')).toHaveLength(3);
            expect(screen.getByTestId('history-path')).toHaveTextContent('C:\\A');
            return found;
        });
        fireEvent.click(panels[1]);
        await waitFor(() => expect(rejectRight).toBeTypeOf('function'));
        await act(async () => rejectRight(new Error('Permission denied')));
        expect(screen.getByTestId('history-path')).toHaveTextContent('C:\\A');
        expect(panels[0]).toHaveClass('active');
        expect(within(panels[1]).getByText('D:\\B')).toBeInTheDocument();
        expect(within(panels[1]).getAllByRole('option')).toHaveLength(3);
    });

    test('R3.2: stale active and background SFTP reads cannot commit after Explorer owner change', async () => {
        const a = 'sftp:A:/base/sub';
        const b = 'sftp:B:/target';
        const c = 'sftp:C:/background';
        localStorage.setItem('fileExplorerSftpConnections', JSON.stringify(['A', 'B', 'C'].map(name => ({
            name, host: name.toLowerCase() + '.invalid', username: 'test', port: 22,
        }))));
        localStorage.setItem('explr_saved_tabs', JSON.stringify([
            { id: 'tab-a', title: 'Owner A', path: a }, { id: 'tab-b', title: 'Owner B', path: b },
        ]));
        localStorage.setItem('explr_active_tab_id', 'tab-a');
        localStorage.setItem('explr_dual_pane_left', a);
        localStorage.setItem('explr_dual_pane_right', c);
        sessionStorage.setItem('fileExplorerHistory', JSON.stringify([a]));
        sessionStorage.setItem('fileExplorerHistoryIndex', '0');
        let resolveActive;
        let resolveBackground;
        let backgroundReads = 0;
        const listing = (name) => JSON.stringify({ directories: [], files: [name] });
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') return '[]';
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'load_dir') {
                if (args.host === 'a.invalid' && args.directory === '/base') {
                    return new Promise(resolve => { resolveActive = resolve; });
                }
                if (args.host === 'c.invalid') {
                    if (++backgroundReads === 1) return new Promise(resolve => { resolveBackground = resolve; });
                    return listing('/background/new.txt');
                }
                return listing(args.directory + '/current.txt');
            }
        });
        function Probe() {
            const { currentPath } = useHistory();
            const { currentSftpConnection, currentSftpPath } = useSftp();
            return <><output data-testid="history-path">{currentPath}</output><output data-testid="sftp-state">{currentSftpConnection?.name}:{currentSftpPath}</output></>;
        }
        renderWithProviders(<TabManager><Probe /><DualPane viewMode="list" /></TabManager>);
        const panels = document.querySelectorAll('.dual-pane-panel');
        await waitFor(() => {
            expect(within(panels[0]).getByRole('option')).toBeInTheDocument();
            expect(resolveBackground).toBeTypeOf('function');
            expect(screen.getByTestId('sftp-state')).toHaveTextContent('A:/base/sub');
        });
        fireEvent.click(within(panels[0]).getByTitle('Up one level'));
        await waitFor(() => expect(resolveActive).toBeTypeOf('function'));
        fireEvent.click(screen.getByText('Owner B'));
        await waitFor(() => {
            expect(screen.getByTestId('history-path')).toHaveTextContent(b);
            expect(screen.getByTestId('sftp-state')).toHaveTextContent('B:/target');
            expect(within(panels[1]).getByText('new.txt')).toBeInTheDocument();
        });
        await act(async () => {
            resolveActive(listing('/base/stale-active.txt'));
            resolveBackground(listing('/background/stale-background.txt'));
        });
        expect(screen.getByTestId('history-path')).toHaveTextContent(b);
        expect(screen.getByTestId('sftp-state')).toHaveTextContent('B:/target');
        expect(within(panels[0]).getByText(b)).toBeInTheDocument();
        expect(within(panels[1]).getByText('new.txt')).toBeInTheDocument();
        expect(screen.queryByText('stale-active.txt')).not.toBeInTheDocument();
        expect(screen.queryByText('stale-background.txt')).not.toBeInTheDocument();
    });

    test('R3.2: failed Swap leaves both pane snapshots and global history unchanged', async () => {
        localStorage.setItem('explr_dual_pane_left', 'C:\\A');
        localStorage.setItem('explr_dual_pane_right', 'D:\\B');
        let rejectSwap;
        let rightReads = 0;
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') return JSON.stringify([{ mount_point: 'C:\\' }]);
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'open_directory') {
                if (args.path === 'D:\\B' && ++rightReads === 2) return new Promise((_, reject) => { rejectSwap = reject; });
                return JSON.stringify(makeDirData(args.path, 2));
            }
        });
        function Probe() {
            const { currentPath } = useHistory();
            return <output data-testid="history-path">{currentPath}</output>;
        }
        renderWithProviders(<><Probe /><DualPaneAfterInit viewMode="list" /></>);
        const panels = await waitFor(() => {
            const found = document.querySelectorAll('.dual-pane-panel');
            expect(found).toHaveLength(2);
            expect(within(found[0]).getAllByRole('option')).toHaveLength(3);
            expect(within(found[1]).getAllByRole('option')).toHaveLength(3);
            expect(screen.getByTestId('history-path')).toHaveTextContent('C:\\A');
            return found;
        });
        fireEvent.click(screen.getByRole('button', { name: /swap panes/i }));
        await waitFor(() => expect(rejectSwap).toBeTypeOf('function'));
        await act(async () => rejectSwap(new Error('Permission denied')));
        expect(screen.getByTestId('history-path')).toHaveTextContent('C:\\A');
        expect(within(panels[0]).getByText('C:\\A')).toBeInTheDocument();
        expect(within(panels[1]).getByText('D:\\B')).toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole('button', { name: /swap panes/i })));
        await waitFor(() => expect(screen.getByTestId('history-path')).toHaveTextContent('D:\\B'));
        expect(within(panels[0]).getByText('D:\\B')).toBeInTheDocument();
        expect(within(panels[1]).getByText('C:\\A')).toBeInTheDocument();
    });

    test('R3.2: late drop refresh cannot replace a pane after it navigates elsewhere', async () => {
        localStorage.setItem('explr_dual_pane_left', 'C:\\A');
        localStorage.setItem('explr_dual_pane_right', 'D:\\B');
        let finishCopy;
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') return JSON.stringify([
                { mount_point: 'C:\\' }, { mount_point: 'D:\\' }, { mount_point: 'E:\\' },
            ]);
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'copy_file_or_dir') return new Promise(resolve => { finishCopy = resolve; });
            if (cmd === 'open_directory') return JSON.stringify(makeDirData(args.path, 2));
        });
        function Probe() {
            const { currentPath } = useHistory();
            return <output data-testid="history-path">{currentPath}</output>;
        }
        renderWithProviders(<><Probe /><DualPaneAfterInit viewMode="list" /></>);
        const panels = await waitFor(() => {
            const found = document.querySelectorAll('.dual-pane-panel');
            expect(found).toHaveLength(2);
            expect(within(found[0]).getAllByRole('option')).toHaveLength(3);
            expect(within(found[1]).getAllByRole('option')).toHaveLength(3);
            return found;
        });
        fireEvent.drop(panels[1], {
            dataTransfer: {
                getData: type => type === 'application/json'
                    ? JSON.stringify({ path: 'C:\\A\\file1.txt', name: 'file1.txt', isDirectory: false }) : '',
                files: [],
            },
        });
        await waitFor(() => expect(finishCopy).toBeTypeOf('function'));
        await act(async () => fireEvent.click(within(panels[1]).getByRole('button', { name: 'E:' })));
        await waitFor(() => expect(screen.getByTestId('history-path')).toHaveTextContent('E:\\'));
        await act(async () => finishCopy());
        expect(within(panels[1]).getByText('E:\\')).toBeInTheDocument();
        expect(screen.getByTestId('history-path')).toHaveTextContent('E:\\');
    });

    test('TP-FE-UI-08: drops into target pane, blocks Shift+F6 move_to_trash on identical paths, and ignores plain F6', async () => {
        localStorage.setItem('explr_dual_pane_left', 'C:\\A');
        localStorage.setItem('explr_dual_pane_right', 'D:\\B');

        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_system_volumes_information_as_json') {
                return JSON.stringify([
                    { mount_point: 'C:\\', volume_name: 'OS' },
                    { mount_point: 'D:\\', volume_name: 'Data' },
                ]);
            }
            if (cmd === 'get_initial_cli_path') return null;
            if (cmd === 'open_directory') {
                if (args?.path === 'C:\\A') return JSON.stringify(makeDirData('C:\\A', 2));
                if (args?.path === 'D:\\B') return JSON.stringify(makeDirData('D:\\B', 2));
                return JSON.stringify({ directories: [], files: [] });
            }
            return undefined;
        });

        renderWithProviders(<DualPaneAfterInit viewMode="list" />);

        await waitFor(() => {
            expect(screen.getByText('C:\\A')).toBeInTheDocument();
            expect(screen.getByText('D:\\B')).toBeInTheDocument();
        });

        const panels = document.querySelectorAll('.dual-pane-panel');
        // Left pane is active; drop a file onto right pane's .file-list-container
        const rightListContainer = panels[1].querySelector('.file-list-container');
        await act(async () => {
            fireEvent.drop(rightListContainer, {
                dataTransfer: {
                    getData: (type) =>
                        type === 'application/json'
                            ? JSON.stringify({ path: 'C:\\A\\file1.txt', name: 'file1.txt', isDirectory: false })
                            : '',
                    files: [],
                },
            });
        });

        expect(mockInvoke).toHaveBeenCalledWith('copy_file_or_dir', {
            sourcePath: 'C:\\A\\file1.txt',
            destinationPath: 'D:\\B\\file1.txt',
        });

        // Equalize so both panes have C:\A, select file1.txt, test plain F6 vs Shift+F6
        await act(async () => {
            fireEvent.click(screen.getByTitle('Equalize (A = B)'));
        });
        await waitFor(() => {
            expect(within(panels[1]).getByText('C:\\A')).toBeInTheDocument();
        });

        const leftFirstFile = within(panels[0]).getAllByRole('option')[1];
        fireEvent.click(leftFirstFile);

        mockInvoke.mockClear();
        // Plain F6 must NOT trigger move
        await act(async () => {
            fireEvent.keyDown(window, { key: 'F6' });
        });
        expect(mockInvoke).not.toHaveBeenCalledWith('rename', expect.anything());
        expect(mockInvoke).not.toHaveBeenCalledWith('move_to_trash', expect.anything());

        // Shift+F6 when leftPath === rightPath must NOT call rename or move_to_trash
        await act(async () => {
            fireEvent.keyDown(window, { key: 'F6', shiftKey: true });
        });
        expect(mockInvoke).not.toHaveBeenCalledWith('rename', expect.anything());
        expect(mockInvoke).not.toHaveBeenCalledWith('move_to_trash', expect.anything());
    });
});
