import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useHistory } from '../../providers/HistoryProvider';
import { useSettings } from '../../providers/SettingsProvider';
import { useTranslation } from '../../i18n';
import { showSuccess, showError, showConfirm } from '../../utils/NotificationSystem';
import FileList from './FileList';
import './dualPane.css';

/**
 * DualPane component for side-by-side directory browsing and fast file transfers.
 */
const DualPane = ({ viewMode = 'grid', isPreviewOpen = false, onColumnsChange, onClose }) => {
    const { volumes, openFile } = useFileSystem();
    const { currentPath, navigateTo } = useHistory();
    const { settings } = useSettings();
    const { t } = useTranslation();

    const [activePane, setActivePane] = useState('left');

    const [leftPath, setLeftPath] = useState(() => {
        return localStorage.getItem('explr_dual_pane_left') || currentPath || 'C:\\';
    });

    const [rightPath, setRightPath] = useState(() => {
        const saved = localStorage.getItem('explr_dual_pane_right');
        if (saved) return saved;
        if (volumes && volumes.length > 1 && volumes[1].mount_point) {
            return volumes[1].mount_point;
        }
        return currentPath || 'C:\\';
    });

    const [leftDirData, setLeftDirData] = useState(null);
    const [rightDirData, setRightDirData] = useState(null);
    const [leftLoading, setLeftLoading] = useState(false);
    const [rightLoading, setRightLoading] = useState(false);

    const [leftSelected, setLeftSelected] = useState([]);
    const [rightSelected, setRightSelected] = useState([]);
    const [leftFocused, setLeftFocused] = useState(null);
    const [rightFocused, setRightFocused] = useState(null);

    // Filter hidden files helper
    const filterData = useCallback((data) => {
        if (!data || settings.show_hidden_files_and_folders) return data;
        return {
            ...data,
            directories: (data.directories || []).filter(d => !d.name.startsWith('.')),
            files: (data.files || []).filter(f => !f.name.startsWith('.')),
        };
    }, [settings.show_hidden_files_and_folders]);

    // Load directory for a specific pane
    const loadPaneDirectory = useCallback(async (pane, path) => {
        if (!path) return;
        if (pane === 'left') setLeftLoading(true);
        else setRightLoading(true);

        try {
            const raw = await invoke('open_directory', { path });
            const parsed = JSON.parse(raw);
            const filtered = filterData(parsed);

            if (pane === 'left') {
                setLeftDirData(filtered);
                setLeftPath(path);
                setLeftSelected([]);
                localStorage.setItem('explr_dual_pane_left', path);
                if (activePane === 'left') navigateTo(path);
            } else {
                setRightDirData(filtered);
                setRightPath(path);
                setRightSelected([]);
                localStorage.setItem('explr_dual_pane_right', path);
                if (activePane === 'right') navigateTo(path);
            }
        } catch (err) {
            console.error(`Failed to load directory ${path} in ${pane} pane:`, err);
            showError(`Failed to load ${path}: ${err}`);
        } finally {
            if (pane === 'left') setLeftLoading(false);
            else setRightLoading(false);
        }
    }, [filterData, activePane, navigateTo]);

    // Initial load for both panes
    useEffect(() => {
        loadPaneDirectory('left', leftPath);
        loadPaneDirectory('right', rightPath);
        if (leftPath) navigateTo(leftPath);
    }, []);

    // Sync external navigation (e.g. breadcrumbs or sidebar clicks) with active pane
    useEffect(() => {
        if (!currentPath) return;
        if (activePane === 'left' && currentPath !== leftPath) {
            loadPaneDirectory('left', currentPath);
        } else if (activePane === 'right' && currentPath !== rightPath) {
            loadPaneDirectory('right', currentPath);
        }
    }, [currentPath, activePane]);

    // Activate pane and sync global history
    const handleActivate = (pane) => {
        setActivePane(pane);
        const path = pane === 'left' ? leftPath : rightPath;
        if (path) {
            navigateTo(path);
        }
    };

    // Drag and drop handler between panes or from external sources
    const handlePaneDrop = async (targetPane, e) => {
        e.preventDefault();
        e.stopPropagation();

        const targetDir = targetPane === 'left' ? leftPath : rightPath;
        if (!targetDir) return;
        const separator = targetDir.includes('/') ? '/' : '\\';

        try {
            const raw = e.dataTransfer.getData('application/json');
            if (raw) {
                const source = JSON.parse(raw);
                if (source && source.path) {
                    const dest = targetDir.endsWith(separator)
                        ? `${targetDir}${source.name}`
                        : `${targetDir}${separator}${source.name}`;
                    if (source.path !== dest) {
                        await invoke('copy_file_or_dir', {
                            sourcePath: source.path,
                            destinationPath: dest
                        });
                        showSuccess(`${t('common.success')}: ${source.name}`);
                        loadPaneDirectory(targetPane, targetDir);
                    }
                    return;
                }
            }
        } catch (_) {}

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            let count = 0;
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const f = e.dataTransfer.files[i];
                if (f.path) {
                    const dest = targetDir.endsWith(separator)
                        ? `${targetDir}${f.name}`
                        : `${targetDir}${separator}${f.name}`;
                    try {
                        await invoke('copy_file_or_dir', {
                            sourcePath: f.path,
                            destinationPath: dest
                        });
                        count++;
                    } catch (err) {
                        console.error('File drop copy failed:', err);
                    }
                }
            }
            if (count > 0) {
                showSuccess(`${t('common.success')}: ${count} ${t('common.items')}`);
                loadPaneDirectory(targetPane, targetDir);
            }
        }
    };

    // Up directory navigation
    const handleGoUp = (pane) => {
        const current = pane === 'left' ? leftPath : rightPath;
        if (!current) return;
        const separator = current.includes('/') ? '/' : '\\';
        const parts = current.replace(/[\\/]+$/, '').split(separator);
        if (parts.length > 1) {
            parts.pop();
            const parent = parts.join(separator) || (separator === '/' ? '/' : parts[0] + '\\');
            loadPaneDirectory(pane, parent);
            if (activePane === pane) navigateTo(parent);
        }
    };

    // Swap panes
    const handleSwapPanes = () => {
        const tempPath = leftPath;
        const tempData = leftDirData;
        const tempSelected = leftSelected;

        setLeftPath(rightPath);
        setLeftDirData(rightDirData);
        setLeftSelected(rightSelected);

        setRightPath(tempPath);
        setRightDirData(tempData);
        setRightSelected(tempSelected);

        localStorage.setItem('explr_dual_pane_left', rightPath);
        localStorage.setItem('explr_dual_pane_right', tempPath);

        const currentActivePath = activePane === 'left' ? rightPath : tempPath;
        navigateTo(currentActivePath);
    };

    // Equalize: make target pane match active pane
    const handleEqualize = () => {
        const sourcePath = activePane === 'left' ? leftPath : rightPath;
        const targetPane = activePane === 'left' ? 'right' : 'left';
        loadPaneDirectory(targetPane, sourcePath);
    };

    // Copy to opposite pane
    const handleCopyToOpposite = async () => {
        const isLeft = activePane === 'left';
        const sourceItems = isLeft ? leftSelected : rightSelected;
        const targetDir = isLeft ? rightPath : leftPath;
        const targetPane = isLeft ? 'right' : 'left';

        if (!sourceItems || sourceItems.length === 0) {
            showError(t('common.error') + ': ' + t('toolbar.copy') + ' - ' + t('common.selected') + ' 0');
            return;
        }

        const separator = targetDir.includes('/') ? '/' : '\\';
        let copied = 0;

        for (const item of sourceItems) {
            try {
                const dest = targetDir.endsWith(separator)
                    ? `${targetDir}${item.name}`
                    : `${targetDir}${separator}${item.name}`;
                await invoke('copy_file_or_dir', {
                    sourcePath: item.path,
                    destinationPath: dest
                });
                copied++;
            } catch (e) {
                console.error('Copy failed:', e);
                showError(`${t('common.error')}: ${item.name}`);
            }
        }

        if (copied > 0) {
            showSuccess(`${t('common.success')}: ${copied} ${t('common.items')}`);
            loadPaneDirectory(targetPane, targetDir);
        }
    };

    // Move to opposite pane
    const handleMoveToOpposite = async () => {
        const isLeft = activePane === 'left';
        const sourceItems = isLeft ? leftSelected : rightSelected;
        const targetDir = isLeft ? rightPath : leftPath;
        const sourceDir = isLeft ? leftPath : rightPath;
        const targetPane = isLeft ? 'right' : 'left';
        const sourcePane = activePane;

        if (!sourceItems || sourceItems.length === 0) {
            return;
        }

        const separator = targetDir.includes('/') ? '/' : '\\';
        let moved = 0;

        for (const item of sourceItems) {
            try {
                const dest = targetDir.endsWith(separator)
                    ? `${targetDir}${item.name}`
                    : `${targetDir}${separator}${item.name}`;
                try {
                    await invoke('rename', { oldPath: item.path, newPath: dest });
                } catch (_) {
                    await invoke('copy_file_or_dir', { sourcePath: item.path, destinationPath: dest });
                    await invoke('move_to_trash', { path: item.path });
                }
                moved++;
            } catch (e) {
                console.error('Move failed:', e);
                showError(`${t('common.error')}: ${item.name}`);
            }
        }

        if (moved > 0) {
            showSuccess(`${t('common.success')}: ${moved} ${t('common.items')}`);
            loadPaneDirectory(targetPane, targetDir);
            loadPaneDirectory(sourcePane, sourceDir);
        }
    };

    // Delete selected items in active pane
    const handleDeleteSelected = async () => {
        const isLeft = activePane === 'left';
        const sourceItems = isLeft ? leftSelected : rightSelected;
        const currentDir = isLeft ? leftPath : rightPath;

        if (!sourceItems || sourceItems.length === 0) return;

        const itemNames = sourceItems.map(item => item.name).join(', ');
        const confirmMessage = `Are you sure you want to move ${sourceItems.length === 1 ? itemNames : `${sourceItems.length} items`} to trash?`;
        const shouldDelete = await showConfirm(confirmMessage, 'Move to Trash');
        if (!shouldDelete) return;

        let deleted = 0;
        for (const item of sourceItems) {
            try {
                await invoke('move_to_trash', { path: item.path });
                deleted++;
            } catch (err) {
                console.error('Failed to move to trash:', err);
                showError(`${t('common.error')}: ${item.name}`);
            }
        }

        if (deleted > 0) {
            showSuccess(`${t('common.success')}: ${deleted} ${t('common.items')}`);
            if (isLeft) {
                setLeftSelected([]);
            } else {
                setRightSelected([]);
            }
            loadPaneDirectory(activePane, currentDir);
        }
    };

    // Keyboard shortcuts (F5: copy, F6: move, Tab: switch pane, Delete: delete, Backspace: up, Ctrl+A: select all)
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable) return;

            if (e.key === 'F5') {
                e.preventDefault();
                handleCopyToOpposite();
            } else if (e.key === 'F6') {
                e.preventDefault();
                handleMoveToOpposite();
            } else if (e.key === 'Tab') {
                e.preventDefault();
                handleActivate(activePane === 'left' ? 'right' : 'left');
            } else if (e.key === 'Delete') {
                e.preventDefault();
                handleDeleteSelected();
            } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
                e.preventDefault();
                handleGoUp(activePane);
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
                e.preventDefault();
                const activeData = activePane === 'left' ? leftDirData : rightDirData;
                if (activeData) {
                    const allItems = [
                        ...(activeData.directories || []).map(d => ({ ...d, isDirectory: true })),
                        ...(activeData.files || []).map(f => ({ ...f, isDirectory: false }))
                    ];
                    if (activePane === 'left') {
                        setLeftSelected(allItems);
                    } else {
                        setRightSelected(allItems);
                    }
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                if (activePane === 'left') {
                    setLeftSelected([]);
                } else {
                    setRightSelected([]);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activePane, leftSelected, rightSelected, leftPath, rightPath, leftDirData, rightDirData, handleCopyToOpposite, handleMoveToOpposite, handleGoUp, handleDeleteSelected]);

    // Selection handlers for left pane
    const handleLeftSelect = (item, multi) => {
        setLeftSelected(prev => {
            if (multi) {
                const exists = prev.some(i => i.path === item.path);
                return exists ? prev.filter(i => i.path !== item.path) : [...prev, item];
            }
            return [item];
        });
    };

    // Selection handlers for right pane
    const handleRightSelect = (item, multi) => {
        setRightSelected(prev => {
            if (multi) {
                const exists = prev.some(i => i.path === item.path);
                return exists ? prev.filter(i => i.path !== item.path) : [...prev, item];
            }
            return [item];
        });
    };

    const leftItemCount = (leftDirData?.directories?.length || 0) + (leftDirData?.files?.length || 0);
    const rightItemCount = (rightDirData?.directories?.length || 0) + (rightDirData?.files?.length || 0);

    return (
        <div className="dual-pane-wrapper">
            {/* Dual Pane Action Bar */}
            <div className="dual-pane-toolbar">
                <div className="dual-pane-toolbar-group">
                    <button
                        className="dual-pane-btn primary"
                        onClick={handleCopyToOpposite}
                        title={t('dualPane.copyToOpposite')}
                    >
                        {activePane === 'left' ? '➔ ' + t('dualPane.copyToOpposite') : '⬅ ' + t('dualPane.copyToOpposite')}
                    </button>
                    <button
                        className="dual-pane-btn"
                        onClick={handleMoveToOpposite}
                        title={t('dualPane.moveToOpposite')}
                    >
                        {t('dualPane.moveToOpposite')}
                    </button>
                    <button
                        className="dual-pane-btn"
                        onClick={handleSwapPanes}
                        title={t('dualPane.swapPanes')}
                    >
                        ⇄ {t('dualPane.swapPanes')}
                    </button>
                    <button
                        className="dual-pane-btn"
                        onClick={handleEqualize}
                        title="Equalize (A = B)"
                    >
                        =
                    </button>
                </div>

                <div className="dual-pane-toolbar-group">
                    <button
                        className="dual-pane-btn"
                        onClick={onClose}
                        title="Close Split View"
                    >
                        ✕ {t('common.close')}
                    </button>
                </div>
            </div>

            {/* Split Panes Container */}
            <div className="dual-pane-container">
                {/* Left Pane */}
                <div
                    className={`dual-pane-panel ${activePane === 'left' ? 'active' : ''}`}
                    onClick={() => handleActivate('left')}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                    onDrop={(e) => handlePaneDrop('left', e)}
                >
                    <div className="dual-pane-header">
                        <div className="dual-pane-title-area">
                            <span className="dual-pane-badge">
                                {activePane === 'left' ? t('dualPane.active') : t('dualPane.leftPane')}
                            </span>
                            <span className="dual-pane-path" title={leftPath}>
                                {leftPath}
                            </span>
                        </div>

                        <div className="dual-pane-header-actions">
                            {volumes && volumes.length > 0 && (
                                <div className="dual-pane-drives">
                                    {volumes.map(vol => (
                                        <button
                                            key={vol.mount_point}
                                            className={`dual-pane-drive-btn ${leftPath.startsWith(vol.mount_point) ? 'active' : ''}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                loadPaneDirectory('left', vol.mount_point);
                                                handleActivate('left');
                                            }}
                                            title={vol.volume_name || vol.mount_point}
                                        >
                                            {vol.mount_point.replace(/[\\/]/g, '')}
                                        </button>
                                    ))}
                                </div>
                            )}

                            <button
                                className="dual-pane-mini-btn"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleGoUp('left');
                                }}
                                title={t('dualPane.up')}
                            >
                                ↑
                            </button>
                            <button
                                className="dual-pane-mini-btn"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    loadPaneDirectory('left', leftPath);
                                }}
                                title={t('common.refresh')}
                            >
                                ⟳
                            </button>
                        </div>
                    </div>

                    <div className="dual-pane-content">
                        <FileList
                            data={leftDirData}
                            isLoading={leftLoading}
                            viewMode={viewMode}
                            disableArrowKeys={isPreviewOpen}
                            onColumnsChange={onColumnsChange}
                            selectedItems={leftSelected}
                            onSelectItem={handleLeftSelect}
                            onClearSelection={() => setLeftSelected([])}
                            onLoadDirectory={(p) => {
                                loadPaneDirectory('left', p);
                                if (activePane === 'left') navigateTo(p);
                            }}
                            onOpenFile={openFile}
                            focusedItem={leftFocused}
                            onSetFocusedItem={setLeftFocused}
                        />
                    </div>

                    <div className="dual-pane-footer">
                        <span>{leftItemCount} {t('common.items')}</span>
                        {leftSelected.length > 0 && (
                            <span>{leftSelected.length} {t('common.selected')}</span>
                        )}
                    </div>
                </div>

                {/* Right Pane */}
                <div
                    className={`dual-pane-panel ${activePane === 'right' ? 'active' : ''}`}
                    onClick={() => handleActivate('right')}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                    onDrop={(e) => handlePaneDrop('right', e)}
                >
                    <div className="dual-pane-header">
                        <div className="dual-pane-title-area">
                            <span className="dual-pane-badge">
                                {activePane === 'right' ? t('dualPane.active') : t('dualPane.rightPane')}
                            </span>
                            <span className="dual-pane-path" title={rightPath}>
                                {rightPath}
                            </span>
                        </div>

                        <div className="dual-pane-header-actions">
                            {volumes && volumes.length > 0 && (
                                <div className="dual-pane-drives">
                                    {volumes.map(vol => (
                                        <button
                                            key={vol.mount_point}
                                            className={`dual-pane-drive-btn ${rightPath.startsWith(vol.mount_point) ? 'active' : ''}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                loadPaneDirectory('right', vol.mount_point);
                                                handleActivate('right');
                                            }}
                                            title={vol.volume_name || vol.mount_point}
                                        >
                                            {vol.mount_point.replace(/[\\/]/g, '')}
                                        </button>
                                    ))}
                                </div>
                            )}

                            <button
                                className="dual-pane-mini-btn"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleGoUp('right');
                                }}
                                title={t('dualPane.up')}
                            >
                                ↑
                            </button>
                            <button
                                className="dual-pane-mini-btn"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    loadPaneDirectory('right', rightPath);
                                }}
                                title={t('common.refresh')}
                            >
                                ⟳
                            </button>
                        </div>
                    </div>

                    <div className="dual-pane-content">
                        <FileList
                            data={rightDirData}
                            isLoading={rightLoading}
                            viewMode={viewMode}
                            disableArrowKeys={isPreviewOpen}
                            onColumnsChange={onColumnsChange}
                            selectedItems={rightSelected}
                            onSelectItem={handleRightSelect}
                            onClearSelection={() => setRightSelected([])}
                            onLoadDirectory={(p) => {
                                loadPaneDirectory('right', p);
                                if (activePane === 'right') navigateTo(p);
                            }}
                            onOpenFile={openFile}
                            focusedItem={rightFocused}
                            onSetFocusedItem={setRightFocused}
                        />
                    </div>

                    <div className="dual-pane-footer">
                        <span>{rightItemCount} {t('common.items')}</span>
                        {rightSelected.length > 0 && (
                            <span>{rightSelected.length} {t('common.selected')}</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DualPane;
