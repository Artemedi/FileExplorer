import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useHistory } from './HistoryProvider';
import { useSettings } from './SettingsProvider';
import { useSftp } from './SftpProvider';
import { getDirectoryPath, getFileName, normalizePath } from '../utils/pathUtils';
import { formatErrorMessage } from '../utils/formatters';
import { showError } from '../utils/NotificationSystem';

// Create file system context
export const FileSystemContext = createContext(null);

const isPathOrDescendant = (candidatePath, targetPath) => {
    if (!candidatePath || !targetPath) return false;
    if (candidatePath === targetPath) return true;
    const normCandidate = normalizePath(candidatePath);
    const normTarget = normalizePath(targetPath);
    if (normCandidate === normTarget) return true;
    return (
        normCandidate.startsWith(`${normTarget}/`) ||
        normCandidate.startsWith(`${normTarget}\\`)
    );
};

const isSameDirectoryPath = (a, b) => {
    if (!a || !b) return false;
    const normA = normalizePath(a);
    const normB = normalizePath(b);
    if (normA === normB) return true;
    // Windows drive paths are case-insensitive
    if (/^[A-Za-z]:[/\\]/.test(normA) || normA.startsWith('\\\\')) {
        return normA.toLowerCase() === normB.toLowerCase();
    }
    return false;
};

export default function FileSystemProvider({ children }) {
    const [rawDirData, setRawDirData] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedItems, setSelectedItems] = useState([]);
    const [focusedItem, setFocusedItem] = useState(null);
    const [volumes, setVolumes] = useState([]);
    const [error, setError] = useState(null);

    const lastLoadedPathRef = useRef(null);
    const loadRequestIdRef = useRef(0);
    const activeMountTokenRef = useRef(0);
    const watchedPathRef = useRef(null);
    const initInFlightRef = useRef(false);

    const { navigateTo, revertToPath, currentPath } = useHistory();
    const { settings } = useSettings();
    const {
        isSftpPath,
        loadSftpDirectory,
        createSftpFile,
        createSftpDirectory,
        deleteSftpItem,
        renameSftpItem,
        downloadAndOpenSftpFile
    } = useSftp();

    // Derive filtered directory data without triggering extra IPC reloads
    const currentDirData = useMemo(() => {
        if (!rawDirData) return rawDirData;
        if (settings.show_hidden_files_and_folders) {
            return rawDirData;
        }
        return {
            ...rawDirData,
            directories: rawDirData.directories
                ? rawDirData.directories.filter(dir => !dir.name.startsWith('.'))
                : [],
            files: rawDirData.files
                ? rawDirData.files.filter(file => !file.name.startsWith('.'))
                : [],
        };
    }, [rawDirData, settings.show_hidden_files_and_folders]);

    // Load system volumes information
    const loadVolumes = useCallback(async () => {
        try {
            const volumesJson = await invoke('get_system_volumes_information_as_json');
            const volumesData = JSON.parse(volumesJson);
            const list = Array.isArray(volumesData) ? volumesData : [];
            setVolumes(list);
            return list;
        } catch (err) {
            console.error('Failed to load volumes:', err);
            setError(`Failed to load volumes: ${formatErrorMessage(err)}`);
            setVolumes([]);
            return [];
        }
    }, []);

    // Load directory contents - enhanced with SFTP support and stale-request protection
    const loadDirectory = useCallback(async (path, options = {}) => {
        const silent = Boolean(options?.silent);
        if (!path) {
            console.error('Cannot load directory: path is empty');
            if (!silent) setIsLoading(false);
            return false;
        }

        const requestId = ++loadRequestIdRef.current;
        let timeoutId = null;

        console.log(`Attempting to load directory: ${path}`);
        if (!silent) {
            setIsLoading(true);
        }
        setError(null);

        try {
            // Check if it's an SFTP path
            if (isSftpPath(path)) {
                console.log(`Loading SFTP directory: ${path}`);
                const sftpData = await loadSftpDirectory(path);
                if (requestId !== loadRequestIdRef.current) {
                    return false;
                }
                if (sftpData) {
                    setRawDirData(sftpData);
                    lastLoadedPathRef.current = path;
                    navigateTo(path);
                    if (watchedPathRef.current) {
                        watchedPathRef.current = null;
                        invoke('unwatch_directory').catch(() => {});
                    }
                    console.log(`Successfully loaded SFTP directory: ${path}`);
                    return true;
                } else {
                    throw new Error('Failed to load SFTP directory');
                }
            }

            // Regular file system path
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error(`Directory loading timed out: ${path}`)),
                    10000
                );
            });

            const loadPromise = invoke('open_directory', { path });
            const dirContent = await Promise.race([loadPromise, timeoutPromise]);

            if (requestId !== loadRequestIdRef.current) {
                return false;
            }

            if (!dirContent) {
                throw new Error(`Empty response from open_directory: ${path}`);
            }

            let dirData;
            try {
                dirData = JSON.parse(dirContent);
            } catch (parseError) {
                throw new Error(`Failed to parse directory data: ${parseError.message}`);
            }

            if (requestId !== loadRequestIdRef.current) {
                return false;
            }

            setRawDirData(dirData);
            lastLoadedPathRef.current = path;
            navigateTo(path);
            watchedPathRef.current = path;
            invoke('watch_directory', { path }).catch((err) => {
                console.warn(`Failed to watch directory: ${path}`, err);
            });
            console.log(`Successfully loaded directory: ${path}`);
            return true;
        } catch (err) {
            if (requestId !== loadRequestIdRef.current) {
                return false;
            }

            console.error(`Failed to load directory: ${path}`, err);

            const errorMessage = formatErrorMessage(err);
            if (errorMessage.toLowerCase().includes('permission denied') || errorMessage.toLowerCase().includes('unauthorized')) {
                const folderName = getFileName(path) || path;
                const isUserDir = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music'].some(dir =>
                    path.toLowerCase().includes(dir.toLowerCase())
                );

                if (isUserDir) {
                    setError(`Access denied to "${folderName}". This app needs permission to access your ${folderName} folder. Please grant permission in System Preferences > Security & Privacy > Privacy > Files and Folders.`);
                } else {
                    setError(`Permission denied: Cannot access "${folderName}". You may need to grant additional permissions to this application.`);
                }
            } else {
                setError(`Failed to load directory: ${errorMessage}`);
            }
            return false;
        } finally {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
            if (!silent && requestId === loadRequestIdRef.current) {
                setIsLoading(false);
            }
        }
    }, [navigateTo, isSftpPath, loadSftpDirectory]);

    const getDefaultDirectory = useCallback(async () => {
        setIsLoading(true);

        try {
            try {
                const initialCliPath = await invoke('get_initial_cli_path');
                if (initialCliPath) {
                    console.log(`Using initial CLI path: ${initialCliPath}`);
                    return initialCliPath;
                }
            } catch (cliErr) {
                console.warn('Could not retrieve CLI path:', cliErr);
            }

            if (settings.default_folder_path_on_opening && settings.default_folder_path_on_opening.trim()) {
                return settings.default_folder_path_on_opening.trim();
            }

            console.log('Attempting to load volumes...');
            const volumesList = await loadVolumes();

            if (volumesList && volumesList.length > 0) {
                console.log(`Found volumes, using first mount point: ${volumesList[0].mount_point}`);
                return volumesList[0].mount_point;
            }

            console.warn('No volumes available, trying common paths instead');
            const commonPaths = ['C:\\', '/Users', '/home'];

            for (const path of commonPaths) {
                console.log(`Checking if path is accessible: ${path}`);
                try {
                    const result = await invoke('open_directory', { path });
                    if (result) {
                        console.log(`Successfully found accessible path: ${path}`);
                        return path;
                    }
                } catch {
                    console.log(`Path ${path} not accessible`);
                }
            }

            console.warn('All paths failed, using hardcoded default');
            return '/';
        } catch (err) {
            console.error('Error in getDefaultDirectory:', err);
            return '/';
        }
    }, [loadVolumes, settings.default_folder_path_on_opening]);

    const initializeFirstDirectory = useCallback(async () => {
        if (initInFlightRef.current) return;
        initInFlightRef.current = true;
        console.log('Initializing first directory...');

        const timeoutId = setTimeout(() => {
            console.error('Directory initialization timed out');
            setIsLoading(false);
            setError('Failed to initialize directory within the time limit');
        }, 10000);

        try {
            const defaultDir = await getDefaultDirectory();
            console.log(`Got default directory: ${defaultDir}`);

            const reqBefore = loadRequestIdRef.current;
            const success = await loadDirectory(defaultDir);

            if (!success && loadRequestIdRef.current === reqBefore + 1) {
                console.warn('First directory load failed, trying fallbacks...');
                const fallbacks = ['/', 'C:\\', '/tmp'];

                for (const fallback of fallbacks) {
                    if (fallback !== defaultDir) {
                        const fallbackReqBefore = loadRequestIdRef.current;
                        console.log(`Trying fallback directory: ${fallback}`);
                        if (await loadDirectory(fallback)) {
                            console.log(`Successfully loaded fallback directory: ${fallback}`);
                            break;
                        }
                        if (loadRequestIdRef.current !== fallbackReqBefore + 1) {
                            break;
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Failed to initialize directory:', err);
            setError('Failed to load any directory. Please check file system permissions.');
        } finally {
            initInFlightRef.current = false;
            clearTimeout(timeoutId);
            setIsLoading(false);
        }
    }, [getDefaultDirectory, loadDirectory]);

    // Initialize only when no directory or restored history path exists
    useEffect(() => {
        if (!rawDirData && !currentPath) {
            console.log('No directory data or current path, initializing first directory...');
            initializeFirstDirectory();
        }
    }, [initializeFirstDirectory, rawDirData, currentPath]);

    const currentPathRef = useRef(currentPath);
    useEffect(() => {
        currentPathRef.current = currentPath;
    }, [currentPath]);

    const loadDirectoryRef = useRef(loadDirectory);
    useEffect(() => {
        loadDirectoryRef.current = loadDirectory;
    }, [loadDirectory]);

    const isSftpPathRef = useRef(isSftpPath);
    useEffect(() => {
        isSftpPathRef.current = isSftpPath;
    }, [isSftpPath]);

    const autoRefreshRef = useRef(settings.auto_refresh_dir !== false);
    useEffect(() => {
        autoRefreshRef.current = settings.auto_refresh_dir !== false;
    }, [settings.auto_refresh_dir]);

    // Live directory update via file watcher (StrictMode-safe cleanup)
    useEffect(() => {
        let isMounted = true;
        let unlisten = null;
        let debounceTimer = null;
        const mountToken = ++activeMountTokenRef.current;

        const setupWatcher = async () => {
            try {
                const fn = await listen('fs-change', () => {
                    if (!autoRefreshRef.current) return;
                    if (debounceTimer) {
                        clearTimeout(debounceTimer);
                    }
                    debounceTimer = setTimeout(() => {
                        const targetPath = currentPathRef.current;
                        if (targetPath && !isSftpPathRef.current(targetPath)) {
                            console.log(`Auto-refreshing directory after fs-change: ${targetPath}`);
                            loadDirectoryRef.current(targetPath, { silent: true });
                        }
                    }, 250);
                });
                if (isMounted) {
                    unlisten = fn;
                } else {
                    fn();
                }
            } catch (err) {
                console.warn('Failed to listen to fs-change events:', err);
            }
        };

        setupWatcher();

        return () => {
            isMounted = false;
            if (debounceTimer) clearTimeout(debounceTimer);
            if (unlisten) unlisten();
            // Defer unwatch so React 19 StrictMode synchronous remount increments activeMountTokenRef first
            setTimeout(() => {
                if (activeMountTokenRef.current === mountToken && watchedPathRef.current) {
                    watchedPathRef.current = null;
                    invoke('unwatch_directory').catch(() => {});
                }
            }, 0);
        };
    }, []);

    // Open a file - enhanced with SFTP support
    const openFile = useCallback(async (filePath) => {
        setError(null);

        try {
            if (isSftpPath(filePath)) {
                await downloadAndOpenSftpFile(filePath);
            } else {
                await invoke('open_in_default_app', { path: filePath });
            }
        } catch (err) {
            console.error(`Failed to open file: ${filePath}`, err);
            const msg = formatErrorMessage(err);
            setError(`Failed to open file: ${msg}`);
            showError(`Failed to open file: ${msg}`);
        }
    }, [isSftpPath, downloadAndOpenSftpFile]);

    // Create a new file - enhanced with SFTP support
    const createFile = useCallback(async (folderPath, fileName) => {
        setIsLoading(true);
        setError(null);

        try {
            if (isSftpPath(folderPath)) {
                const success = await createSftpFile(folderPath, fileName);
                if (success) {
                    await loadDirectory(folderPath);
                }
                return success;
            } else {
                await invoke('create_file', {
                    folderPathAbs: folderPath,
                    fileName: fileName
                });
                if (!currentPath || isSameDirectoryPath(folderPath, currentPath)) {
                    await loadDirectory(folderPath);
                }
                return true;
            }
        } catch (err) {
            console.error(`Failed to create file: ${fileName}`, err);
            const msg = formatErrorMessage(err);
            setError(`Failed to create file: ${msg}`);
            throw new Error(msg);
        } finally {
            setIsLoading(false);
        }
    }, [loadDirectory, isSftpPath, createSftpFile, currentPath]);

    // Create a new directory - enhanced with SFTP support
    const createDirectory = useCallback(async (folderPath, directoryName) => {
        setIsLoading(true);
        setError(null);

        try {
            if (isSftpPath(folderPath)) {
                const success = await createSftpDirectory(folderPath, directoryName);
                if (success) {
                    await loadDirectory(folderPath);
                }
                return success;
            } else {
                await invoke('create_directory', {
                    folderPathAbs: folderPath,
                    folderName: directoryName
                });
                if (!currentPath || isSameDirectoryPath(folderPath, currentPath)) {
                    await loadDirectory(folderPath);
                }
                return true;
            }
        } catch (err) {
            console.error(`Failed to create directory: ${directoryName}`, err);
            const msg = formatErrorMessage(err);
            setError(`Failed to create directory: ${msg}`);
            throw new Error(msg);
        } finally {
            setIsLoading(false);
        }
    }, [loadDirectory, isSftpPath, createSftpDirectory, currentPath]);

    // Rename an item - enhanced with SFTP support
    const renameItem = useCallback(async (oldPath, newPath) => {
        setIsLoading(true);
        setError(null);

        try {
            console.log(`FileSystemProvider: Renaming "${oldPath}" -> "${newPath}"`);

            if (isSftpPath(oldPath)) {
                const pathParts = newPath.split('/');
                const newName = pathParts[pathParts.length - 1];
                const success = await renameSftpItem(oldPath, newName);
                if (success && currentPath) {
                    await loadDirectory(currentPath);
                }
                return success;
            } else {
                await invoke('rename', { oldPath, newPath });
                const dirPath = getDirectoryPath(oldPath);
                if (currentPath && isSameDirectoryPath(dirPath, currentPath)) {
                    await loadDirectory(currentPath);
                } else if (!currentPath && dirPath) {
                    await loadDirectory(dirPath);
                }
                return true;
            }
        } catch (err) {
            console.error(`Failed to rename item: ${oldPath}`, err);
            const msg = formatErrorMessage(err);
            setError(`Failed to rename item: ${msg}`);
            throw new Error(msg);
        } finally {
            setIsLoading(false);
        }
    }, [loadDirectory, isSftpPath, renameSftpItem, currentPath]);

    // Move item to trash - enhanced with SFTP support and optional skipReload for batch deletes
    const moveToTrash = useCallback(async (path, options = {}) => {
        const skipReload = Boolean(options?.skipReload);
        setIsLoading(true);
        setError(null);

        try {
            if (isSftpPath(path)) {
                const success = await deleteSftpItem(path);
                if (success) {
                    if (!skipReload && currentPath) {
                        await loadDirectory(currentPath);
                    }
                    setSelectedItems(prev => prev.filter(item => !isPathOrDescendant(item.path, path)));
                }
                return success;
            } else {
                await invoke('move_to_trash', { path });
                const dirPath = getDirectoryPath(path);
                if (!skipReload) {
                    if (currentPath && isSameDirectoryPath(dirPath, currentPath)) {
                        await loadDirectory(currentPath);
                    } else if (!currentPath && dirPath) {
                        await loadDirectory(dirPath);
                    }
                }
                setSelectedItems(prev => prev.filter(item => !isPathOrDescendant(item.path, path)));
                return true;
            }
        } catch (err) {
            console.error(`Failed to move item to trash: ${path}`, err);
            const msg = formatErrorMessage(err);
            setError(`Failed to move item to trash: ${msg}`);
            showError(`Failed to move item to trash: ${msg}`);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [loadDirectory, isSftpPath, deleteSftpItem, currentPath]);

    // Zip selected items
    const zipItems = useCallback(async (sourcePaths, destinationPath = null) => {
        setIsLoading(true);
        setError(null);

        try {
            await invoke('zip', {
                sourcePaths,
                destinationPath
            });

            if (currentPath) {
                await loadDirectory(currentPath);
            }
            return true;
        } catch (err) {
            console.error('Failed to create zip:', err);
            const msg = formatErrorMessage(err);
            setError(`Failed to create zip: ${msg}`);
            showError(`Failed to create zip: ${msg}`);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [currentPath, loadDirectory]);

    // Unzip an item
    const unzipItem = useCallback(async (zipPath, destinationPath = null) => {
        setIsLoading(true);
        setError(null);

        try {
            await invoke('unzip', {
                zipPaths: [zipPath],
                destinationPath
            });

            if (currentPath) {
                await loadDirectory(currentPath);
            }
            return true;
        } catch (err) {
            console.error(`Failed to extract zip: ${zipPath}`, err);
            const msg = formatErrorMessage(err);
            setError(`Failed to extract zip: ${msg}`);
            showError(`Failed to extract zip: ${msg}`);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [currentPath, loadDirectory]);

    // Select an item
    const selectItem = useCallback((item, isMultiSelect = false) => {
        setSelectedItems(prevSelected => {
            const isAlreadySelected = prevSelected.some(
                selected => selected.path === item.path
            );

            if (isAlreadySelected) {
                return isMultiSelect
                    ? prevSelected.filter(selected => selected.path !== item.path)
                    : [item];
            } else {
                return isMultiSelect ? [...prevSelected, item] : [item];
            }
        });
    }, []);

    // Select multiple items at once
    const selectMultiple = useCallback((items) => {
        setSelectedItems(items);
    }, []);

    // Clear selection
    const clearSelection = useCallback(() => {
        setSelectedItems([]);
        setFocusedItem(null);
    }, []);

    // Set focused item (for keyboard navigation and preview)
    const setFocusedItemCallback = useCallback((item) => {
        setFocusedItem(item);
    }, []);

    // Load volumes on mount
    useEffect(() => {
        loadVolumes();
    }, [loadVolumes]);

    // Listen for open-path requests from single-instance launches
    useEffect(() => {
        let isMounted = true;
        let unlisten = null;
        listen('open-path-requested', (event) => {
            if (event.payload) {
                console.log('Received open-path-requested:', event.payload);
                loadDirectory(event.payload);
                window.dispatchEvent(new CustomEvent('force-explorer-view'));
            }
        }).then(fn => {
            if (isMounted) {
                unlisten = fn;
            } else {
                fn();
            }
        });

        return () => {
            isMounted = false;
            if (unlisten) unlisten();
        };
    }, [loadDirectory]);

    // Reload current directory when navigating back/forward or restoring from sessionStorage
    useEffect(() => {
        if (currentPath && lastLoadedPathRef.current !== currentPath) {
            const targetPath = currentPath;
            loadDirectory(targetPath).then((ok) => {
                if (!ok && lastLoadedPathRef.current && currentPathRef.current === targetPath) {
                    revertToPath(lastLoadedPathRef.current);
                }
            });
        }
    }, [currentPath, loadDirectory, revertToPath]);

    const contextValue = {
        currentDirData,
        isLoading,
        selectedItems,
        focusedItem,
        volumes,
        error,
        loadDirectory,
        openFile,
        createFile,
        createDirectory,
        renameItem,
        moveToTrash,
        selectItem,
        selectMultiple,
        clearSelection,
        setFocusedItem: setFocusedItemCallback,
        zipItems,
        unzipItem,
        loadVolumes,
    };

    return (
        <FileSystemContext.Provider value={contextValue}>
            {children}
        </FileSystemContext.Provider>
    );
}

// Custom hook for using the file system context
export const useFileSystem = () => {
    const context = useContext(FileSystemContext);
    if (!context) {
        throw new Error('useFileSystem must be used within a FileSystemProvider');
    }
    return context;
};
