import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const {
    mockInvoke,
    mockSaveDialog,
    mockOpenDialog,
    mockShowConfirm,
    mockShowError,
    mockShowSuccess,
    mockSettingsState,
    mockHistoryState,
    mockFileSystemState,
    mockSftpState,
    mockThemeState
} = vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockSaveDialog: vi.fn(),
    mockOpenDialog: vi.fn(),
    mockShowConfirm: vi.fn(),
    mockShowError: vi.fn(),
    mockShowSuccess: vi.fn(),
    mockSettingsState: {
        settings: {
            darkmode: false,
            default_view: 'grid',
            font_size: 'Medium',
            accent_color: '#0672ef',
            sort_by: 'Name',
            sort_direction: 'Ascending',
            terminal_height: 240,
            default_folder_path_on_opening: ''
        },
        error: null,
        updateSetting: vi.fn(),
        resetSettings: vi.fn(),
        reloadSettings: vi.fn()
    },
    mockHistoryState: {
        currentPath: 'C:\\Work',
        navigateTo: vi.fn()
    },
    mockFileSystemState: {
        volumes: [],
        currentDirData: null,
        loadDirectory: vi.fn(),
        loadVolumes: vi.fn()
    },
    mockSftpState: {
        sftpConnections: [],
        currentSftpConnection: null,
        isSftpPath: vi.fn((p) => typeof p === 'string' && (p.startsWith('sftp:') || p.startsWith('sftp://'))),
        parseSftpPath: vi.fn(() => null),
        createSftpUrl: vi.fn((conn, p) => `sftp:${conn.name}:${p}`),
        createSftpPath: vi.fn((conn, p) => `sftp:${conn.name}:${p}`),
        navigateToSftpConnection: vi.fn(),
        disconnectSftp: vi.fn()
    },
    mockThemeState: {
        theme: 'light',
        setTheme: vi.fn()
    }
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mockInvoke
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    save: mockSaveDialog,
    open: mockOpenDialog
}));

vi.mock('../src/utils/NotificationSystem', () => ({
    showConfirm: mockShowConfirm,
    showError: mockShowError,
    showSuccess: mockShowSuccess
}));

vi.mock('../src/utils/NotificationSystem.js', () => ({
    showConfirm: mockShowConfirm,
    showError: mockShowError,
    showSuccess: mockShowSuccess
}));

vi.mock('../src/providers/SettingsProvider', () => ({
    useSettings: () => mockSettingsState
}));

vi.mock('../src/providers/ThemeProvider', () => ({
    useTheme: () => mockThemeState
}));

vi.mock('../src/providers/HistoryProvider', () => ({
    useHistory: () => mockHistoryState
}));

vi.mock('../src/providers/FileSystemProvider', () => ({
    useFileSystem: () => mockFileSystemState
}));

vi.mock('../src/providers/SftpProvider', () => ({
    useSftp: () => mockSftpState
}));

vi.mock('../src/providers/ContextMenuProvider', () => ({
    useContextMenu: () => ({ removeFromFavorites: vi.fn() })
}));

vi.mock('../src/i18n', () => ({
    useTranslation: () => ({
        t: (key) => key,
        language: 'en',
        setLanguage: vi.fn()
    })
}));

vi.mock('../src/utils/fileOperations', () => ({
    getTemplatePaths: vi.fn().mockResolvedValue(['/templates/starter']),
    useTemplate: vi.fn().mockRejectedValue(new Error('Permission denied')),
    addTemplate: vi.fn().mockResolvedValue(true),
    removeTemplate: vi.fn().mockResolvedValue(true)
}));

import Modal from '../src/components/common/Modal';
import HashFileModal from '../src/components/common/HashFileModal';
import HashDisplayModal from '../src/components/common/HashDisplayModal';
import HashCompareModal from '../src/components/common/HashCompareModal';
import RenameModal from '../src/components/common/RenameModal';
import SettingsPanel from '../src/components/settings/SettingsPanel';
import TemplateItem from '../src/components/templates/TemplateItem';
import TemplateList from '../src/components/templates/TemplateList';
import AddSftpConnectionView from '../src/components/sidebar/AddSftpConnectionView';
import Sidebar from '../src/components/sidebar/Sidebar';
import NetworkView from '../src/components/network/NetworkView';
import ThisPCView from '../src/components/thisPc/ThisPCView';
import PathBreadcrumb from '../src/components/explorer/PathBreadcrumb';

describe('Wave 4 UI & Modals (TP-FE-UI-01, TP-FE-UI-03, TP-FE-UI-14..16)', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        vi.clearAllMocks();
        document.body.style.overflow = '';
        mockHistoryState.currentPath = 'C:\\Work';
        mockFileSystemState.volumes = [];
        mockFileSystemState.loadDirectory.mockResolvedValue(true);
        mockFileSystemState.loadVolumes.mockResolvedValue([]);
        mockInvoke.mockResolvedValue(JSON.stringify({
            current_running_os: 'windows',
            user_home_dir: 'C:\\Users\\Test'
        }));
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    test('TP-FE-UI-01: corrupted JSON in localStorage does not crash Sidebar or NetworkView', async () => {
        localStorage.setItem('sidebarSectionsCollapsed', '{bad json');
        localStorage.setItem('fileExplorerFavorites', '{bad json');
        localStorage.setItem('fileExplorerSftpConnections', 'not-json[');

        render(<Sidebar onTerminalToggle={vi.fn()} isTerminalOpen={false} currentView="explorer" />);
        render(<NetworkView />);

        expect(screen.getByText('No favorites added')).toBeInTheDocument();
        expect(screen.getAllByText('No SFTP connections').length).toBeGreaterThan(0);
    });

    test('TP-FE-UI-03: TemplateItem does not render literal 0 for size: 0 and TemplateList keeps list on applyTemplate error', async () => {
        const { container } = render(
            <TemplateItem
                template={{ name: 'EmptyTemplate', path: '/templates/empty', type: 'folder', size: 0 }}
                onUse={vi.fn()}
                onRemove={vi.fn()}
            />
        );
        expect(container.querySelector('.template-meta')?.textContent).not.toContain('0');
        cleanup();

        render(<TemplateList />);
        const useButton = await screen.findByText('Use');
        fireEvent.click(useButton);

        const destInput = screen.getByLabelText('Destination');
        fireEvent.change(destInput, { target: { value: '   ' } });
        expect(screen.getByText('Apply Template')).toBeDisabled();

        fireEvent.change(destInput, { target: { value: 'C:\\Dest' } });
        fireEvent.click(screen.getByText('Apply Template'));

        await waitFor(() => {
            expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining('Failed to apply template'));
        });
        expect(screen.getByText('starter')).toBeInTheDocument();
    });

    test('TP-FE-UI-14: SettingsPanel Save calls onClose, uses SortBy Date, ignores NaN and clamps terminal_height', () => {
        const onClose = vi.fn();
        render(<SettingsPanel isOpen={true} onClose={onClose} />);

        fireEvent.click(screen.getByText('common.save'));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mockSettingsState.reloadSettings).not.toHaveBeenCalled();

        fireEvent.click(screen.getByText('settings.behavior'));
        expect(screen.getByRole('option', { name: 'Date Modified' })).toHaveAttribute('value', 'Date');

        fireEvent.click(screen.getByText('settings.advanced'));
        const heightInput = screen.getByDisplayValue('240');
        fireEvent.change(heightInput, { target: { value: '' } });
        expect(mockSettingsState.updateSetting).not.toHaveBeenCalledWith('terminal_height', NaN);

        fireEvent.change(heightInput, { target: { value: '9999' } });
        expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('terminal_height', 600);
    });

    test('TP-FE-UI-15a: nested Modals close only topmost on Escape and preserve body overflow until last closes', () => {
        const onCloseOuter = vi.fn();
        const onCloseInner = vi.fn();

        const { rerender } = render(
            <>
                <Modal isOpen={true} onClose={onCloseOuter} title="Outer">
                    <div>Outer body</div>
                </Modal>
                <Modal isOpen={true} onClose={onCloseInner} title="Inner">
                    <div>Inner body</div>
                </Modal>
            </>
        );

        expect(document.body.style.overflow).toBe('hidden');
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCloseInner).toHaveBeenCalledTimes(1);
        expect(onCloseOuter).not.toHaveBeenCalled();

        rerender(
            <>
                <Modal isOpen={true} onClose={onCloseOuter} title="Outer">
                    <div>Outer body</div>
                </Modal>
                <Modal isOpen={false} onClose={onCloseInner} title="Inner">
                    <div>Inner body</div>
                </Modal>
            </>
        );
        expect(document.body.style.overflow).toBe('hidden');

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCloseOuter).toHaveBeenCalledTimes(1);
    });

    test('TP-FE-UI-15b: HashDisplayModal rapid unmount does not throw and HashCompareModal extracts longest hex hash', async () => {
        vi.useFakeTimers();
        const { unmount } = render(
            <HashDisplayModal isOpen={true} onClose={vi.fn()} hash="abcdef1234567890" fileName="test.txt" />
        );
        unmount();
        act(() => {
            vi.advanceTimersByTime(150);
        });
        vi.useRealTimers();

        render(
            <HashCompareModal
                isOpen={true}
                onClose={vi.fn()}
                item={{ name: 'test.txt', path: 'C:\\Work\\test.txt' }}
            />
        );
        const textarea = screen.getByLabelText('Hash value to compare:');
        fireEvent.paste(textarea, {
            target: { value: 'SHA256 (test.txt) = A1B2C3D4E5F60708\n' }
        });
        await waitFor(() => {
            expect(textarea).toHaveValue('a1b2c3d4e5f60708');
        });
    });

    test('TP-FE-UI-15c: HashFileModal rejects path separators and RenameModal handles dotfiles and awaits onRename', async () => {
        mockHistoryState.currentPath = null;
        mockSaveDialog.mockResolvedValue('C:\\Temp\\out.hash');
        mockInvoke.mockResolvedValue('deadbeef12345678');

        const onCloseHash = vi.fn();
        render(
            <HashFileModal
                isOpen={true}
                onClose={onCloseHash}
                item={{ name: 'file.txt', path: 'sftp:conn:./file.txt' }}
            />
        );
        const hashInput = screen.getByLabelText('Hash file name:');
        fireEvent.change(hashInput, { target: { value: '..\\bad.hash' } });
        fireEvent.click(screen.getByText('Generate Hash'));
        expect(mockShowError).toHaveBeenCalledWith('File name cannot contain "/" or "\\"');

        fireEvent.change(hashInput, { target: { value: 'good.hash' } });
        fireEvent.click(screen.getByText('Generate Hash'));
        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('gen_hash_and_save_to_file', {
                sourcePath: 'sftp:conn:./file.txt',
                outputPath: 'C:\\Temp\\out.hash'
            });
        });

        const onCloseRename = vi.fn();
        const onRename = vi.fn().mockResolvedValue(false);
        render(
            <RenameModal
                isOpen={true}
                onClose={onCloseRename}
                item={{ name: '.gitignore', isDirectory: false }}
                onRename={onRename}
            />
        );
        const renameInput = screen.getByLabelText('File name:');
        fireEvent.change(renameInput, { target: { value: '.env' } });
        fireEvent.click(screen.getByText('Rename'));
        await waitFor(() => {
            expect(onRename).toHaveBeenCalledWith({ name: '.gitignore', isDirectory: false }, '.env');
        });
        expect(onCloseRename).not.toHaveBeenCalled();
    });

    test('TP-FE-UI-16: AddSftpConnectionView validates name/port and stores credentials securely, PathBreadcrumb parses UNC, and ThisPCView uses eject_volume', async () => {
        const onAdd = vi.fn();
        render(
            <AddSftpConnectionView
                isOpen={true}
                onClose={vi.fn()}
                onAdd={onAdd}
                existingConnections={[{ name: 'existing', host: 'h', port: 22, username: 'u' }]}
            />
        );

        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'bad:name' } });
        fireEvent.change(screen.getByLabelText('IP / Host'), { target: { value: 'example.com' } });
        fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
        fireEvent.click(screen.getByText('Add'));
        expect(screen.getByText('Connection name cannot contain ":"')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'existing' } });
        fireEvent.click(screen.getByText('Add'));
        expect(screen.getByText('A connection named "existing" already exists')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod' } });
        fireEvent.change(screen.getByLabelText('Port'), { target: { value: '99999' } });
        fireEvent.click(screen.getByText('Add'));
        expect(screen.getByText('Port must be a number between 1 and 65535')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Port'), { target: { value: '2222' } });
        mockInvoke.mockResolvedValueOnce(undefined);
        fireEvent.click(screen.getByText('Add'));

        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('store_sftp_credentials', {
                connectionKey: 'alice@example.com:2222',
                password: 'secret123'
            });
            expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({
                name: 'prod',
                host: 'example.com',
                port: 2222,
                username: 'alice'
            }));
        });

        mockHistoryState.currentPath = '\\\\server\\share\\docs';
        render(<PathBreadcrumb />);
        expect(screen.getByText('\\\\server\\share')).toBeInTheDocument();
        expect(screen.getByText('docs')).toBeInTheDocument();

        mockFileSystemState.volumes = [
            {
                mount_point: 'E:\\',
                volume_name: 'USB',
                file_system: 'FAT32',
                size: 0,
                available_space: 0,
                is_removable: true
            }
        ];
        mockShowConfirm.mockResolvedValue(true);
        render(<ThisPCView />);
        const ejectBtn = await screen.findByTitle('Safely eject');
        fireEvent.click(ejectBtn);
        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('eject_volume', { mountPoint: 'E:\\' });
        });
    });

    test('AddSftpConnectionView allows guest access without username/password and ignores drag-out overlay click', async () => {
        const onAdd = vi.fn();
        const onClose = vi.fn();
        render(<AddSftpConnectionView isOpen={true} onClose={onClose} onAdd={onAdd} />);

        const nameInput = screen.getByLabelText('Name');
        const overlay = document.querySelector('.modal-overlay');
        fireEvent.mouseDown(nameInput);
        fireEvent.click(overlay);
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.change(nameInput, { target: { value: 'guest-nas' } });
        fireEvent.change(screen.getByLabelText('IP / Host'), { target: { value: '192.168.1.50' } });

        const testBtn = screen.getByText('Test Connection');
        const addBtn = screen.getByText('Add');
        expect(testBtn).not.toBeDisabled();
        expect(addBtn).not.toBeDisabled();

        fireEvent.click(addBtn);
        await waitFor(() => {
            expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({
                name: 'guest-nas',
                host: '192.168.1.50',
                port: 22,
                username: ''
            }));
        });
        expect(mockInvoke).not.toHaveBeenCalledWith('store_sftp_credentials', expect.anything());
    });
});
