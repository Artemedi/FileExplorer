import React, { useState } from 'react';
import FileIcon from './FileIcon';
import { formatFileSize, formatDate, getFileType } from '../../utils/formatters';
import { middleEllipsis } from '../../utils/middleEllipsis';
import { joinPath, normalizePath, getDirectoryPath } from '../../utils/pathUtils';
import { invoke } from '@tauri-apps/api/core';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useHistory } from '../../providers/HistoryProvider';
import { useContextMenu } from '../../providers/ContextMenuProvider';
import { useSettings } from '../../providers/SettingsProvider';
import { showError, showSuccess } from '../../utils/NotificationSystem';
import './fileItem.css';

const isSameOrChildPath = (sourcePath, targetDirPath) => {
    const isSftp = sourcePath.startsWith('sftp:') || targetDirPath.startsWith('sftp:');
    const normSrc = normalizePath(sourcePath);
    const normTarget = normalizePath(targetDirPath);
    const a = isSftp ? normSrc : normSrc.toLowerCase();
    const b = isSftp ? normTarget : normTarget.toLowerCase();
    if (a === b) return true;
    const sep = isSftp ? '/' : (a.includes('/') ? '/' : '\\');
    const prefix = a.endsWith(sep) ? a : `${a}${sep}`;
    return b.startsWith(prefix);
};

/**
 * Component that displays a single file or directory item
 * @param {Object} props - Component properties
 * @param {Object} props.item - The file or directory object to display
 * @param {string} [props.viewMode='grid'] - The view mode: 'grid', 'list', or 'details'
 * @param {boolean} [props.isSelected=false] - Whether the item is currently selected
 * @param {boolean} [props.isFocused=false] - Whether the item is currently focused for keyboard navigation
 * @param {Function} [props.onRefresh] - Optional refresh callback (e.g. for DualPane)
 * @param {Function} props.onClick - Click handler function
 * @param {Function} props.onDoubleClick - Double-click handler function
 * @param {Function} props.onContextMenu - Context menu handler function
 * @returns {React.ReactElement} File/directory item component
 */
const FileItem = ({
                      item,
                      viewMode = 'grid',
                      isSelected = false,
                      isFocused = false,
                      onRefresh,
                      onClick,
                      onDoubleClick,
                      onContextMenu
                  }) => {
    const { loadDirectory } = useFileSystem();
    const { currentPath } = useHistory();
    const { clipboard } = useContextMenu();
    const { settings } = useSettings();
    const [isDragOver, setIsDragOver] = useState(false);

    const isDirectory = Boolean(item.isDirectory || item.is_directory || 'sub_file_count' in item);
    const showExtensions = settings?.show_file_extensions !== false;
    const displayName = (() => {
        if (isDirectory || showExtensions) return item.name;
        const lastDot = item.name.lastIndexOf('.');
        return lastDot > 0 ? item.name.slice(0, lastDot) : item.name;
    })();
    const isExpandedInGrid = viewMode === 'grid' && (isSelected || isFocused);
    const gridDisplayName = isExpandedInGrid
        ? displayName
        : middleEllipsis(displayName, 26, { isDirectory });
    const fileType = isDirectory ? 'Folder' : getFileType(item.name);
    const rawSize = item.size_in_bytes ?? item.size ?? 0;
    const size = isDirectory
        ? `${item.sub_file_count || 0} items`
        : formatFileSize(rawSize);

    // Check if this item is cut (in clipboard with cut operation)
    const isCut = clipboard.operation === 'cut' && 
                  clipboard.items.some(clipItem => clipItem.path === item.path);

    // Format modified date
    const modified = formatDate(item.last_modified ?? item.modified);


    const refreshTarget = () => {
        if (onRefresh) {
            onRefresh();
        } else if (currentPath) {
            loadDirectory(currentPath);
        }
    };

    const handleDragStart = (e) => {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('application/json', JSON.stringify({
            path: item.path,
            name: item.name,
            isDirectory
        }));
        e.dataTransfer.setData('text/plain', item.path);
    };

    const handleDragOver = (e) => {
        if (isDirectory) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            setIsDragOver(true);
        }
    };

    const handleDragLeave = (e) => {
        if (isDirectory) {
            setIsDragOver(false);
        }
    };

    const handleDrop = async (e) => {
        if (!isDirectory) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);

        try {
            const raw = e.dataTransfer?.getData('application/json');
            if (raw) {
                const source = JSON.parse(raw);
                if (source && source.path) {
                    if (isSameOrChildPath(source.path, item.path)) {
                        return;
                    }
                    const parentDir = normalizePath(getDirectoryPath(source.path));
                    const targetDir = normalizePath(item.path);
                    const isSftp = source.path.startsWith('sftp:') || item.path.startsWith('sftp:');
                    const alreadyInTarget = isSftp
                        ? parentDir === targetDir
                        : parentDir.toLowerCase() === targetDir.toLowerCase();
                    if (alreadyInTarget) {
                        return;
                    }

                    const dest = joinPath(item.path, source.name);
                    await invoke('copy_file_or_dir', {
                        sourcePath: source.path,
                        destinationPath: dest
                    });
                    showSuccess(`Copied into ${item.name}`);
                    refreshTarget();
                    return;
                }
            }
        } catch (err) {
            console.error('Drop on folder failed:', err);
            showError(`Failed to drop item: ${err?.message || err}`);
            return;
        }

        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            let count = 0;
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const f = e.dataTransfer.files[i];
                if (f.path && !isSameOrChildPath(f.path, item.path)) {
                    const dest = joinPath(item.path, f.name);
                    try {
                        await invoke('copy_file_or_dir', {
                            sourcePath: f.path,
                            destinationPath: dest
                        });
                        count++;
                    } catch (err) {
                        console.error('File drop copy failed:', err);
                        showError(`Failed to copy ${f.name}: ${err?.message || err}`);
                    }
                }
            }
            if (count > 0) {
                showSuccess(`Copied ${count} item(s) into ${item.name}`);
                refreshTarget();
            }
        }
    };

    /**
     * Handles click events on the file item
     * @param {React.MouseEvent} e - The click event
     */
    const handleClick = (e) => {
        if (onClick) onClick(e);
    };

    /**
     * Handles mouse down events
     * @param {React.MouseEvent} e - The mouse down event
     */
    const handleMouseDown = (_e) => {
        // Allow drag and drop without blocking
    };

    /**
     * Handles double-click events on the file item
     * @param {React.MouseEvent} e - The double-click event
     */
    const handleDoubleClick = (e) => {
        // Prevent text selection on double-click
        e.preventDefault();
        e.stopPropagation();
        
        // Clear any existing text selection
        if (window.getSelection) {
            window.getSelection().removeAllRanges();
        }
        
        if (onDoubleClick) onDoubleClick(e);
    };

    /**
     * Handles right-click context menu events on the file item
     * @param {React.MouseEvent} e - The context menu event
     */
    const handleContextMenu = (e) => {
        if (onContextMenu) onContextMenu(e);
    };

    return (
        <>
            <div
                className={`file-item view-mode-${viewMode.toLowerCase()} ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''} ${isDirectory ? 'directory' : 'file'} ${isCut ? 'cut' : ''} ${isDragOver ? 'drag-over' : ''}`}
                role="option"
                aria-selected={isSelected}
                draggable
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onMouseDown={handleMouseDown}
                onContextMenu={handleContextMenu}
                data-path={item.path}
            >
                {viewMode === 'grid' && (
                    <div className="file-item-grid">
                        <div className="file-icon-container">
                            <FileIcon filename={item.name} isDirectory={isDirectory} />
                        </div>

                        <div className="file-name" title={item.name}>
                            {gridDisplayName}
                        </div>
                    </div>
                )}

                {viewMode === 'list' && (
                    <div className="file-item-list">
                        <div className="file-icon-container">
                            <FileIcon filename={item.name} isDirectory={isDirectory} />
                        </div>

                        <div className="file-details">
                            <div className="file-name truncate" title={item.name}>
                                {displayName}
                            </div>
                            <div className="file-info truncate">
                                {size} • {modified}
                            </div>
                        </div>
                    </div>
                )}

                {viewMode === 'details' && (
                    <div className="file-item-details">
                        <div className="file-column column-name">
                            <div className="file-icon-container">
                                <FileIcon filename={item.name} isDirectory={isDirectory} />
                            </div>

                            <div className="file-name truncate" title={item.name}>
                                {displayName}
                            </div>
                        </div>

                        <div className="file-column column-size">
                            {size}
                        </div>

                        <div className="file-column column-type">
                            {fileType}
                        </div>

                        <div className="file-column column-modified">
                            {modified}
                        </div>
                    </div>
                )}
            </div>

        </>
    );
};

export default FileItem;