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
import SftpProvider from '../src/providers/SftpProvider.jsx';
import FileList from '../src/components/explorer/FileList.jsx';
import DualPane from '../src/components/explorer/DualPane.jsx';

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
            expect(screen.getByText('C:\\A')).toBeInTheDocument();
            expect(screen.getByText('D:\\B')).toBeInTheDocument();
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
