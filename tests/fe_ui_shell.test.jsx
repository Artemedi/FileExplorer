import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args) => mockInvoke(...args),
    convertFileSrc: (path) => `asset://localhost/${path}`,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: (...args) => mockListen(...args),
}));

const mockShowSuccess = vi.fn();
const mockShowError = vi.fn();
const mockShowConfirm = vi.fn();

vi.mock('../src/utils/NotificationSystem', () => ({
    showSuccess: (...args) => mockShowSuccess(...args),
    showError: (...args) => mockShowError(...args),
    showConfirm: (...args) => mockShowConfirm(...args),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
}));

import { usePreview } from '../src/hooks/usePreview.js';
import PreviewModal from '../src/components/preview/PreviewModal.jsx';
import ContextMenu from '../src/components/contextMenu/ContextMenu.jsx';
import ContextMenuItem from '../src/components/contextMenu/ContextMenuItem.jsx';
import CreateFileButton from '../src/components/explorer/CreateFileButton.jsx';
import NavigationButtons from '../src/components/explorer/NavigationButtons.jsx';
import MainLayout from '../src/layouts/MainLayout.jsx';

import ThemeProvider from '../src/providers/ThemeProvider.jsx';
import { SettingsContext } from '../src/providers/SettingsProvider.jsx';
import SftpProvider from '../src/providers/SftpProvider.jsx';
import HistoryProvider, { useHistory } from '../src/providers/HistoryProvider.jsx';
import FileSystemProvider, { useFileSystem } from '../src/providers/FileSystemProvider.jsx';
import ContextMenuProvider from '../src/providers/ContextMenuProvider.jsx';
import AppStateProvider from '../src/providers/AppStateProvider.jsx';

const defaultSettings = {
    theme: 'light',
    default_view: 'grid',
    show_details_panel: false,
    show_hidden_files_and_folders: false,
    auto_refresh_dir: false,
    confirm_delete: false,
    default_folder_path_on_opening: '',
    search_engine_enabled: true,
    sort_by: 'name',
    sort_direction: 'Ascending',
    terminal_height: 240,
};

function renderWithAppProviders(ui, { settingsOverride = {}, updateSetting = vi.fn() } = {}) {
    const settingsVal = {
        settings: { ...defaultSettings, ...settingsOverride },
        updateSetting,
        isLoading: false,
        resetSettings: vi.fn(),
    };

    return render(
        <ThemeProvider>
            <SettingsContext.Provider value={settingsVal}>
                <SftpProvider>
                    <HistoryProvider>
                        <FileSystemProvider>
                            <ContextMenuProvider>
                                <AppStateProvider>{ui}</AppStateProvider>
                            </ContextMenuProvider>
                        </FileSystemProvider>
                    </HistoryProvider>
                </SftpProvider>
            </SettingsContext.Provider>
        </ThemeProvider>
    );
}

describe('w4-ui-shell: BUG-024, BUG-034, BUG-065, BUG-085', () => {
    const setupInvoke = (overrides = {}) => {
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd in overrides) {
                return overrides[cmd](args);
            }
            if (cmd === 'get_setting_field') {
                return false;
            }
            if (cmd === 'get_system_volumes_information_as_json') {
                return JSON.stringify([{ volume_name: 'C:', mount_point: 'C:\\', total_space: 1000, available_space: 500 }]);
            }
            if (cmd === 'get_meta_data_as_json') {
                return JSON.stringify({ user_home_dir: 'C:\\Users\\Test' });
            }
            if (cmd === 'open_directory') {
                return JSON.stringify({
                    directories: [{ name: 'FolderA', path: 'C:\\Test\\FolderA', size_in_bytes: 0 }],
                    files: [
                        { name: 'f1.txt', path: 'C:\\Test\\f1.txt', size_in_bytes: 10 },
                        { name: 'f2.txt', path: 'C:\\Test\\f2.txt', size_in_bytes: 20 },
                        { name: 'f3.txt', path: 'C:\\Test\\f3.txt', size_in_bytes: 30 },
                    ],
                });
            }
            if (cmd === 'get_search_engine_info') {
                return { stats: { trie_size: 5 } };
            }
            if (cmd === 'set_search_current_directory') {
                return null;
            }
            return null;
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        mockListen.mockResolvedValue(() => {});
        setupInvoke();
    });

    afterEach(() => {
        cleanup();
    });

    test('R3.4 integration: preview accepts keyboard navigation immediately after opening commit', async () => {
        const first = { name: 'first.txt', path: 'C:\\Test\\first.txt' };
        const second = { name: 'second.txt', path: 'C:\\Test\\second.txt' };
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'build_preview') return { kind: 'Text', name: args.path.split('\\').pop(), path: args.path, text: 'fixture' };
            return null;
        });
        function Harness() {
            const sent = React.useRef(false);
            const preview = usePreview(() => first, null, () => second, null, null, true);
            React.useLayoutEffect(() => {
                if (preview.payload?.name === first.name && !sent.current) {
                    sent.current = true;
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
                }
            }, [preview.payload]);
            return <div data-testid="preview-name">{preview.payload?.name || ''}</div>;
        }
        render(<Harness />);
        fireEvent.keyDown(window, { key: ' ' });
        await waitFor(() => expect(screen.getByTestId('preview-name')).toHaveTextContent('second.txt'));
        expect(mockInvoke).toHaveBeenCalledWith('build_preview', { path: second.path });
    });

    test('TP-FE-STATE-08: usePreview arrow navigation has no 1-step lag and Esc cancels pending IPC', async () => {
        const items = [
            { name: 'f1.txt', path: 'C:\\Test\\f1.txt' },
            { name: 'f2.txt', path: 'C:\\Test\\f2.txt' },
        ];
        let idx = 0;

        let resolveSlow;
        mockInvoke.mockImplementation((cmd, args) => {
            if (cmd === 'build_preview') {
                if (args.path === 'C:\\Test\\slow.txt') {
                    return new Promise((res) => {
                        resolveSlow = res;
                    });
                }
                return Promise.resolve({ kind: 'Text', name: args.path.split('\\').pop(), path: args.path, text: `content:${args.path}` });
            }
            return Promise.resolve(null);
        });

        function Harness({ slow = false }) {
            const focusedRef = React.useRef(slow ? { name: 'slow.txt', path: 'C:\\Test\\slow.txt' } : items[0]);
            const navigateDown = () => {
                idx = (idx + 1) % items.length;
                focusedRef.current = items[idx];
                return items[idx];
            };
            const preview = usePreview(() => focusedRef.current, null, navigateDown, null, null, true);
            return (
                <div>
                    <div data-testid="preview-open">{String(preview.open)}</div>
                    <div data-testid="preview-name">{preview.payload?.name || ''}</div>
                </div>
            );
        }

        const { unmount } = render(<Harness />);
        fireEvent.keyDown(window, { key: ' ' });
        await waitFor(() => expect(screen.getByTestId('preview-name')).toHaveTextContent('f1.txt'));

        fireEvent.keyDown(window, { key: 'ArrowDown' });
        await waitFor(() => expect(screen.getByTestId('preview-name')).toHaveTextContent('f2.txt'));
        unmount();

        // Slow file: Space -> Esc before IPC resolves -> must NOT resurrect
        render(<Harness slow />);
        fireEvent.keyDown(window, { key: ' ' });
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('build_preview', { path: 'C:\\Test\\slow.txt' }));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.getByTestId('preview-open')).toHaveTextContent('false');

        await act(async () => {
            resolveSlow({ kind: 'Text', name: 'slow.txt', path: 'C:\\Test\\slow.txt', text: 'late' });
        });
        expect(screen.getByTestId('preview-open')).toHaveTextContent('false');
    });

    test('TP-FE-UI-13: PreviewModal ARIA, contrast, formatFileSize(undefined), Open in Default App, and media onError', async () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <PreviewModal
                isLoading={false}
                onClose={onClose}
                payload={{
                    kind: 'Image',
                    name: 'photo.png',
                    path: 'C:\\Test\\photo.png',
                    data_uri: 'data:image/png;base64,abc',
                    bytes: undefined,
                }}
            />
        );

        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        const titleEl = screen.getByText('photo.png');
        expect(titleEl).not.toHaveStyle({ opacity: '0.35' });
        expect(screen.getByText('0 Bytes')).toBeInTheDocument();

        const img = screen.getByAltText('photo.png');
        fireEvent.error(img);
        expect(screen.getByText(/Failed to load preview media/i)).toBeInTheDocument();

        rerender(
            <PreviewModal
                isLoading={false}
                onClose={onClose}
                payload={{
                    kind: 'Unknown',
                    name: 'archive.bin',
                    path: 'C:\\Test\\archive.bin',
                }}
            />
        );
        fireEvent.click(screen.getByRole('button', { name: /Open in Default App/i }));
        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('open_in_default_app', { path: 'C:\\Test\\archive.bin' });
        });
    });

    test('TP-FE-STATE-11: CreateFileButton disabled when currentPath is null and handles already-exists copy naming for a.txt.txt', async () => {
        function NavWrapper({ initialPath }) {
            const { navigateTo } = useHistory();
            React.useEffect(() => {
                if (initialPath) navigateTo(initialPath);
            }, [initialPath, navigateTo]);
            return <CreateFileButton />;
        }

        const { unmount } = renderWithAppProviders(<NavWrapper />);
        const disabledBtn = await screen.findByRole('button', { name: /Create new item/i });
        expect(disabledBtn).toBeDisabled();
        unmount();

        setupInvoke({
            create_file: async () => {
                throw 'File already exists';
            },
        });
        mockShowConfirm.mockResolvedValue(true);

        renderWithAppProviders(<NavWrapper initialPath="C:\\Test" />);
        const newBtn = await waitFor(() => {
            const b = screen.getByRole('button', { name: /Create new item/i });
            expect(b).not.toBeDisabled();
            return b;
        });

        fireEvent.click(newBtn);
        fireEvent.click(screen.getByText('Text File'));
        const input = screen.getByLabelText(/File name:/i);
        fireEvent.change(input, { target: { value: 'a.txt.txt' } });
        fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

        await waitFor(() => expect(mockShowConfirm).toHaveBeenCalled());
        await waitFor(() => expect(input).toHaveValue('a.txt - Copy.txt'));
    });

    test('TP-FE-UI-17: MainLayout disables Delete/Backspace/F2/Ctrl+A over modals, DetailsPanel, and non-empty selection; F6 toggles DualPane', async () => {
        function MainWithPath() {
            const { navigateTo } = useHistory();
            const { selectMultiple } = useFileSystem();
            const [showModal, setShowModal] = React.useState(true);
            React.useEffect(() => {
                navigateTo('C:\\Test');
            }, [navigateTo]);
            return (
                <>
                    <button
                        data-testid="seed-selection"
                        onClick={() => selectMultiple([{ name: 'f1.txt', path: 'C:\\Test\\f1.txt', isDirectory: false }])}
                    >
                        Seed
                    </button>
                    <button data-testid="close-fake-modal" onClick={() => setShowModal(false)}>
                        Close Modal
                    </button>
                    <MainLayout />
                    {showModal && (
                        <div role="dialog" data-testid="fake-modal" tabIndex={-1}>
                            Modal
                        </div>
                    )}
                </>
            );
        }

        renderWithAppProviders(<MainWithPath />);
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('open_directory', expect.objectContaining({ path: expect.any(String) })));
        fireEvent.click(screen.getByTestId('seed-selection'));

        const modal = screen.getByTestId('fake-modal');
        fireEvent.keyDown(modal, { key: 'Delete' });
        fireEvent.keyDown(modal, { key: 'Backspace' });
        fireEvent.keyDown(modal, { key: 'F2' });
        fireEvent.keyDown(modal, { key: 'a', ctrlKey: true });

        expect(mockInvoke).not.toHaveBeenCalledWith('move_to_trash', expect.anything());
        expect(screen.queryByText(/Rename/i)).not.toBeInTheDocument();

        // Close fake modal via React state and test F6 toggling DualPane on and off
        fireEvent.click(screen.getByTestId('close-fake-modal'));
        expect(localStorage.getItem('explr_dual_pane')).not.toBe('true');
        fireEvent.keyDown(document, { key: 'F6' });
        expect(localStorage.getItem('explr_dual_pane')).toBe('true');
        fireEvent.keyDown(document, { key: 'F6' });
        expect(localStorage.getItem('explr_dual_pane')).toBe('false');
    });

    test('TP-FE-UI-18: search_engine_enabled=false skips auto-indexing, drag-drop uses latest currentPath, and ContextMenu clamps position', async () => {
        let dropHandler;
        mockListen.mockImplementation(async (eventName, cb) => {
            if (eventName === 'tauri://drag-drop') {
                dropHandler = cb;
            }
            return () => {};
        });

        const updateSetting = vi.fn().mockResolvedValue(undefined);

        function NavController() {
            const { navigateTo } = useHistory();
            return (
                <>
                    <button data-testid="go-dir" onClick={() => navigateTo('C:\\TargetDir')}>
                        Go
                    </button>
                    <MainLayout />
                </>
            );
        }

        renderWithAppProviders(<NavController />, {
            settingsOverride: { search_engine_enabled: false },
            updateSetting,
        });

        await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('get_system_volumes_information_as_json'));
        expect(mockInvoke).not.toHaveBeenCalledWith('add_paths_recursive_async', expect.anything());

        // Navigate after mount so currentPath changes from null -> C:\TargetDir
        fireEvent.click(screen.getByTestId('go-dir'));
        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('set_search_current_directory', { path: 'C:\\TargetDir' });
        });

        // Trigger tauri://drag-drop and verify it copies into C:\TargetDir
        await act(async () => {
            await dropHandler({ payload: { paths: ['C:\\Source\\doc.txt'] } });
        });
        expect(mockInvoke).toHaveBeenCalledWith('copy_file_or_dir', {
            sourcePath: 'C:\\Source\\doc.txt',
            destinationPath: 'C:\\TargetDir\\doc.txt',
        });

        // NavigationButtons uses NotificationSystem instead of raw DOM toasts
        renderWithAppProviders(<NavigationButtons />);
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(mockShowSuccess).toHaveBeenCalled());

        // ContextMenu clamps negative / overflowing coordinates to >= 8
        const { container } = render(
            <ContextMenu
                position={{ x: -50, y: -30 }}
                items={[{ id: 'copy', label: 'Copy', action: vi.fn() }]}
                onClose={vi.fn()}
            />
        );
        const menuEl = container.querySelector('.context-menu');
        expect(parseInt(menuEl.style.left, 10)).toBeGreaterThanOrEqual(8);
        expect(parseInt(menuEl.style.top, 10)).toBeGreaterThanOrEqual(8);

        // ContextMenuItem submenu clamps Y against window.innerHeight
        Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true });
        const { container: itemContainer } = render(
            <ul>
                <ContextMenuItem
                    item={{
                        id: 'hash',
                        label: 'Hash',
                        submenu: [
                            { id: 'sha', label: 'SHA-256' },
                            { id: 'md5', label: 'MD5' },
                        ],
                    }}
                    isSubmenuOpen={true}
                    onSubmenuOpen={vi.fn()}
                    onSubmenuClose={vi.fn()}
                    onAction={vi.fn()}
                />
            </ul>
        );
        const submenu = itemContainer.querySelector('.context-submenu');
        expect(parseInt(submenu.style.top, 10)).toBeGreaterThanOrEqual(8);
    });
});
