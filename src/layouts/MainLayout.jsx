import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useTheme } from '../providers/ThemeProvider';
import { useFileSystem } from '../providers/FileSystemProvider';
import { useContextMenu } from '../providers/ContextMenuProvider';
import { useHistory } from '../providers/HistoryProvider';
import { useSettings } from '../providers/SettingsProvider';
import { useSftp } from '../providers/SftpProvider';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { showError, showConfirm, showSuccess } from '../utils/NotificationSystem';
import { getFileType } from '../utils/formatters';

// Core Components
import Sidebar from '../components/sidebar/Sidebar';
import PathBreadcrumb from '../components/explorer/PathBreadcrumb';
import NavigationButtons from '../components/explorer/NavigationButtons';
import FileList from '../components/explorer/FileList';
import DetailsPanel from '../components/explorer/DetailsPanel';
import ContextMenu from '../components/contextMenu/ContextMenu';
import ViewModes from '../components/explorer/ViewModes';
import DualPane from '../components/explorer/DualPane';
import { useTranslation } from '../i18n';

// Additional Components
import CreateFileButton from '../components/explorer/CreateFileButton';
import RenameModal from '../components/common/RenameModal';
import Terminal from '../components/terminal/Terminal';
import TabManager from '../components/tabs/TabManager';
import GlobalSearch from '../components/search/GlobalSearch';
import SettingsPanel from '../components/settings/SettingsPanel';
import ThisPCView from '../components/thisPc/ThisPCView';
import NetworkView from '../components/network/NetworkView';
import TemplateList from '../components/templates/TemplateList';
import PreviewModal from '../components/preview/PreviewModal';

// Hash Modals
import HashFileModal from '../components/common/HashFileModal.jsx';
import HashCompareModal from '../components/common/HashCompareModal.jsx';
import HashDisplayModal from '../components/common/HashDisplayModal.jsx';

// Settings Applier
import SettingsApplier from '../utils/SettingsApplier.js';

// Hooks
import { usePreview } from '../hooks/usePreview';

import '../styles/layouts/mainLayout.css';
import { replaceFileName } from "../utils/pathUtils";

/**
 * MainLayout component that serves as the primary layout structure for the application.
 * Manages UI state, event handling, and renders the main application interface.
 *
 * @returns {JSX.Element} The MainLayout component
 */
const MainLayout = () => {
    const { theme, toggleTheme } = useTheme();
    const { isLoading, currentDirData, selectedItems, loadDirectory, loadVolumes, volumes, focusedItem, setFocusedItem, renameItem: fsRenameItem, selectMultiple, clearSelection } = useFileSystem();
    const { isSftpPath, parseSftpPath, createSftpUrl } = useSftp();
    const { 
        isOpen: isContextMenuOpen, 
        position, 
        items, 
        closeContextMenu, 
        clipboard,
        copyToClipboard,
        cutToClipboard,
        pasteFromClipboard,
        deleteItems,
        renameItem,
        showProperties
    } = useContextMenu();
    const { currentPath, navigateTo, goBack, goForward, canGoBack, canGoForward } = useHistory();
    const { settings, updateSetting } = useSettings();
    const { t } = useTranslation();

    // UI State - Initialize from settings
    const [isDetailsPanelOpen, setIsDetailsPanelOpen] = useState(settings.show_details_panel || false);
    const [isDualPane, setIsDualPane] = useState(() => {
        return localStorage.getItem('explr_dual_pane') === 'true';
    });
    const [isTerminalOpen, setIsTerminalOpen] = useState(false);
    const [viewMode, setViewMode] = useState(settings.default_view || 'grid');
    const [searchValue, setSearchValue] = useState('');
    const [searchResults, setSearchResults] = useState(null);
    const [currentView, setCurrentView] = useState('explorer'); // 'explorer', 'this-pc', 'templates'

    // Modal states
    const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
    const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
    const [itemToRename, setItemToRename] = useState(null);

    // Hash Modal states
    const [isHashFileModalOpen, setIsHashFileModalOpen] = useState(false);
    const [isHashCompareModalOpen, setIsHashCompareModalOpen] = useState(false);
    const [isHashDisplayModalOpen, setIsHashDisplayModalOpen] = useState(false);
    const [hashModalItem, setHashModalItem] = useState(null);
    const [hashDisplayData, setHashDisplayData] = useState({ hash: '', fileName: '' });
    const [columnsPerRow, setColumnsPerRow] = useState(4); // Track columns for preview navigation

    // Refs for keyboard shortcuts to always access fresh state without stale closures
    const selectedItemsRef = useRef(selectedItems);
    selectedItemsRef.current = selectedItems;

    const focusedItemRef = useRef(focusedItem);
    focusedItemRef.current = focusedItem;

    const currentPathRef = useRef(currentPath);
    currentPathRef.current = currentPath;

    const canGoBackRef = useRef(canGoBack);
    canGoBackRef.current = canGoBack;

    const canGoForwardRef = useRef(canGoForward);
    canGoForwardRef.current = canGoForward;

    const isDualPaneRef = useRef(isDualPane);
    isDualPaneRef.current = isDualPane;

    const clipboardRef = useRef(clipboard);
    clipboardRef.current = clipboard;

    const currentViewRef = useRef(currentView);
    currentViewRef.current = currentView;

    // Get terminal height for padding calculations
    const terminalHeight = settings.terminal_height || 240;

    // Get sorted data the same way FileList does
    const getSortedData = useCallback(() => {
        const data = searchResults || currentDirData;
        if (!data || (!data.directories?.length && !data.files?.length)) {
            return [];
        }

        const sortBy = (settings?.sort_by || '').toLowerCase();
        const key = sortBy === 'size'
            ? 'size_in_bytes'
            : (sortBy === 'modified' || sortBy === 'date')
                ? 'last_modified'
                : sortBy === 'type'
                    ? 'type'
                    : 'name';
        const direction = settings?.sort_direction === 'Descending' ? 'desc' : 'asc';

        // Combine directories and files for sorting (same as FileList)
        const combinedItems = [
            ...(data.directories || []).map(dir => ({ ...dir, isDirectory: true })),
            ...(data.files || []).map(file => ({ ...file, isDirectory: false }))
        ];

        // Sort with directories first (same as FileList)
        const sortedItems = [...combinedItems].sort((a, b) => {
            // Directories always come before files
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;

            let aValue, bValue;
            if (key === 'size_in_bytes') {
                aValue = a.isDirectory ? -1 : a.size_in_bytes || 0;
                bValue = b.isDirectory ? -1 : b.size_in_bytes || 0;
            } else if (key === 'type') {
                aValue = (a.isDirectory ? 'Folder' : (a.name ? getFileType(a.name) : '')).toLowerCase();
                bValue = (b.isDirectory ? 'Folder' : (b.name ? getFileType(b.name) : '')).toLowerCase();
            } else if (key === 'last_modified') {
                aValue = new Date(a[key]).getTime();
                bValue = new Date(b[key]).getTime();
            } else {
                aValue = a[key];
                bValue = b[key];
                if (typeof aValue === 'string' && typeof bValue === 'string') {
                    aValue = aValue.toLowerCase();
                    bValue = bValue.toLowerCase();
                }
            }

            if (aValue < bValue) return direction === 'asc' ? -1 : 1;
            if (aValue > bValue) return direction === 'asc' ? 1 : -1;
            return 0;
        });

        return sortedItems;
    }, [searchResults, currentDirData, settings?.sort_by, settings?.sort_direction]);

    // Initialize preview functionality
    const getFocusedItem = useCallback(() => {
        return focusedItemRef.current;
    }, []);

    // 2D Grid navigation functions using sorted data
    const navigateUp = useCallback(() => {
        const sortedItems = getSortedData();
        if (!sortedItems.length) return null;

        const currentIndex = focusedItemRef.current
            ? sortedItems.findIndex(item => item.path === focusedItemRef.current.path)
            : -1;
        if (currentIndex === -1) {
            const firstItem = sortedItems[0];
            focusedItemRef.current = firstItem;
            setFocusedItem(firstItem);
            return firstItem;
        }

        const newIndex = currentIndex - columnsPerRow;
        let targetIndex;
        if (newIndex >= 0) {
            targetIndex = newIndex;
        } else {
            // Wrap to bottom row
            const remainder = currentIndex % columnsPerRow;
            const totalRows = Math.ceil(sortedItems.length / columnsPerRow);
            const lastRowStartIndex = (totalRows - 1) * columnsPerRow;
            targetIndex = Math.min(lastRowStartIndex + remainder, sortedItems.length - 1);
        }

        const targetItem = sortedItems[targetIndex];
        focusedItemRef.current = targetItem;
        setFocusedItem(targetItem);
        return targetItem;
    }, [getSortedData, setFocusedItem, columnsPerRow]);

    const navigateDown = useCallback(() => {
        const sortedItems = getSortedData();
        if (!sortedItems.length) return null;

        const currentIndex = focusedItemRef.current
            ? sortedItems.findIndex(item => item.path === focusedItemRef.current.path)
            : -1;
        if (currentIndex === -1) {
            const firstItem = sortedItems[0];
            focusedItemRef.current = firstItem;
            setFocusedItem(firstItem);
            return firstItem;
        }

        const newIndex = currentIndex + columnsPerRow;
        const targetIndex = newIndex < sortedItems.length
            ? newIndex
            : currentIndex % columnsPerRow;

        const targetItem = sortedItems[targetIndex];
        focusedItemRef.current = targetItem;
        setFocusedItem(targetItem);
        return targetItem;
    }, [getSortedData, setFocusedItem, columnsPerRow]);

    const navigateLeft = useCallback(() => {
        const sortedItems = getSortedData();
        if (!sortedItems.length) return null;

        const currentIndex = focusedItemRef.current
            ? sortedItems.findIndex(item => item.path === focusedItemRef.current.path)
            : -1;
        if (currentIndex === -1) {
            const firstItem = sortedItems[0];
            focusedItemRef.current = firstItem;
            setFocusedItem(firstItem);
            return firstItem;
        }

        let targetIndex;
        if (currentIndex % columnsPerRow === 0) {
            // At leftmost column, wrap to rightmost of same row
            const currentRow = Math.floor(currentIndex / columnsPerRow);
            targetIndex = Math.min((currentRow + 1) * columnsPerRow - 1, sortedItems.length - 1);
        } else {
            targetIndex = currentIndex - 1;
        }

        const targetItem = sortedItems[targetIndex];
        focusedItemRef.current = targetItem;
        setFocusedItem(targetItem);
        return targetItem;
    }, [getSortedData, setFocusedItem, columnsPerRow]);

    const navigateRight = useCallback(() => {
        const sortedItems = getSortedData();
        if (!sortedItems.length) return null;

        const currentIndex = focusedItemRef.current
            ? sortedItems.findIndex(item => item.path === focusedItemRef.current.path)
            : -1;
        if (currentIndex === -1) {
            const firstItem = sortedItems[0];
            focusedItemRef.current = firstItem;
            setFocusedItem(firstItem);
            return firstItem;
        }

        let targetIndex;
        if ((currentIndex + 1) % columnsPerRow === 0 || currentIndex === sortedItems.length - 1) {
            // At rightmost column or last item, wrap to leftmost of same row
            const currentRow = Math.floor(currentIndex / columnsPerRow);
            targetIndex = currentRow * columnsPerRow;
        } else {
            targetIndex = currentIndex + 1;
        }

        const targetItem = sortedItems[targetIndex];
        focusedItemRef.current = targetItem;
        setFocusedItem(targetItem);
        return targetItem;
    }, [getSortedData, setFocusedItem, columnsPerRow]);

    const { 
        open: isPreviewOpen, 
        payload: previewPayload, 
        isLoading: isPreviewLoading,
        closePreview 
    } = usePreview(getFocusedItem, navigateUp, navigateDown, navigateLeft, navigateRight, currentView === 'explorer');

    /**
     * Effect to update UI state when settings change
     */
    useEffect(() => {
        if (settings.show_details_panel !== undefined) {
            setIsDetailsPanelOpen(settings.show_details_panel);
        }
    }, [settings.show_details_panel]);

    /**
     * Effect to update view mode when settings change
     */
    useEffect(() => {
        if (settings.default_view) {
            setViewMode(settings.default_view);
        }
    }, [settings.default_view]);


    /**
     * Effect to load default location on first render
     */
    useEffect(() => {
        if (volumes.length > 0 && !currentDirData && !currentPath) {
            // Show This PC view by default
            setCurrentView('this-pc');
        }
    }, [volumes, currentDirData, currentPath]);

    /**
     * Effect to close details panel when switching to This PC view
     */
    useEffect(() => {
        if (currentView === 'this-pc') {
            setIsDetailsPanelOpen(false);
        }
    }, [currentView]);

    /**
     * Effect to sync current directory with backend search engine context
     */
    useEffect(() => {
        invoke('set_search_current_directory', { path: currentPath || null }).catch(() => {});
    }, [currentPath]);

    /**
     * Effect to auto-start indexing when app loads
     */
    useEffect(() => {
        const initializeSearchEngine = async () => {
            if (!settings?.search_engine_enabled) {
                return;
            }
            if (volumes.length > 0) {
                try {
                    console.log('MainLayout: Checking search engine status for auto-indexing...');
                    
                    // Check if search engine has indexed files
                    const searchEngineInfo = await invoke('get_search_engine_info');
                    const hasNoIndexedFiles = !searchEngineInfo.stats?.trie_size || searchEngineInfo.stats.trie_size === 0;
                    
                    console.log('MainLayout: Search engine info:', searchEngineInfo);
                    console.log('MainLayout: Has no indexed files:', hasNoIndexedFiles);

                    if (hasNoIndexedFiles) {
                        console.log('MainLayout: Starting auto-indexing of home directory...');
                        
                        // Get system info to get the proper home directory
                        const metaDataJson = await invoke('get_meta_data_as_json');
                        const metaData = JSON.parse(metaDataJson);
                        
                        if (!metaData.user_home_dir) {
                            console.error('MainLayout: User home directory not available');
                            return;
                        }

                        console.log('MainLayout: Using home directory:', metaData.user_home_dir);
                        
                        // Auto-index home directory on app startup
                        const result = await invoke('add_paths_recursive_async', {
                            folder: metaData.user_home_dir
                        });
                        
                        console.log('MainLayout: Auto-indexing initiated:', result);
                    } else {
                        console.log('MainLayout: Search engine already has indexed files, skipping auto-indexing');
                    }
                } catch (error) {
                    console.error('MainLayout: Auto-indexing failed:', error);
                    // Don't show error to user as this is background operation
                }
            }
        };

        // Only run when volumes are loaded and search engine is enabled
        if (volumes.length > 0 && settings?.search_engine_enabled) {
            initializeSearchEngine();
        }
    }, [volumes.length, settings?.search_engine_enabled]);

    /**
     * Effect to listen for custom events
     * Improved with debug information
     */
    useEffect(() => {
        /**
         * Handler for opening templates view
         */
        const handleOpenTemplates = () => {
            setCurrentView('templates');
            setIsTemplatesOpen(true);
        };

        /**
         * Handler for showing properties panel
         */
        const handleShowProperties = (e) => {
            setIsDetailsPanelOpen(true);
        };

        /**
         * Handler for opening This PC view
         */
        const handleOpenThisPC = () => {
            setCurrentView('this-pc');
        };

        /**
         * Handler for opening Network view
         */
        const handleOpenNetwork = () => {
            setCurrentView('network');
        };

        /**
         * Handler for opening settings panel
         */
        const handleOpenSettings = () => {
            setIsSettingsOpen(true);
        };

        /**
         * Handler for toggling terminal visibility
         */
        const handleToggleTerminal = () => {
            setIsTerminalOpen(prev => !prev);
        };

        /**
         * Handler for opening rename modal
         * @param {CustomEvent} e - Event with item details
         */
        const handleOpenRenameModal = (e) => {
            if (e.detail && e.detail.item && typeof e.detail.item === 'object') {
                // Close any existing modal first to prevent duplicates
                setIsRenameModalOpen(false);
                setItemToRename(null);
                
                // Small delay to ensure cleanup, then open new modal
                setTimeout(() => {
                    // Double-check the item is still valid before setting it
                    if (e.detail.item && typeof e.detail.item === 'object' && e.detail.item.name) {
                        setItemToRename(e.detail.item);
                        setIsRenameModalOpen(true);
                    }
                }, 10);
            }
        };

        // Improved hash event handlers with debug information
        /**
         * Handler for opening hash file modal
         * @param {CustomEvent} e - Event with item details
         */
        const handleOpenHashFileModal = (e) => {
            console.log('MainLayout: Received open-hash-file-modal event:', e.detail);
            if (e.detail && e.detail.item) {
                console.log('Opening Hash File Modal for:', e.detail.item.name);
                setHashModalItem(e.detail.item);
                setIsHashFileModalOpen(true);
            } else {
                console.log('Invalid event detail:', e.detail);
            }
        };

        /**
         * Handler for opening hash compare modal
         * @param {CustomEvent} e - Event with item details
         */
        const handleOpenHashCompareModal = (e) => {
            console.log('MainLayout: Received open-hash-compare-modal event:', e.detail);
            if (e.detail && e.detail.item) {
                console.log('Opening Hash Compare Modal for:', e.detail.item.name);
                setHashModalItem(e.detail.item);
                setIsHashCompareModalOpen(true);
            } else {
                console.log('Invalid event detail:', e.detail);
            }
        };

        // Hash Display Modal Handler
        const handleOpenHashDisplayModal = (e) => {
            console.log('Opening Hash Display Modal:', e.detail);
            if (e.detail?.hash && e.detail?.fileName) {
                setHashDisplayData({ hash: e.detail.hash, fileName: e.detail.fileName });
                setIsHashDisplayModalOpen(true);
            } else {
                console.log('Invalid hash display event detail:', e.detail);
            }
        };

        // Register event listeners
    document.addEventListener('open-templates', handleOpenTemplates);
    document.addEventListener('show-properties', handleShowProperties);
    document.addEventListener('open-this-pc', handleOpenThisPC);
    document.addEventListener('open-network', handleOpenNetwork);
    document.addEventListener('open-settings', handleOpenSettings);
    document.addEventListener('toggle-terminal', handleToggleTerminal);
    document.addEventListener('open-rename-modal', handleOpenRenameModal);
    document.addEventListener('open-hash-file-modal', handleOpenHashFileModal);
    document.addEventListener('open-hash-compare-modal', handleOpenHashCompareModal);
    document.addEventListener('open-hash-display-modal', handleOpenHashDisplayModal);
    const handleForceExplorerView = () => setCurrentView('explorer');
    document.addEventListener('force-explorer-view', handleForceExplorerView);
    window.addEventListener('force-explorer-view', handleForceExplorerView);

    // Handle external files dragged and dropped into the app window
    let isMounted = true;
    let unlistenTauriDrop = null;
    listen('tauri://drag-drop', async (event) => {
        if (!isMounted) return;
        const paths = event.payload?.paths;
        const targetDir = currentPathRef.current;
        if (!paths || paths.length === 0 || !targetDir) return;

        if (isSftpPath(targetDir)) {
            showError('Drag-and-drop into SFTP directories is not supported');
            return;
        }

        const separator = targetDir.includes('/') ? '/' : '\\';
        let count = 0;
        for (const p of paths) {
            const name = p.split(/[\\/]/).pop();
            const dest = targetDir.endsWith(separator)
                ? `${targetDir}${name}`
                : `${targetDir}${separator}${name}`;
            try {
                await invoke('copy_file_or_dir', { sourcePath: p, destinationPath: dest });
                count++;
            } catch (e) {
                console.error('Failed to copy dropped file:', e);
            }
        }
        if (count > 0 && isMounted) {
            showSuccess(`Copied ${count} item(s)`);
            loadDirectory(targetDir);
        }
    }).then(unlisten => {
        if (!isMounted) {
            unlisten();
        } else {
            unlistenTauriDrop = unlisten;
        }
    }).catch(() => {});

        console.log('MainLayout: All event listeners registered');

        return () => {
            isMounted = false;
            if (unlistenTauriDrop) unlistenTauriDrop();
            document.removeEventListener('open-templates', handleOpenTemplates);
            document.removeEventListener('show-properties', handleShowProperties);
            document.removeEventListener('open-this-pc', handleOpenThisPC);
            document.removeEventListener('open-network', handleOpenNetwork);
            document.removeEventListener('open-settings', handleOpenSettings);
            document.removeEventListener('toggle-terminal', handleToggleTerminal);
            document.removeEventListener('open-rename-modal', handleOpenRenameModal);
            document.removeEventListener('open-hash-file-modal', handleOpenHashFileModal);
            document.removeEventListener('open-hash-compare-modal', handleOpenHashCompareModal);
            document.removeEventListener('open-hash-display-modal', handleOpenHashDisplayModal);
            document.removeEventListener('force-explorer-view', handleForceExplorerView);
            window.removeEventListener('force-explorer-view', handleForceExplorerView);
            console.log('MainLayout: All event listeners removed');
        };
    }, []);

    /**
     * Effect to switch to explorer view when navigating to a directory
     */
    useEffect(() => {
        if (currentPath && currentView !== 'explorer') {
            setCurrentView('explorer');
        }
    }, [currentPath]);

    /**
     * Handles search functionality
     * @param {string} value - The search query
     */
    const handleSearch = useCallback((value) => {
        setSearchValue(value);

        if (!value.trim()) {
            setSearchResults(null);
            return;
        }

        // Simple local search for now
        if (currentDirData) {
            const filteredFiles = currentDirData?.files?.filter(file =>
                file.name.toLowerCase().includes(value.toLowerCase())
            ) || [];

            const filteredDirs = currentDirData?.directories?.filter(dir =>
                dir.name.toLowerCase().includes(value.toLowerCase())
            ) || [];

            setSearchResults({
                directories: filteredDirs,
                files: filteredFiles
            });
        }
    }, [currentDirData]);

    /**
     * Navigates up to the parent directory
     * Handles local paths (Windows / Unix) and SFTP paths
     */
    const handleGoUp = useCallback(() => {
        const path = currentPathRef.current;
        if (!path) return;

        if (isSftpPath(path)) {
            const parsed = parseSftpPath(path);
            if (parsed && parsed.connection && parsed.remotePath && parsed.remotePath !== '.' && parsed.remotePath !== '/') {
                const parts = parsed.remotePath.replace(/\/+$/, '').split('/').filter(Boolean);
                if (parts.length > 1) {
                    parts.pop();
                    const parentRemote = parts.join('/');
                    navigateTo(`sftp:${parsed.connectionName}:${parentRemote}`);
                } else {
                    navigateTo(`sftp:${parsed.connectionName}:.`);
                }
            }
            return;
        }

        const normalized = path.replace(/\//g, '\\');
        // Check Windows root drive (e.g. "C:\" or "C:")
        if (/^[a-zA-Z]:\\?$/.test(normalized)) {
            // Already at drive root
            return;
        }

        if (/^[a-zA-Z]:/.test(normalized)) {
            const parts = normalized.replace(/\\+$/, '').split('\\');
            if (parts.length > 1) {
                parts.pop();
                let parent = parts.join('\\');
                if (/^[a-zA-Z]:$/.test(parent)) {
                    parent += '\\';
                }
                navigateTo(parent);
            }
            return;
        }

        // Unix path
        const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
        if (parts.length > 0) {
            parts.pop();
            const parent = '/' + parts.join('/');
            navigateTo(parent);
        }
    }, [isSftpPath, parseSftpPath, navigateTo]);

    /**
     * Effect to handle keyboard shortcuts
     */
    useEffect(() => {
        const isEditingText = (target) => {
            if (!target) return false;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
                return true;
            }
            if (target.isContentEditable) {
                return true;
            }
            if (target.closest && target.closest('input, textarea, select, [contenteditable="true"], .terminal-input, .xterm, .enhanced-terminal, .details-panel')) {
                return true;
            }
            return false;
        };

        /**
         * Keyboard event handler for shortcuts
         * @param {KeyboardEvent} e - The keyboard event
         */
        const handleKeyDown = (e) => {
            // Global search: Ctrl+Shift+F
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
                e.preventDefault();
                setIsGlobalSearchOpen(true);
                return;
            }

            // Settings: Ctrl+,
            if ((e.ctrlKey || e.metaKey) && e.key === ',') {
                e.preventDefault();
                setIsSettingsOpen(true);
                return;
            }

            // Toggle terminal: Ctrl+`
            if ((e.ctrlKey || e.metaKey) && e.key === '`') {
                e.preventDefault();
                setIsTerminalOpen(prev => !prev);
                return;
            }

            // If user is currently typing in an input/textarea/terminal/details panel, DO NOT intercept editing keys
            if (isEditingText(e.target)) {
                return;
            }

            // Disable explorer shortcuts whenever any modal is open or not in explorer view
            const hasOpenModal = !!document.querySelector('[role="dialog"], .modal-overlay, .preview-modal-backdrop');
            if (hasOpenModal || currentViewRef.current !== 'explorer') {
                return;
            }

            // New folder: Ctrl+Shift+N
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
                e.preventDefault();
                document.dispatchEvent(new CustomEvent('create-folder'));
                return;
            }

            // New file: Ctrl+N
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                document.dispatchEvent(new CustomEvent('create-file'));
                return;
            }

            // F6: Always toggle Dual Pane view on/off
            if (e.key === 'F6' && !e.shiftKey) {
                e.preventDefault();
                setIsDualPane(prev => {
                    const next = !prev;
                    localStorage.setItem('explr_dual_pane', next.toString());
                    return next;
                });
                return;
            }

            // If DualPane is active, let DualPane handle pane-specific navigation/actions
            if (isDualPaneRef.current) {
                return;
            }

            // Delete: Move selected/focused item(s) to trash
            if (e.key === 'Delete') {
                const targetItems = selectedItemsRef.current.length > 0
                    ? selectedItemsRef.current
                    : (focusedItemRef.current ? [focusedItemRef.current] : []);
                if (targetItems.length > 0) {
                    e.preventDefault();
                    deleteItems(targetItems);
                }
                return;
            }

            // Backspace or Alt+ArrowUp: Go to parent folder
            if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
                e.preventDefault();
                handleGoUp();
                return;
            }

            // Navigation history: Alt+ArrowLeft (Back)
            if (e.altKey && e.key === 'ArrowLeft') {
                if (canGoBackRef.current) {
                    e.preventDefault();
                    goBack();
                }
                return;
            }

            // Navigation history: Alt+ArrowRight (Forward)
            if (e.altKey && e.key === 'ArrowRight') {
                if (canGoForwardRef.current) {
                    e.preventDefault();
                    goForward();
                }
                return;
            }

            // Select all: Ctrl+A (respect non-empty text selection)
            if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
                const selectedText = window.getSelection?.()?.toString();
                if (selectedText && selectedText.length > 0) {
                    return;
                }
                e.preventDefault();
                const allItems = getSortedData();
                if (allItems && allItems.length > 0) {
                    selectMultiple(allItems);
                }
                return;
            }

            // Copy: Ctrl+C (respect non-empty text selection)
            if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
                const selectedText = window.getSelection?.()?.toString();
                if (selectedText && selectedText.length > 0) {
                    return;
                }
                const targetItems = selectedItemsRef.current.length > 0
                    ? selectedItemsRef.current
                    : (focusedItemRef.current ? [focusedItemRef.current] : []);
                if (targetItems.length > 0) {
                    e.preventDefault();
                    copyToClipboard(targetItems);
                }
                return;
            }

            // Cut: Ctrl+X
            if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
                const targetItems = selectedItemsRef.current.length > 0
                    ? selectedItemsRef.current
                    : (focusedItemRef.current ? [focusedItemRef.current] : []);
                if (targetItems.length > 0) {
                    e.preventDefault();
                    cutToClipboard(targetItems);
                }
                return;
            }

            // Paste: Ctrl+V
            if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
                if (clipboardRef.current?.items?.length > 0) {
                    e.preventDefault();
                    pasteFromClipboard();
                }
                return;
            }

            // Refresh: F5 or Ctrl+R
            if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) {
                e.preventDefault();
                if (currentPathRef.current) {
                    loadDirectory(currentPathRef.current);
                }
                loadVolumes();
                return;
            }

            // Rename: F2
            if (e.key === 'F2') {
                const target = selectedItemsRef.current.length === 1
                    ? selectedItemsRef.current[0]
                    : (selectedItemsRef.current.length === 0 && focusedItemRef.current ? focusedItemRef.current : null);
                if (target) {
                    e.preventDefault();
                    document.dispatchEvent(new CustomEvent('open-rename-modal', {
                        detail: { item: target }
                    }));
                }
                return;
            }

            // Properties: Alt+Enter
            if (e.altKey && e.key === 'Enter') {
                const target = selectedItemsRef.current.length > 0
                    ? selectedItemsRef.current[0]
                    : focusedItemRef.current;
                if (target) {
                    e.preventDefault();
                    setIsDetailsPanelOpen(prev => !prev);
                }
                return;
            }

            // Escape: Clear selection
            if (e.key === 'Escape') {
                clearSelection();
                document.dispatchEvent(new CustomEvent('clear-selection'));
                return;
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleGoUp, getSortedData, selectMultiple, clearSelection, copyToClipboard, cutToClipboard, pasteFromClipboard, deleteItems, loadDirectory, loadVolumes, goBack, goForward]);

    /**
     * Copies current path to clipboard
     * For SFTP paths, copies the standard URL format
     */
    const copyCurrentPath = useCallback(async () => {
        if (!currentPath) return;

        try {
            let pathToCopy = currentPath;
            
            // For SFTP paths, copy the standard URL format instead of internal format
            if (isSftpPath(currentPath)) {
                const parsed = parseSftpPath(currentPath);
                if (parsed && parsed.connection) {
                    const remotePath = parsed.remotePath || '/';
                    // Ensure path starts with forward slash
                    const formattedPath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
                    pathToCopy = `sftp://${parsed.connection.username}@${parsed.connection.host}:${parsed.connection.port}${formattedPath}`;
                }
            }
            
            await navigator.clipboard.writeText(pathToCopy);
            showSuccess('Path copied to clipboard');
        } catch (error) {
            console.error('Failed to copy path:', error);
            showError('Failed to copy path to clipboard');
        }
    }, [currentPath, isSftpPath, parseSftpPath]);

    /**
     * Handles renaming a file or directory
     * @param {Object} item - The item to rename
     * @param {string} newName - The new name
     */
    const handleRename = async (item, newName) => {
        if (!newName || newName === item.name) {
            return;
        }

        const newPath = replaceFileName(item.path, newName);

        try {
            // Use FileSystemProvider's renameItem which handles both local and SFTP paths
            await fsRenameItem(item.path, newPath);
        } catch (error) {
            console.error('Rename operation failed:', error);
            const message = error?.message || String(error);
            if (message.toLowerCase().includes('already exists')) {
                const shouldCreateCopy = await showConfirm(`A file named "${newName}" already exists. Create a copy instead?`, 'File Exists');
                if (shouldCreateCopy) {
                    const dotIndex = newName.lastIndexOf('.');
                    const copyName = dotIndex > 0
                        ? `${newName.slice(0, dotIndex)} - Copy${newName.slice(dotIndex)}`
                        : `${newName} - Copy`;
                    await handleRename(item, copyName);
                }
            } else {
                showError(`Failed to rename: ${message}`);
            }
        }
    };

    /**
     * Handles view mode change with settings persistence
     * @param {string} newMode - The new view mode
     */
    const handleViewModeChange = useCallback(async (newMode) => {
        setViewMode(newMode);

        // Save via SettingsProvider so settings state stays in sync
        try {
            await updateSetting('default_view', newMode);
        } catch (error) {
            console.error('Failed to save view mode setting:', error);
        }
    }, [updateSetting]);

    /**
     * Handles details panel toggle with settings persistence
     */
    const handleDetailsPanelToggle = useCallback(async () => {
        const newState = !isDetailsPanelOpen;
        setIsDetailsPanelOpen(newState);

        // Save via SettingsProvider so settings state stays in sync
        try {
            await updateSetting('show_details_panel', newState);
        } catch (error) {
            console.error('Failed to save details panel setting:', error);
        }
    }, [isDetailsPanelOpen, updateSetting]);

    /**
     * Handles hidden files visibility toggle with settings persistence
     */
    const handleHiddenFilesToggle = useCallback(async () => {
        const newState = !settings.show_hidden_files_and_folders;
        
        try {
            await updateSetting('show_hidden_files_and_folders', newState);
            // Reload the current directory to reflect the change
            if (currentPath) {
                await loadDirectory(currentPath);
            }
        } catch (error) {
            console.error('Failed to toggle hidden files setting:', error);
        }
    }, [settings.show_hidden_files_and_folders, updateSetting, currentPath, loadDirectory]);

    /**
     * Active selected items (falls back to focusedItem if selectedItems is empty)
     */
    const activeSelectedItems = useMemo(() => {
        if (selectedItems && selectedItems.length > 0) return selectedItems;
        if (focusedItem) return [focusedItem];
        return [];
    }, [selectedItems, focusedItem]);

    /**
     * File operation handlers - use the existing context menu functionality
     */
    const handleCut = useCallback(() => {
        if (activeSelectedItems.length === 0) return;
        cutToClipboard(activeSelectedItems);
    }, [activeSelectedItems, cutToClipboard]);

    const handleCopy = useCallback(() => {
        if (activeSelectedItems.length === 0) return;
        copyToClipboard(activeSelectedItems);
    }, [activeSelectedItems, copyToClipboard]);

    const handlePaste = useCallback(() => {
        if (!clipboard.items || clipboard.items.length === 0) return;
        pasteFromClipboard();
    }, [clipboard.items, pasteFromClipboard]);

    const handleRenameToolbar = useCallback(() => {
        if (activeSelectedItems.length !== 1) return;
        // Directly dispatch the event instead of calling renameItem to avoid conflicts
        document.dispatchEvent(new CustomEvent('open-rename-modal', {
            detail: { item: activeSelectedItems[0] }
        }));
    }, [activeSelectedItems]);

    const handleDelete = useCallback(() => {
        if (activeSelectedItems.length === 0) return;
        deleteItems(activeSelectedItems);
    }, [activeSelectedItems, deleteItems]);

    const handleProperties = useCallback(() => {
        if (activeSelectedItems.length === 0) return;
        // Toggle the details panel: close if open, open if closed
        if (isDetailsPanelOpen) {
            setIsDetailsPanelOpen(false);
        } else {
            showProperties(activeSelectedItems[0]);
            setIsDetailsPanelOpen(true);
        }
    }, [activeSelectedItems, showProperties, isDetailsPanelOpen]);

    /**
     * Effect to clear search when changing directory
     */
    useEffect(() => {
        setSearchValue('');
        setSearchResults(null);
    }, [currentDirData]);

    // Get the data to display
    const displayData = searchResults || currentDirData;

    /**
     * Renders the main content based on current view
     * @returns {JSX.Element} The main content component
     */
    const renderMainContent = () => {
        switch (currentView) {
            case 'this-pc':
                return <ThisPCView />;
            case 'network':
                return <NetworkView />;
            case 'templates':
                return <TemplateList onClose={() => {
                    setCurrentView('explorer');
                    setIsTemplatesOpen(false);
                }} />;
            default:
                return (
                    <div className="files-container">
                        <div className="action-bar">
                            <div className="action-bar-left">
                                <CreateFileButton />
                                
                                <div className="action-divider"></div>
                                
                                <button
                                    className="icon-button"
                                    onClick={handleCut}
                                    disabled={activeSelectedItems.length === 0}
                                    title={t('toolbar.cut')}
                                    aria-label="Cut selected items"
                                >
                                    <span className="icon icon-cut"></span>
                                </button>
                                
                                <button
                                    className="icon-button"
                                    onClick={handleCopy}
                                    disabled={activeSelectedItems.length === 0}
                                    title={t('toolbar.copy')}
                                    aria-label="Copy selected items"
                                >
                                    <span className="icon icon-copy"></span>
                                </button>
                                
                                <button
                                    className="icon-button"
                                    onClick={handlePaste}
                                    disabled={!clipboard.items || clipboard.items.length === 0}
                                    title={t('toolbar.paste')}
                                    aria-label="Paste items"
                                >
                                    <span className="icon icon-paste"></span>
                                </button>
                                
                                <button
                                    className="icon-button"
                                    onClick={handleRenameToolbar}
                                    disabled={activeSelectedItems.length !== 1}
                                    title={t('toolbar.rename')}
                                    aria-label="Rename selected item"
                                >
                                    <span className="icon icon-rename"></span>
                                </button>
                                
                                <button
                                    className="icon-button"
                                    onClick={handleDelete}
                                    disabled={activeSelectedItems.length === 0}
                                    title={t('toolbar.delete')}
                                    aria-label="Delete selected items"
                                >
                                    <span className="icon icon-trash"></span>
                                </button>
                                
                                <button
                                    className="icon-button"
                                    onClick={handleProperties}
                                    disabled={activeSelectedItems.length === 0}
                                    title={t('toolbar.properties')}
                                    aria-label="Show properties"
                                >
                                    <span className="icon icon-properties"></span>
                                </button>
                            </div>

                            <div className="action-bar-right">
                                {currentView === 'explorer' && (
                                    <ViewModes
                                        currentMode={viewMode}
                                        onChange={handleViewModeChange}
                                    />
                                )}

                                <button
                                    className={`icon-button ${isDualPane ? 'active' : ''}`}
                                    onClick={() => {
                                        setIsDualPane(prev => {
                                            const next = !prev;
                                            localStorage.setItem('explr_dual_pane', next.toString());
                                            return next;
                                        });
                                    }}
                                    title={t('dualPane.toggleDualPane')}
                                    aria-label="Toggle dual pane view"
                                >
                                    <span className="icon icon-split-view"></span>
                                </button>
                                
                                <button
                                    className="icon-button"
                                    onClick={toggleTheme}
                                    title={t('toolbar.switchTheme')}
                                    aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
                                >
                                    <span className={`icon ${theme === 'light' ? 'icon-moon' : 'icon-sun'}`}></span>
                                </button>
                                
                                <button
                                    className="icon-button toggle-hidden-files"
                                    onClick={handleHiddenFilesToggle}
                                    title={t('toolbar.toggleHidden')}
                                    aria-label="Toggle hidden files visibility"
                                >
                                    <span className={`icon ${settings.show_hidden_files_and_folders ? 'icon-eye' : 'icon-eye-off'}`}></span>
                                </button>
                                
                                <button
                                    className={`icon-button ${isDetailsPanelOpen ? 'active' : ''}`}
                                    onClick={handleDetailsPanelToggle}
                                    title={t('toolbar.detailsPanel')}
                                    aria-label="Toggle details panel"
                                >
                                    <span className="icon icon-panel-right"></span>
                                </button>
                            </div>
                        </div>

                        {isDualPane ? (
                            <DualPane
                                viewMode={viewMode}
                                isPreviewOpen={isPreviewOpen}
                                onColumnsChange={setColumnsPerRow}
                                onClose={() => {
                                    setIsDualPane(false);
                                    localStorage.setItem('explr_dual_pane', 'false');
                                }}
                            />
                        ) : (
                            <FileList
                                data={displayData}
                                isLoading={isLoading}
                                viewMode={viewMode}
                                isSearching={!!searchValue}
                                searchTerm={searchValue}
                                disableArrowKeys={isPreviewOpen}
                                onColumnsChange={setColumnsPerRow}
                            />
                        )}
                    </div>
                );
        }
    };

    // Removed SFTP event listener - now handled by SftpProvider

    // Removed renderSftpFileList - now handled seamlessly by the regular explorer view

    return (
        <div className={`main-layout ${isTerminalOpen ? 'with-terminal' : ''}`}>
            {/* Settings Applier - applies settings to DOM */}
            <SettingsApplier />

            {/* Full-width tabs at the top */}
            <TabManager>
                {/* Full-width toolbar */}
                <div className="toolbar">
                        <div className="toolbar-left">
                            <NavigationButtons />
                            <PathBreadcrumb
                                onCopyPath={copyCurrentPath}
                                isVisible={currentView === 'explorer'}
                                onSearch={handleSearch}
                            />
                        </div>
                        <div className="toolbar-center">
                        </div>
                        <div className="toolbar-right">
                            <button
                                className="icon-button"
                                onClick={() => setIsGlobalSearchOpen(true)}
                                title={t('toolbar.globalSearch')}
                                aria-label="Global Search"
                            >
                                <span className="icon icon-search-global"></span>
                            </button>
                        </div>
                </div>

                <div className="layout-content">
                    {/* Sidebar */}
                    <Sidebar
                        onTerminalToggle={() => setIsTerminalOpen(!isTerminalOpen)}
                        isTerminalOpen={isTerminalOpen}
                        currentView={currentView}
                    />

                    {/* Main content area */}
                    <div className="content-area">
                        {/* Main content with file list and optional details panel */}
                        <div
                            className="main-content"
                            style={isTerminalOpen ? { paddingBottom: `${terminalHeight}px` } : {}}
                        >
                            {renderMainContent()}

                            {/* Details panel (when selected) */}
                            {isDetailsPanelOpen && (
                                <DetailsPanel
                                    item={activeSelectedItems[0] || null}
                                    isMultipleSelection={activeSelectedItems.length > 1}
                                />
                            )}
                        </div>

                        {/* Terminal positioned absolutely at the bottom */}
                        <div 
                            className="terminal-wrapper"
                            style={{
                                position: isTerminalOpen ? 'absolute' : 'static',
                                bottom: isTerminalOpen ? 0 : 'auto',
                                left: isTerminalOpen ? 0 : 'auto',
                                right: isTerminalOpen ? 0 : 'auto',
                                height: isTerminalOpen ? `${terminalHeight}px` : 0,
                                overflow: isTerminalOpen ? 'visible' : 'hidden'
                            }}
                        >
                            {isTerminalOpen && (
                                <Terminal
                                    isOpen={isTerminalOpen}
                                    onToggle={() => setIsTerminalOpen(!isTerminalOpen)}
                                />
                            )}
                        </div>
                    </div>
                </div>
            </TabManager>

            {/* Context menu */}
            {isContextMenuOpen && (
                <ContextMenu
                    position={position}
                    items={items}
                    onClose={closeContextMenu}
                />
            )}

            {/* Modals */}
            <GlobalSearch
                isOpen={isGlobalSearchOpen}
                onClose={() => setIsGlobalSearchOpen(false)}
            />

            <SettingsPanel
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
            />

            <RenameModal
                isOpen={isRenameModalOpen}
                onClose={() => setIsRenameModalOpen(false)}
                item={itemToRename}
                onRename={handleRename}
            />

            {/* Hash Modals - with debug info */}
            <HashFileModal
                isOpen={isHashFileModalOpen}
                onClose={() => {
                    console.log('Closing Hash File Modal');
                    setIsHashFileModalOpen(false);
                    setHashModalItem(null);
                }}
                item={hashModalItem}
            />

            <HashCompareModal
                isOpen={isHashCompareModalOpen}
                onClose={() => {
                    console.log('Closing Hash Compare Modal');
                    setIsHashCompareModalOpen(false);
                    setHashModalItem(null);
                }}
                item={hashModalItem}
            />

            <HashDisplayModal
                isOpen={isHashDisplayModalOpen}
                onClose={() => {
                    console.log('Closing Hash Display Modal');
                    setIsHashDisplayModalOpen(false);
                    setHashDisplayData({ hash: '', fileName: '' });
                }}
                hash={hashDisplayData.hash}
                fileName={hashDisplayData.fileName}
            />

            {/* Preview Modal */}
            {(isPreviewOpen || isPreviewLoading) && (
                <PreviewModal
                    payload={previewPayload}
                    onClose={closePreview}
                    isLoading={isPreviewLoading}
                />
            )}
        </div>
    );
};

export default MainLayout;