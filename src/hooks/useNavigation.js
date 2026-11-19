import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useHistory } from '../providers/HistoryProvider';
import { useFileSystem } from '../providers/FileSystemProvider';
import { getDirectoryPath, isRootPath } from '../utils/pathUtils';

/**
 * Hook for handling navigation within the file explorer.
 * @returns {Object} Navigation state and functions.
 */
const useNavigation = () => {
    const {
        currentPath,
        canGoBack,
        canGoForward,
        goBack,
        goForward,
        navigateTo
    } = useHistory();

    const { loadDirectory, volumes } = useFileSystem();

    // Navigate to a specific path (only record in history when load succeeds)
    const navigateToPath = useCallback(async (path) => {
        if (!path || path === currentPath) return false;

        try {
            const ok = await loadDirectory(path);
            if (ok) {
                navigateTo(path);
                return true;
            }
            return false;
        } catch (error) {
            console.error(`Failed to navigate to path: ${path}`, error);
            return false;
        }
    }, [currentPath, loadDirectory, navigateTo]);

    // Navigate to parent directory
    const navigateToParent = useCallback(() => {
        if (!currentPath || isRootPath(currentPath)) return;

        const parentPath = getDirectoryPath(currentPath);
        if (parentPath && parentPath !== currentPath) {
            navigateToPath(parentPath);
        }
    }, [currentPath, navigateToPath]);

    // Navigate to home directory
    const navigateToHome = useCallback(async () => {
        try {
            const metaDataJson = await invoke('get_meta_data_as_json');
            const metaData = JSON.parse(metaDataJson);
            const homePath = metaData?.user_home_dir;
            if (homePath) {
                await navigateToPath(homePath);
                return;
            }
        } catch (error) {
            console.warn('Failed to retrieve user home directory:', error);
        }

        const fallback = volumes?.[0]?.mount_point || '/';
        await navigateToPath(fallback);
    }, [navigateToPath, volumes]);

    // Refresh current directory
    const refreshCurrentDirectory = useCallback(() => {
        if (currentPath) {
            loadDirectory(currentPath)
                .catch(error => {
                    console.error(`Failed to refresh directory: ${currentPath}`, error);
                });
        }
    }, [currentPath, loadDirectory]);

    // Parse a path string to get segment objects
    const parsePathSegments = useCallback((path) => {
        if (!path) return [];

        const segments = [];

        // Handle SFTP URLs: sftp://user@host:port/a/b
        if (path.startsWith('sftp://')) {
            const schemeEnd = 'sftp://'.length;
            const firstSlash = path.indexOf('/', schemeEnd);
            const authority = firstSlash === -1 ? path.slice(schemeEnd) : path.slice(schemeEnd, firstSlash);
            const rootPath = `sftp://${authority}/`;
            segments.push({
                name: authority,
                path: rootPath,
                type: 'sftp',
            });

            if (firstSlash !== -1) {
                const rest = path.slice(firstSlash + 1).split('/').filter(Boolean);
                let acc = `sftp://${authority}`;
                for (const part of rest) {
                    acc += `/${part}`;
                    segments.push({
                        name: part,
                        path: acc,
                        type: 'folder',
                    });
                }
            }
            return segments;
        }

        // Handle SFTP custom format: sftp:conn:a/b
        if (path.startsWith('sftp:')) {
            const firstColon = path.indexOf(':');
            const secondColon = path.indexOf(':', firstColon + 1);
            if (secondColon !== -1) {
                const prefix = path.substring(0, secondColon + 1);
                const connName = path.substring(firstColon + 1, secondColon);
                const remote = path.substring(secondColon + 1);
                segments.push({
                    name: connName || 'SFTP',
                    path: `${prefix}/`,
                    type: 'sftp',
                });
                const parts = remote.split('/').filter(Boolean);
                let acc = remote.startsWith('/') ? '' : '';
                for (const part of parts) {
                    if (part === '.') continue;
                    acc = acc ? `${acc}/${part}` : (remote.startsWith('/') ? `/${part}` : part);
                    segments.push({
                        name: part,
                        path: `${prefix}${acc}`,
                        type: 'folder',
                    });
                }
                return segments;
            }
        }

        // Handle UNC paths: \\server\share\dir
        if (path.startsWith('\\\\')) {
            const parts = path.slice(2).split(/[/\\]+/).filter(Boolean);
            if (parts.length >= 2) {
                const shareRoot = `\\\\${parts[0]}\\${parts[1]}`;
                segments.push({
                    name: shareRoot,
                    path: shareRoot,
                    type: 'drive',
                });
                let acc = shareRoot;
                for (let i = 2; i < parts.length; i++) {
                    acc += `\\${parts[i]}`;
                    segments.push({
                        name: parts[i],
                        path: acc,
                        type: 'folder',
                    });
                }
                return segments;
            }
        }

        // Handle Windows drive paths (case-insensitive, \ or /): C:\path\to\folder or c:/path
        if (/^[A-Za-z]:[/\\]?/.test(path)) {
            const sep = path.includes('\\') ? '\\' : '/';
            const parts = path.split(/[/\\]+/).filter(Boolean);
            if (parts.length === 0) return segments;

            const driveRoot = `${parts[0]}${sep}`;
            segments.push({
                name: parts[0],
                path: driveRoot,
                type: 'drive',
            });

            let acc = parts[0];
            for (let i = 1; i < parts.length; i++) {
                acc += `${sep}${parts[i]}`;
                segments.push({
                    name: parts[i],
                    path: acc,
                    type: 'folder',
                });
            }
            return segments;
        }

        // Handle Unix paths
        const parts = path.split('/');
        let currentSegment = '';

        if (parts[0] === '') {
            segments.push({
                name: '/',
                path: '/',
                type: 'root',
            });
            parts.shift();
        }

        for (let i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;

            currentSegment += '/' + parts[i];
            segments.push({
                name: parts[i],
                path: currentSegment,
                type: 'folder',
            });
        }

        return segments;
    }, []);

    return {
        currentPath,
        canGoBack,
        canGoForward,
        goBack,
        goForward,
        navigateToPath,
        navigateToParent,
        navigateToHome,
        refreshCurrentDirectory,
        parsePathSegments,
    };
};

export default useNavigation;
