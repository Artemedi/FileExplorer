import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useFileSystem } from './FileSystemProvider';
import { useHistory } from './HistoryProvider';
import { useSftp } from './SftpProvider';
import { useSettings } from './SettingsProvider';
import { getDirectoryPath, getFileName, joinPath, normalizePath, isRootPath, isPathOrDescendant } from '../utils/pathUtils';
import { showNotification, showError, showSuccess, showConfirm } from '../utils/NotificationSystem';

export const ContextMenuContext = createContext(null);

const isSameDirectoryPath = (a, b) => {
    if (!a || !b) return false;
    const normA = normalizePath(a);
    const normB = normalizePath(b);
    if (normA === normB) return true;
    if (/^[A-Za-z]:[/\\]/.test(normA) || normA.startsWith('\\\\')) {
        return normA.toLowerCase() === normB.toLowerCase();
    }
    return false;
};

export default function ContextMenuProvider({ children }) {
    const [isOpen, setIsOpen] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [target, setTarget] = useState(null);
    const [items, setItems] = useState([]);
    const [clipboard, setClipboard] = useState({ items: [], operation: null });
    const [isProcessing, setIsProcessing] = useState(false);

    const { selectedItems, loadDirectory, clearSelection, moveToTrash, currentDirData } = useFileSystem();
    const { currentPath } = useHistory();
    const { isSftpPath, parseSftpPath, copySftpItem, moveSftpItem, downloadAndOpenSftpFile } = useSftp();
    const { settings } = useSettings();

    // Check if item is in favorites
    const isInFavorites = useCallback((item) => {
        try {
            const existingFavorites = JSON.parse(localStorage.getItem('fileExplorerFavorites') || '[]');
            return existingFavorites.some(fav => fav.path === item.path);
        } catch (error) {
            console.error('Failed to check favorites:', error);
            return false;
        }
    }, []);

    // Add to favorites with live update
    const addToFavorites = useCallback((item) => {
        try {
            const existingFavorites = JSON.parse(localStorage.getItem('fileExplorerFavorites') || '[]');

            // Check if already in favorites
            const alreadyExists = existingFavorites.some(fav => fav.path === item.path);
            if (alreadyExists) {
                showNotification('This item is already in your favorites.');
                return;
            }

            const newFavorite = {
                name: item.name,
                path: item.path,
                icon: item.isDirectory || ('sub_file_count' in item) ? 'folder' : 'file'
            };

            const updatedFavorites = [...existingFavorites, newFavorite];
            localStorage.setItem('fileExplorerFavorites', JSON.stringify(updatedFavorites));

            // Dispatch events to update the UI immediately
            window.dispatchEvent(new CustomEvent('favorites-updated'));
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'fileExplorerFavorites',
                newValue: JSON.stringify(updatedFavorites)
            }));

            showSuccess(`Added "${item.name}" to favorites.`);
        } catch (error) {
            console.error('Failed to add to favorites:', error);
            showError('Failed to add to favorites.');
        }
    }, []);

    // Remove from favorites with live update
    const removeFromFavorites = useCallback((path) => {
        try {
            const existingFavorites = JSON.parse(localStorage.getItem('fileExplorerFavorites') || '[]');
            const updatedFavorites = existingFavorites.filter(fav => fav.path !== path);
            localStorage.setItem('fileExplorerFavorites', JSON.stringify(updatedFavorites));

            // Dispatch events to update the UI immediately
            window.dispatchEvent(new CustomEvent('favorites-updated'));
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'fileExplorerFavorites',
                newValue: JSON.stringify(updatedFavorites)
            }));
        } catch (error) {
            console.error('Failed to remove from favorites:', error);
        }
    }, []);

    // Update navigation history with live update (stored separately from HistoryProvider session stack)
    const updateNavigationHistory = useCallback((path) => {
        if (!path) return;
        try {
            const existingHistory = JSON.parse(sessionStorage.getItem('fileExplorerRecentPaths') || '[]');
            const updatedHistory = [path, ...existingHistory.filter(p => p !== path)].slice(0, 10);
            sessionStorage.setItem('fileExplorerRecentPaths', JSON.stringify(updatedHistory));

            // Dispatch events to update quick access immediately
            window.dispatchEvent(new CustomEvent('navigation-changed'));
            window.dispatchEvent(new CustomEvent('quick-access-updated'));
        } catch (error) {
            console.error('Failed to update navigation history:', error);
        }
    }, []);

    // Copy path to clipboard
    const copyPath = useCallback(async (item) => {
        try {
            let pathToCopy = item.path;
            
            // Convert SFTP paths to standard format
            if (isSftpPath(item.path)) {
                const parsed = parseSftpPath(item.path);
                if (parsed && parsed.connection) {
                    const remotePath = parsed.remotePath || '/';
                    // Ensure path starts with forward slash
                    const formattedPath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
                    pathToCopy = `sftp://${parsed.connection.username}@${parsed.connection.host}:${parsed.connection.port}${formattedPath}`;
                }
            }
            
            await navigator.clipboard.writeText(pathToCopy);
            showSuccess(`Path copied to clipboard: ${pathToCopy}`);
        } catch (error) {
            console.error('Failed to copy path:', error);
            showError('Failed to copy path to clipboard.');
        }
    }, [isSftpPath, parseSftpPath]);

    // Add as template
    const addAsTemplate = useCallback(async (item) => {
        if (!item || item.isDirectory || 'sub_file_count' in item) {
            showError('Only files can be added as templates.');
            return;
        }

        setIsProcessing(true);
        try {
            let templatePath = item.path;
            
            // Handle SFTP files by downloading them first
            if (isSftpPath(item.path)) {
                try {
                    // Download SFTP file to a temporary location using SftpProvider function
                    const tempPath = await downloadAndOpenSftpFile(item.path, false);
                    
                    if (!tempPath) {
                        throw new Error('Failed to download SFTP file');
                    }
                    
                    templatePath = tempPath;
                } catch (downloadError) {
                    console.error('Failed to download SFTP file for template:', downloadError);
                    showError(`Failed to download SFTP file: ${downloadError.message || downloadError}`);
                    return;
                }
            }
            
            const result = await invoke('add_template', {
                templatePath: templatePath
            });
            showSuccess(`Template added successfully: ${result}`);

            window.dispatchEvent(new CustomEvent('templates-updated'));
        } catch (error) {
            console.error('Failed to add template:', error);
            showError(`Failed to add template: ${error.message || error}`);
        } finally {
            setIsProcessing(false);
        }
    }, [isSftpPath, downloadAndOpenSftpFile]);

    // Copy items to clipboard
    const copyToClipboard = useCallback(async (items) => {
        setClipboard({ items, operation: 'copy' });
        // Copy paths to system clipboard as well
        const paths = items.map(item => item.path).join('\n');
        try {
            await navigator.clipboard.writeText(paths);
        } catch (err) {
            console.warn('Failed to copy to system clipboard:', err);
        }
    }, []);

    // Cut items to clipboard
    const cutToClipboard = useCallback(async (items) => {
        setClipboard({ items, operation: 'cut' });
        const paths = items.map(item => item.path).join('\n');
        try {
            await navigator.clipboard.writeText(paths);
        } catch (err) {
            console.warn('Failed to copy to system clipboard:', err);
        }
    }, []);

    // Helper function to generate unique destination path
    const generateUniqueDestPath = useCallback(async (basePath, fileName) => {
        let targetDirData = basePath === currentPath ? currentDirData : null;
        if (!targetDirData && basePath && !isSftpPath(basePath)) {
            try {
                const rawDir = await invoke('open_directory', { path: basePath });
                targetDirData = rawDir ? JSON.parse(rawDir) : null;
            } catch {
                targetDirData = null;
            }
        }
        if (!targetDirData) return joinPath(basePath, fileName);

        // Get all existing file and directory names in the destination directory
        const existingNames = new Set();
        if (targetDirData.files) {
            targetDirData.files.forEach(file => existingNames.add(file.name));
        }
        if (targetDirData.directories) {
            targetDirData.directories.forEach(dir => existingNames.add(dir.name));
        }

        // If the original name doesn't exist, use it
        if (!existingNames.has(fileName)) {
            return joinPath(basePath, fileName);
        }

        // Extract file name and extension
        const lastDotIndex = fileName.lastIndexOf('.');
        let baseName, extension;
        if (lastDotIndex === -1 || lastDotIndex === 0) {
            // No extension or hidden file starting with dot
            baseName = fileName;
            extension = '';
        } else {
            baseName = fileName.substring(0, lastDotIndex);
            extension = fileName.substring(lastDotIndex);
        }

        // Generate unique name with counter
        let counter = 1;
        let uniqueName;
        do {
            uniqueName = `${baseName} (${counter})${extension}`;
            counter++;
        } while (existingNames.has(uniqueName));

        return joinPath(basePath, uniqueName);
    }, [currentDirData, currentPath, isSftpPath]);

    // Paste items from clipboard - enhanced with SFTP support and target directory support
    const pasteFromClipboard = useCallback(async (targetDirectory = null) => {
        const destRoot = (typeof targetDirectory === 'string' && targetDirectory) ? targetDirectory : currentPath;
        if (!clipboard.items.length || !destRoot) return;

        setIsProcessing(true);
        const remainingCutItems = [];
        let anySucceeded = false;

        try {
            for (const item of clipboard.items) {
                const fileName = item.name || getFileName(item.path);
                const sourcePath = item.path;

                // Check if source and/or destination are SFTP paths
                const sourceIsSftp = isSftpPath(sourcePath);
                const destIsSftp = isSftpPath(destRoot);

                if (clipboard.operation === 'cut') {
                    // For move operations, use original filename (no duplicates)
                    const destPath = joinPath(destRoot, fileName);

                    // Check if we're trying to paste in the same directory
                    const sourceDir = getDirectoryPath(sourcePath);
                    if (isSameDirectoryPath(sourceDir, destRoot)) {
                        remainingCutItems.push(item);
                        continue;
                    }

                    // Move operation
                    if (sourceIsSftp || destIsSftp) {
                        if (sourceIsSftp && destIsSftp) {
                            const moved = await moveSftpItem(sourcePath, destPath);
                            if (moved) {
                                anySucceeded = true;
                            } else {
                                remainingCutItems.push(item);
                            }
                        } else {
                            showError('Moving between SFTP and local file systems is not yet supported');
                            remainingCutItems.push(item);
                        }
                    } else {
                        try {
                            await invoke('rename', {
                                oldPath: sourcePath,
                                newPath: destPath
                            });
                            anySucceeded = true;
                        } catch (itemError) {
                            console.error(`Failed to move ${sourcePath}:`, itemError);
                            showError(`Failed to move "${fileName}": ${itemError.message || itemError}`);
                            remainingCutItems.push(item);
                        }
                    }
                } else {
                    // Copy operation - generate unique destination path to allow duplicates
                    const destPath = await generateUniqueDestPath(destRoot, fileName);

                    if (sourceIsSftp || destIsSftp) {
                        if (sourceIsSftp && destIsSftp) {
                            const copied = await copySftpItem(sourcePath, destPath);
                            if (copied) anySucceeded = true;
                        } else {
                            showError('Copying between SFTP and local file systems is not yet supported');
                        }
                    } else {
                        await invoke('copy_file_or_dir', {
                            sourcePath: sourcePath,
                            destinationPath: destPath
                        });
                        anySucceeded = true;
                    }
                }
            }

            // For cut operations, only remove items that were actually moved
            if (clipboard.operation === 'cut') {
                if (remainingCutItems.length === 0) {
                    setClipboard({ items: [], operation: null });
                } else {
                    setClipboard({ items: remainingCutItems, operation: 'cut' });
                }
            }

            // Reload directory if at least one item succeeded
            if (anySucceeded && currentPath) {
                await loadDirectory(currentPath);
            }
        } catch (error) {
            console.error('Paste operation failed:', error);
            showError(`Failed to paste: ${error.message || error}`);
        } finally {
            setIsProcessing(false);
        }
    }, [clipboard, currentPath, loadDirectory, isSftpPath, copySftpItem, moveSftpItem, generateUniqueDestPath]);

    const isDeletingRef = useRef(false);

    // Delete items (batch without reloading on every item)
    const deleteItems = useCallback(async (items) => {
        if (!items.length || isDeletingRef.current) return;

        isDeletingRef.current = true;
        try {
            if (settings?.confirm_delete !== false) {
                const itemNames = items.map(item => item.name).join(', ');
                const confirmMessage = `Are you sure you want to move ${items.length === 1 ? itemNames : `${items.length} items`} to trash?`;

                // Use custom confirm dialog
                const shouldDelete = await showConfirm(confirmMessage, 'Move to Trash');
                if (!shouldDelete) return;
            }

            // Deduplicate and drop child paths whose ancestor is already being deleted
            const uniqueItems = [];
            const seenPaths = new Set();
            for (const item of items) {
                if (!item?.path || seenPaths.has(item.path)) continue;
                seenPaths.add(item.path);
                uniqueItems.push(item);
            }
            const topLevelItems = uniqueItems.filter((item) =>
                !uniqueItems.some((other) => other !== item && isPathOrDescendant(item.path, other.path))
            );

            setIsProcessing(true);
            try {
                let anyDeleted = false;
                for (const item of topLevelItems) {
                    const ok = await moveToTrash(item.path, { skipReload: true });
                    if (ok) {
                        anyDeleted = true;
                    }
                }
                if (anyDeleted && currentPath) {
                    await loadDirectory(currentPath);
                }
            } catch (error) {
                console.error('Delete operation failed:', error);
                showError(`Failed to delete: ${error.message || error}`);
            } finally {
                setIsProcessing(false);
            }
        } finally {
            isDeletingRef.current = false;
        }
    }, [moveToTrash, settings?.confirm_delete, currentPath, loadDirectory]);

    // Rename item - dispatch event to open rename modal
    const renameItem = useCallback((item) => {
        document.dispatchEvent(new CustomEvent('open-rename-modal', {
            detail: { item }
        }));
    }, []);

    // Zip items
    const zipItems = useCallback(async (items) => {
        if (!items.length) return;

        // Check if we're working with SFTP items
        const isSftpItems = items.some(item => isSftpPath(item.path));
        const isAllSftp = items.every(item => isSftpPath(item.path));
        
        if (isSftpItems && !isAllSftp) {
            showError('Cannot mix SFTP and local files in the same archive');
            return;
        }

        let destinationPath = null;
        let zipName = null;

        if (items.length === 1) {
            // For single item, use its name as base for zip name
            const item = items[0];
            const baseName = item.name;
            zipName = `${baseName}.zip`;
        } else {
            // For multiple items, generate a unique archive name without blocking on window.prompt
            const uniqueArchivePath = await generateUniqueDestPath(currentPath, 'archive.zip');
            zipName = getFileName(uniqueArchivePath) || `archive_${Date.now()}.zip`;
        }

        if (isAllSftp) {
            // Handle SFTP items
            destinationPath = joinPath(currentPath, zipName);
            
            setIsProcessing(true);
            try {
                // For SFTP items, we need to download them first, create zip locally, then upload
                const tempPaths = [];
                
                for (const item of items) {
                    const tempPath = await downloadAndOpenSftpFile(item.path, false);
                    if (!tempPath) {
                        throw new Error(`Failed to download ${item.name} for zipping`);
                    }
                    tempPaths.push(tempPath);
                }
                
                // Create temp zip file in the same directory as downloaded SFTP temp files
                const tempDir = getDirectoryPath(tempPaths[0]);
                const tempZipPath = joinPath(tempDir, zipName);
                
                // Create zip from downloaded files
                await invoke('zip', {
                    sourcePaths: tempPaths,
                    destinationPath: tempZipPath
                });
                
                // Upload zip back to SFTP if current path is SFTP
                if (isSftpPath(currentPath)) {
                    const parsed = parseSftpPath(currentPath);
                    if (parsed && parsed.connection) {
                        showSuccess(`ZIP created locally at: ${tempZipPath}. SFTP upload not yet implemented.`);
                    }
                } else {
                    await invoke('copy_file_or_dir', {
                        sourcePath: tempZipPath,
                        destinationPath: destinationPath
                    });
                    await invoke('cleanup_sftp_temp_files').catch(() => {});
                    showSuccess(`Successfully created ${zipName}`);
                }
                
                await loadDirectory(currentPath);
            } catch (error) {
                console.error('SFTP zip operation failed:', error);
                showError(`Failed to create zip: ${error.message || error}`);
            } finally {
                setIsProcessing(false);
            }
        } else {
            // Handle local items (original logic)
            const sourcePaths = items.map(item => item.path);
            destinationPath = joinPath(currentPath, zipName);
            
            setIsProcessing(true);
            try {
                await invoke('zip', {
                    sourcePaths: sourcePaths,
                    destinationPath: destinationPath
                });

                await loadDirectory(currentPath);
                showSuccess(`Successfully created ${getFileName(destinationPath)}`);
            } catch (error) {
                console.error('Zip operation failed:', error);
                showError(`Failed to create zip: ${error.message || error}`);
            } finally {
                setIsProcessing(false);
            }
        }
    }, [currentPath, loadDirectory, isSftpPath, downloadAndOpenSftpFile, parseSftpPath, generateUniqueDestPath]);

    // Unzip item
    const unzipItem = useCallback(async (item) => {
        if (!item.name.toLowerCase().endsWith('.zip')) return;

        setIsProcessing(true);
        try {
            if (isSftpPath(item.path)) {
                // Handle SFTP zip files - download first, then extract
                console.log('📡 SFTP zip file detected, downloading for extraction...');
                const tempZipPath = await downloadAndOpenSftpFile(item.path, false);
                if (!tempZipPath) {
                    throw new Error('Failed to download SFTP zip file for extraction');
                }
                
                // Extract to temp directory in the same OS temp dir as tempZipPath
                const tempExtractPath = joinPath(getDirectoryPath(tempZipPath), 'extracted_' + Date.now());
                
                await invoke('unzip', {
                    zipPaths: [tempZipPath],
                    destinationPath: tempExtractPath
                });
                
                // For now, we'll extract locally and notify user
                // TODO: Implement upload of extracted files back to SFTP
                showSuccess(`ZIP extracted locally to: ${tempExtractPath}. SFTP upload of extracted files not yet implemented.`);
            } else {
                // Handle local zip files (original logic)
                await invoke('unzip', {
                    zipPaths: [item.path],
                    destinationPath: currentPath
                });
                showSuccess(`Successfully extracted ${item.name}`);
            }

            await loadDirectory(currentPath);
        } catch (error) {
            console.error('Unzip operation failed:', error);
            showError(`Failed to extract: ${error.message || error}`);
        } finally {
            setIsProcessing(false);
        }
    }, [currentPath, loadDirectory, isSftpPath, downloadAndOpenSftpFile]);

    // Generate hash for a file - VERBESSERT MIT DEBUG
    const generateHash = useCallback(async (item) => {
        console.log('🔧 generateHash called with:', item?.name, item?.path);

        if (!item || item.isDirectory || 'sub_file_count' in item) {
            console.log('❌ Item invalid for hash generation');
            showError('Hash generation is only available for files.');
            return;
        }

        console.log('🚀 Starting hash generation...');
        setIsProcessing(true);

        try {
            let hashPath = item.path;
            
            // Handle SFTP files by downloading them first
            if (isSftpPath(item.path)) {
                console.log('📡 SFTP file detected, downloading for hash generation...');
                const tempPath = await downloadAndOpenSftpFile(item.path, false);
                if (!tempPath) {
                    throw new Error('Failed to download SFTP file for hash generation');
                }
                hashPath = tempPath;
                console.log('✅ SFTP file downloaded to:', hashPath);
            }
            
            console.log('📞 Calling Tauri invoke gen_hash_and_return_string...');
            const hash = await invoke('gen_hash_and_return_string', { path: hashPath });

            console.log('✅ Hash generated:', hash.substring(0, 20) + '...');

            // Try to copy hash to clipboard, with fallback if it fails
            try {
                await navigator.clipboard.writeText(hash);
                showSuccess(`Hash generated and copied to clipboard: ${hash.substring(0, 16)}...`);
            } catch (clipboardError) {
                console.warn('📋 Clipboard access failed, showing hash display modal instead:', clipboardError);
                
                // Show the hash in a modal for manual copying
                const event = new CustomEvent('open-hash-display-modal', {
                    detail: { hash: hash, fileName: item.name }
                });
                document.dispatchEvent(event);
            }
        } catch (error) {
            console.error('💥 Hash generation failed:', error);
            showError(`Failed to generate hash: ${error.message || error}`);
        } finally {
            setIsProcessing(false);
        }
    }, [isSftpPath, downloadAndOpenSftpFile]);

    // Generate hash and save to file - VERBESSERT MIT DEBUG
    const generateHashToFile = useCallback(async (item) => {
        console.log('🔧 generateHashToFile called with:', item?.name);

        if (!item || item.isDirectory || 'sub_file_count' in item) {
            console.log('❌ Item invalid for hash file generation');
            showError('Hash generation is only available for files.');
            return;
        }

        // For SFTP files, we need to modify the item to use downloaded path for hash generation
        let processedItem = item;
        
        if (isSftpPath(item.path)) {
            console.log('📡 SFTP file detected for hash file generation...');
            setIsProcessing(true);
            try {
                const tempPath = await downloadAndOpenSftpFile(item.path, false);
                if (!tempPath) {
                    throw new Error('Failed to download SFTP file for hash generation');
                }
                // Create a modified item with the temp path for hash generation
                processedItem = {
                    ...item,
                    path: tempPath,
                    originalPath: item.path // Keep original path for reference
                };
                console.log('✅ SFTP file downloaded for hash generation:', tempPath);
            } catch (error) {
                console.error('Failed to download SFTP file for hash generation:', error);
                showError(`Failed to download SFTP file: ${error.message || error}`);
                setIsProcessing(false);
                return;
            } finally {
                setIsProcessing(false);
            }
        }

        console.log('📤 Dispatching open-hash-file-modal event...');

        // Dispatch event to open hash file modal
        const event = new CustomEvent('open-hash-file-modal', {
            detail: { item: processedItem },
            bubbles: true
        });

        document.dispatchEvent(event);
        console.log('✅ Event dispatched successfully');
    }, [isSftpPath, downloadAndOpenSftpFile]);

    // Compare file with hash - VERBESSERT MIT DEBUG
    const compareHash = useCallback(async (item) => {
        console.log('🔧 compareHash called with:', item?.name);

        if (!item || item.isDirectory || 'sub_file_count' in item) {
            console.log('❌ Item invalid for hash comparison');
            showError('Hash comparison is only available for files.');
            return;
        }

        // For SFTP files, we need to modify the item to use downloaded path for hash comparison
        let processedItem = item;
        
        if (isSftpPath(item.path)) {
            console.log('📡 SFTP file detected for hash comparison...');
            setIsProcessing(true);
            try {
                const tempPath = await downloadAndOpenSftpFile(item.path, false);
                if (!tempPath) {
                    throw new Error('Failed to download SFTP file for hash comparison');
                }
                // Create a modified item with the temp path for hash comparison
                processedItem = {
                    ...item,
                    path: tempPath,
                    originalPath: item.path // Keep original path for reference
                };
                console.log('✅ SFTP file downloaded for hash comparison:', tempPath);
            } catch (error) {
                console.error('Failed to download SFTP file for hash comparison:', error);
                showError(`Failed to download SFTP file: ${error.message || error}`);
                setIsProcessing(false);
                return;
            } finally {
                setIsProcessing(false);
            }
        }

        console.log('📤 Dispatching open-hash-compare-modal event...');

        // Dispatch event to open hash compare modal
        const event = new CustomEvent('open-hash-compare-modal', {
            detail: { item: processedItem },
            bubbles: true
        });

        document.dispatchEvent(event);
        console.log('✅ Event dispatched successfully');
    }, [isSftpPath, downloadAndOpenSftpFile]);

    // Get current folder metadata by loading parent directory
    const getCurrentFolderMetadata = useCallback(async (folderPath) => {
        if (!folderPath) return null;

        const folderName = getFileName(folderPath) || folderPath;

        if (isRootPath(folderPath) || isSftpPath(folderPath)) {
            return {
                name: folderName || 'Root',
                path: folderPath,
                isDirectory: true,
                sub_file_count: 0,
                sub_dir_count: 0,
                is_symlink: false,
                access_rights_as_string: 'rwxr-xr-x',
                access_rights_as_number: 16877,
                size_in_bytes: 0,
                created: new Date().toISOString().replace('T', ' ').split('.')[0],
                last_modified: new Date().toISOString().replace('T', ' ').split('.')[0],
                accessed: new Date().toISOString().replace('T', ' ').split('.')[0]
            };
        }

        try {
            const parentPath = getDirectoryPath(folderPath);
            if (!parentPath || parentPath === folderPath) {
                return null;
            }

            // Load parent directory to get metadata for current folder
            const parentContent = await invoke('open_directory', { path: parentPath });
            const parentData = JSON.parse(parentContent);

            // Find current folder in parent directory listing
            const currentFolderMeta = parentData.directories?.find(dir => dir.name === folderName);

            if (currentFolderMeta) {
                return currentFolderMeta;
            }

            return {
                name: folderName || 'Root',
                path: folderPath,
                isDirectory: true,
                sub_file_count: 0,
                sub_dir_count: 0,
                is_symlink: false,
                access_rights_as_string: 'rwxr-xr-x',
                access_rights_as_number: 16877,
                size_in_bytes: 0,
                created: new Date().toISOString().replace('T', ' ').split('.')[0],
                last_modified: new Date().toISOString().replace('T', ' ').split('.')[0],
                accessed: new Date().toISOString().replace('T', ' ').split('.')[0]
            };
        } catch (error) {
            console.error('Failed to get folder metadata:', error);

            return {
                name: folderName || 'Root',
                path: folderPath,
                isDirectory: true,
                sub_file_count: 0,
                sub_dir_count: 0,
                is_symlink: false,
                access_rights_as_string: 'rwxr-xr-x',
                access_rights_as_number: 16877,
                size_in_bytes: 0,
                created: new Date().toISOString().replace('T', ' ').split('.')[0],
                last_modified: new Date().toISOString().replace('T', ' ').split('.')[0],
                accessed: new Date().toISOString().replace('T', ' ').split('.')[0]
            };
        }
    }, [isSftpPath]);

    // Show properties - dispatch event to open details panel
    const showProperties = useCallback(async (item) => {
        // Only resolve folder metadata when item is a folder path string (never for 0-byte files or empty folders)
        if (typeof item === 'string') {
            try {
                const folderMetadata = await getCurrentFolderMetadata(item);
                if (folderMetadata) {
                    document.dispatchEvent(new CustomEvent('select-item', {
                        detail: { item: folderMetadata }
                    }));
                    document.dispatchEvent(new CustomEvent('show-properties', {
                        detail: { item: folderMetadata }
                    }));
                    return;
                }
            } catch (error) {
                console.error('Failed to get folder metadata for properties:', error);
            }
        }

        // Dispatch original item
        document.dispatchEvent(new CustomEvent('select-item', {
            detail: { item }
        }));
        document.dispatchEvent(new CustomEvent('show-properties', {
            detail: { item }
        }));
    }, [getCurrentFolderMetadata]);

    // Generate menu items
    const getMenuItemsForContext = useCallback((contextTarget, overrideSelectedItems = null) => {
        const isDirectory = contextTarget && (contextTarget.isDirectory || ('sub_file_count' in contextTarget));
        const isFile = contextTarget && !isDirectory;
        const hasClipboard = clipboard.items.length > 0;
        const isZipFile = Boolean(contextTarget && !isDirectory && contextTarget.name?.toLowerCase().endsWith('.zip'));
        const effectiveSelectedItems = Array.isArray(overrideSelectedItems) ? overrideSelectedItems : selectedItems;
        const selectionCount = contextTarget ? (effectiveSelectedItems.length || 1) : 0;

        // Empty space context menu
        if (!contextTarget) {
            return [
                {
                    id: 'paste',
                    label: 'Paste',
                    icon: 'paste',
                    disabled: !hasClipboard || isProcessing,
                    action: () => pasteFromClipboard(currentPath)
                },
                { type: 'separator' },
                {
                    id: 'new-folder',
                    label: 'New Folder',
                    icon: 'folder',
                    action: () => {
                        document.dispatchEvent(new CustomEvent('create-folder'));
                    }
                },
                {
                    id: 'new-file',
                    label: 'New File',
                    icon: 'file',
                    action: () => {
                        document.dispatchEvent(new CustomEvent('create-file'));
                    }
                },
                { type: 'separator' },
                {
                    id: 'properties',
                    label: 'Properties',
                    icon: 'properties',
                    action: () => showProperties(currentPath)
                },
                { type: 'separator' },
                {
                    id: 'refresh',
                    label: 'Refresh',
                    icon: 'refresh',
                    action: () => loadDirectory(currentPath)
                }
            ];
        }

        // File/folder context menu
        const targetItems = selectionCount > 1 ? effectiveSelectedItems : [contextTarget];
        const itemIsInFavorites = isInFavorites(contextTarget);

        const menuItems = [
            {
                id: 'open',
                label: 'Open',
                icon: 'open',
                disabled: selectionCount > 1,
                action: async () => {
                    if (isDirectory) {
                        await loadDirectory(contextTarget.path);
                        updateNavigationHistory(contextTarget.path);
                    } else {
                        try {
                            // Handle SFTP files differently - download and open locally
                            if (isSftpPath(contextTarget.path)) {
                                await downloadAndOpenSftpFile(contextTarget.path);
                            } else {
                                // Regular local file - open with default app
                                await invoke('open_in_default_app', { path: contextTarget.path });
                            }
                        } catch (error) {
                            console.error('Failed to open file:', error);
                            showError(`Failed to open file: ${error.message || error}`);
                        }
                    }
                }
            },
            { type: 'separator' },
            {
                id: 'copy',
                label: 'Copy',
                icon: 'copy',
                disabled: isProcessing,
                action: () => copyToClipboard(targetItems)
            },
            {
                id: 'cut',
                label: 'Cut',
                icon: 'cut',
                disabled: isProcessing,
                action: () => cutToClipboard(targetItems)
            },
            {
                id: 'paste',
                label: 'Paste',
                icon: 'paste',
                disabled: !hasClipboard || !isDirectory || isProcessing,
                action: () => pasteFromClipboard(contextTarget.path)
            },
            { type: 'separator' },
            {
                id: 'copy-path',
                label: 'Copy Path',
                icon: 'copy',
                disabled: selectionCount > 1 || isProcessing,
                action: () => copyPath(contextTarget)
            },
            { type: 'separator' },
            {
                id: 'rename',
                label: 'Rename',
                icon: 'rename',
                disabled: selectionCount > 1 || isProcessing,
                action: () => renameItem(contextTarget)
            },
            {
                id: 'delete',
                label: 'Delete',
                icon: 'delete',
                disabled: isProcessing,
                action: () => deleteItems(targetItems)
            }
        ];

        // Add "Add as Template" for files only
        if (isFile && selectionCount === 1) {
            menuItems.push(
                { type: 'separator' },
                {
                    id: 'add-as-template',
                    label: 'Add as Template',
                    icon: 'template',
                    disabled: isProcessing,
                    action: () => addAsTemplate(contextTarget)
                }
            );
        }

        // Add zip/unzip options
        if (isZipFile && selectionCount === 1) {
            menuItems.push(
                { type: 'separator' },
                {
                    id: 'extract',
                    label: 'Extract Here',
                    icon: 'extract',
                    disabled: isProcessing,
                    action: () => unzipItem(contextTarget)
                }
            );
        } else {
            menuItems.push(
                { type: 'separator' },
                {
                    id: 'compress',
                    label: selectionCount > 1 ? 'Add to Archive...' : 'Compress to ZIP',
                    icon: 'compress',
                    disabled: isProcessing,
                    action: () => zipItems(targetItems)
                }
            );
        }

        // Add hash options for files only - as submenu
        if (isFile && selectionCount === 1) {
            console.log('🔨 Adding hash submenu for file:', contextTarget.name);
            menuItems.push(
                { type: 'separator' },
                {
                    id: 'hash-options',
                    label: 'Hash',
                    icon: 'hash',
                    disabled: isProcessing,
                    submenu: [
                        {
                            id: 'generate-hash',
                            label: 'Generate & Copy to Clipboard',
                            icon: 'hash',
                            disabled: isProcessing,
                            action: () => {
                                console.log('🎯 Generate Hash clicked!', contextTarget?.name);
                                generateHash(contextTarget);
                            }
                        },
                        {
                            id: 'generate-hash-file',
                            label: 'Save Hash to File...',
                            icon: 'hash',
                            disabled: isProcessing,
                            action: () => {
                                console.log('🎯 Hash to File clicked!', contextTarget?.name);
                                generateHashToFile(contextTarget);
                            }
                        },
                        { type: 'separator' },
                        {
                            id: 'compare-hash',
                            label: 'Compare with Hash...',
                            icon: 'hash',
                            disabled: isProcessing,
                            action: () => {
                                console.log('🎯 Compare Hash clicked!', contextTarget?.name);
                                compareHash(contextTarget);
                            }
                        }
                    ]
                }
            );
        }

        // Add favorites option
        menuItems.push(
            { type: 'separator' },
            {
                id: itemIsInFavorites ? 'remove-from-favorites' : 'add-to-favorites',
                label: itemIsInFavorites ? 'Remove from Favorites' : 'Add to Favorites',
                icon: 'star',
                disabled: selectionCount > 1,
                action: () => {
                    if (itemIsInFavorites) {
                        removeFromFavorites(contextTarget.path);
                    } else {
                        addToFavorites(contextTarget);
                    }
                }
            }
        );

        // Add properties at the end
        menuItems.push(
            { type: 'separator' },
            {
                id: 'properties',
                label: 'Properties',
                icon: 'properties',
                disabled: selectionCount > 1,
                action: () => showProperties(contextTarget)
            }
        );

        return menuItems;
    }, [selectedItems, clipboard, isProcessing, currentPath, copyToClipboard, cutToClipboard, pasteFromClipboard, deleteItems, renameItem, loadDirectory, showProperties, addToFavorites, removeFromFavorites, updateNavigationHistory, zipItems, unzipItem, isInFavorites, getCurrentFolderMetadata, generateHash, generateHashToFile, compareHash, copyPath, addAsTemplate, isSftpPath, downloadAndOpenSftpFile, parseSftpPath]);

    // Open context menu
    const openContextMenu = useCallback((e, contextTarget = null, overrideSelectedItems = null) => {
        e.preventDefault();

        console.log('🎯 Opening context menu for:', contextTarget?.name || 'empty space');

        const menuItems = getMenuItemsForContext(contextTarget, overrideSelectedItems);

        setPosition({ x: e.clientX, y: e.clientY });
        setTarget(contextTarget);
        setItems(menuItems);
        setIsOpen(true);
    }, [getMenuItemsForContext]);

    // Close context menu
    const closeContextMenu = useCallback(() => {
        setIsOpen(false);
    }, []);

    const contextValue = {
        isOpen,
        position,
        target,
        items,
        clipboard,
        isProcessing,
        openContextMenu,
        closeContextMenu,
        removeFromFavorites, // Export this for Sidebar to use
        copyToClipboard,
        cutToClipboard,
        pasteFromClipboard,
        deleteItems,
        renameItem,
        showProperties,
    };

    return (
        <ContextMenuContext.Provider value={contextValue}>
            {children}
        </ContextMenuContext.Provider>
    );
}

export const useContextMenu = () => {
    const context = useContext(ContextMenuContext);
    if (!context) {
        throw new Error('useContextMenu must be used within a ContextMenuProvider');
    }
    return context;
};