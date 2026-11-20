import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useHistory } from '../../providers/HistoryProvider';
import { useSettings } from '../../providers/SettingsProvider';
import { useSftp } from '../../providers/SftpProvider';
import { useTranslation } from '../../i18n';
import { getDirectoryPath, isRootPath, joinPath, normalizePath } from '../../utils/pathUtils';
import { showSuccess, showError, showConfirm, showInfo } from '../../utils/NotificationSystem';
import FileList from './FileList';
import './dualPane.css';

const isSameNormalizedPath = (pathA, pathB, isSftp) => {
    const normA = normalizePath(pathA);
    const normB = normalizePath(pathB);
    if (!normA || !normB) return false;
    return isSftp ? normA === normB : normA.toLowerCase() === normB.toLowerCase();
};

/**
 * Compares two directory listings by entry name and file size.
 * @returns {{ leftDiffPaths: Set<string>, rightDiffPaths: Set<string>, leftOnlyCount: number, rightOnlyCount: number, modifiedCount: number }}
 */
const computeDirectoryDiff = (leftData, rightData) => {
    const leftDiffPaths = new Set();
    const rightDiffPaths = new Set();
    let leftOnlyCount = 0;
    let rightOnlyCount = 0;
    let modifiedCount = 0;

    if (!leftData || !rightData) {
        return { leftDiffPaths, rightDiffPaths, leftOnlyCount, rightOnlyCount, modifiedCount };
    }

    const leftDirs = new Map((leftData.directories || []).map(d => [d.name, d]));
    const rightDirs = new Map((rightData.directories || []).map(d => [d.name, d]));

    for (const [name, dir] of leftDirs) {
        if (!rightDirs.has(name)) {
            leftDiffPaths.add(dir.path);
            leftOnlyCount++;
        }
    }
    for (const [name, dir] of rightDirs) {
        if (!leftDirs.has(name)) {
            rightDiffPaths.add(dir.path);
            rightOnlyCount++;
        }
    }

    const leftFiles = new Map((leftData.files || []).map(f => [f.name, f]));
    const rightFiles = new Map((rightData.files || []).map(f => [f.name, f]));

    for (const [name, file] of leftFiles) {
        const match = rightFiles.get(name);
        if (!match) {
            leftDiffPaths.add(file.path);
            leftOnlyCount++;
        } else if (file.size_in_bytes !== match.size_in_bytes) {
            leftDiffPaths.add(file.path);
            rightDiffPaths.add(match.path);
            modifiedCount++;
        }
    }
    for (const [name, file] of rightFiles) {
        if (!leftFiles.has(name)) {
            rightDiffPaths.add(file.path);
            rightOnlyCount++;
        }
    }

    return { leftDiffPaths, rightDiffPaths, leftOnlyCount, rightOnlyCount, modifiedCount };
};

/**
 * DualPane component for side-by-side directory browsing and fast file transfers.
 */
const DualPane = ({ viewMode = 'grid', isPreviewOpen = false, onColumnsChange, onClose }) => {
    const { volumes, openFile } = useFileSystem();
    const { currentPath, navigateTo } = useHistory();
    const { settings } = useSettings();
    const { isSftpPath, loadSftpDirectory } = useSftp();
    const { t } = useTranslation();

    const [activePane, setActivePane] = useState('left');
    const activePaneRef = useRef('left');

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
    const [compareActive, setCompareActive] = useState(false);
    const [showDiffOnly, setShowDiffOnly] = useState(false);

    const leftPathRef = useRef(leftPath);
    const rightPathRef = useRef(rightPath);

    useEffect(() => {
        activePaneRef.current = activePane;
    }, [activePane]);

    useEffect(() => {
        leftPathRef.current = leftPath;
    }, [leftPath]);

    useEffect(() => {
        rightPathRef.current = rightPath;
    }, [rightPath]);

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
    const loadPaneDirectory = useCallback(async (pane, path, shouldNavigate) => {
        if (!path) return;
        if (pane === 'left') setLeftLoading(true);
        else setRightLoading(true);

        try {
            let parsed;
            if (isSftpPath(path)) {
                parsed = await loadSftpDirectory(path);
                if (!parsed) return;
            } else {
                const raw = await invoke('open_directory', { path });
                parsed = JSON.parse(raw);
            }
            const filtered = filterData(parsed);
            const doNavigate = shouldNavigate !== undefined ? shouldNavigate : (activePaneRef.current === pane);

            if (pane === 'left') {
                leftPathRef.current = path;
                setLeftDirData(filtered);
                setLeftPath(path);
                setLeftSelected([]);
                localStorage.setItem('explr_dual_pane_left', path);
                if (doNavigate) navigateTo(path);
            } else {
                rightPathRef.current = path;
                setRightDirData(filtered);
                setRightPath(path);
                setRightSelected([]);
                localStorage.setItem('explr_dual_pane_right', path);
                if (doNavigate) navigateTo(path);
            }
        } catch (err) {
            console.error(`Failed to load directory ${path} in ${pane} pane:`, err);
            showError(`Failed to load ${path}: ${err}`);
        } finally {
            if (pane === 'left') setLeftLoading(false);
            else setRightLoading(false);
        }
    }, [filterData, navigateTo, isSftpPath, loadSftpDirectory]);

    // Initial load for both panes
    useEffect(() => {
        loadPaneDirectory('left', leftPath, true);
        loadPaneDirectory('right', rightPath, false);
    }, []);

    // Sync external navigation (e.g. breadcrumbs or sidebar clicks) with active pane
    const prevCurrentPathRef = useRef(currentPath);
    useEffect(() => {
        if (!currentPath || currentPath === prevCurrentPathRef.current) return;
        prevCurrentPathRef.current = currentPath;
        const pane = activePaneRef.current;
        const currentPanePath = pane === 'left' ? leftPathRef.current : rightPathRef.current;
        if (currentPath !== currentPanePath) {
            loadPaneDirectory(pane, currentPath, false);
        }
    }, [currentPath, loadPaneDirectory]);

    // Activate pane and sync global history
    const handleActivate = useCallback((pane) => {
        activePaneRef.current = pane;
        setActivePane(pane);
        const path = pane === 'left' ? leftPathRef.current : rightPathRef.current;
        if (path) {
            navigateTo(path);
        }
    }, [navigateTo]);

    // Drag and drop handler between panes or from external sources
    const handlePaneDrop = async (targetPane, e) => {
        e.preventDefault();
        e.stopPropagation();

        const targetDir = targetPane === 'left' ? leftPath : rightPath;
        if (!targetDir) return;

        try {
            const raw = e.dataTransfer.getData('application/json');
            if (raw) {
                const source = JSON.parse(raw);
                if (source && source.path) {
                    const dest = joinPath(targetDir, source.name);
                    const isSftp = isSftpPath(source.path) || isSftpPath(dest);
                    if (!isSameNormalizedPath(source.path, dest, isSftp)) {
                        await invoke('copy_file_or_dir', {
                            sourcePath: source.path,
                            destinationPath: dest
                        });
                        showSuccess(`${t('common.success')}: ${source.name}`);
                        loadPaneDirectory(targetPane, targetDir, false);
                    }
                    return;
                }
            }
        } catch (err) {
            console.error('Pane drop failed:', err);
            showError(`${t('common.error')}: ${err?.message || err}`);
        }

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            let count = 0;
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const f = e.dataTransfer.files[i];
                if (f.path) {
                    const dest = joinPath(targetDir, f.name);
                    const isSftp = isSftpPath(f.path) || isSftpPath(dest);
                    if (isSameNormalizedPath(f.path, dest, isSftp)) continue;
                    try {
                        await invoke('copy_file_or_dir', {
                            sourcePath: f.path,
                            destinationPath: dest
                        });
                        count++;
                    } catch (err) {
                        console.error('File drop copy failed:', err);
                        showError(`${t('common.error')}: ${f.name}`);
                    }
                }
            }
            if (count > 0) {
                showSuccess(`${t('common.success')}: ${count} ${t('common.items')}`);
                loadPaneDirectory(targetPane, targetDir, false);
            }
        }
    };

    // Up directory navigation
    const handleGoUp = useCallback((pane) => {
        const current = pane === 'left' ? leftPathRef.current : rightPathRef.current;
        if (!current || isRootPath(current)) return;
        const parent = getDirectoryPath(current);
        if (parent && parent !== current) {
            loadPaneDirectory(pane, parent, activePaneRef.current === pane);
        }
    }, [loadPaneDirectory]);

    // Swap panes
    const handleSwapPanes = () => {
        const tempPath = leftPath;
        const tempData = leftDirData;
        const tempSelected = leftSelected;
        const tempFocused = leftFocused;

        leftPathRef.current = rightPath;
        rightPathRef.current = tempPath;

        setLeftPath(rightPath);
        setLeftDirData(rightDirData);
        setLeftSelected(rightSelected);
        setLeftFocused(rightFocused);

        setRightPath(tempPath);
        setRightDirData(tempData);
        setRightSelected(tempSelected);
        setRightFocused(tempFocused);

        localStorage.setItem('explr_dual_pane_left', rightPath);
        localStorage.setItem('explr_dual_pane_right', tempPath);

        const currentActivePath = activePane === 'left' ? rightPath : tempPath;
        navigateTo(currentActivePath);
    };

    // Equalize: make target pane match active pane
    const handleEqualize = () => {
        const sourcePath = activePane === 'left' ? leftPath : rightPath;
        const targetPane = activePane === 'left' ? 'right' : 'left';
        loadPaneDirectory(targetPane, sourcePath, false);
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

        let copied = 0;

        for (const item of sourceItems) {
            try {
                const dest = joinPath(targetDir, item.name);
                const isSftp = isSftpPath(item.path) || isSftpPath(dest);
                if (isSameNormalizedPath(item.path, dest, isSftp)) {
                    continue;
                }
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
            loadPaneDirectory(targetPane, targetDir, false);
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

        const isSftp = isSftpPath(sourceDir) || isSftpPath(targetDir);
        if (isSameNormalizedPath(sourceDir, targetDir, isSftp)) {
            showError(`${t('common.error')}: Source and destination directories are identical`);
            return;
        }

        let moved = 0;

        for (const item of sourceItems) {
            try {
                const dest = joinPath(targetDir, item.name);
                if (isSameNormalizedPath(item.path, dest, isSftpPath(item.path) || isSftpPath(dest))) {
                    continue;
                }
                try {
                    await invoke('rename', { oldPath: item.path, newPath: dest });
                } catch (_) {
                    await invoke('copy_file_or_dir', { sourcePath: item.path, destinationPath: dest });
                    if (!isSameNormalizedPath(item.path, dest, isSftpPath(item.path) || isSftpPath(dest))) {
                        await invoke('move_to_trash', { path: item.path });
                    }
                }
                moved++;
            } catch (e) {
                console.error('Move failed:', e);
                showError(`${t('common.error')}: ${item.name}`);
            }
        }

        if (moved > 0) {
            showSuccess(`${t('common.success')}: ${moved} ${t('common.items')}`);
            loadPaneDirectory(targetPane, targetDir, false);
            loadPaneDirectory(sourcePane, sourceDir, true);
        }
    };

    // Delete selected items in active pane
    const handleDeleteSelected = async () => {
        const isLeft = activePane === 'left';
        const rawItems = isLeft ? leftSelected : rightSelected;
        const focused = isLeft ? leftFocused : rightFocused;
        const sourceItems = (rawItems && rawItems.length > 0) ? rawItems : (focused ? [focused] : []);
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
                setLeftFocused(null);
            } else {
                setRightSelected([]);
                setRightFocused(null);
            }
            loadPaneDirectory(activePane, currentDir);
        }
    };

    // Keyboard shortcuts (F5: copy, Shift+F6: move, Tab: switch pane, Delete: delete, Backspace: up, Ctrl+A: select all, F2: rename)
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable) return;
            if (document.querySelector('[role="dialog"], .modal-overlay, .preview-modal-backdrop')) return;

            if (e.key === 'F5') {
                e.preventDefault();
                handleCopyToOpposite();
            } else if (e.key === 'F6' && e.shiftKey) {
                e.preventDefault();
                handleMoveToOpposite();
            } else if (e.key === 'Tab') {
                e.preventDefault();
                handleActivate(activePane === 'left' ? 'right' : 'left');
            } else if (e.key === 'Delete') {
                e.preventDefault();
                handleDeleteSelected();
            } else if (e.key === 'F2') {
                const isLeft = activePane === 'left';
                const rawItems = isLeft ? leftSelected : rightSelected;
                const focused = isLeft ? leftFocused : rightFocused;
                const target = (rawItems && rawItems.length === 1) ? rawItems[0] : (focused || null);
                if (target) {
                    e.preventDefault();
                    document.dispatchEvent(new CustomEvent('open-rename-modal', {
                        detail: { item: target }
                    }));
                }
            } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
                e.preventDefault();
                handleGoUp(activePane);
            } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyA' || e.key === 'a' || e.key === 'A')) {
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
    }, [activePane, leftSelected, rightSelected, leftFocused, rightFocused, leftPath, rightPath, leftDirData, rightDirData, handleCopyToOpposite, handleMoveToOpposite, handleGoUp, handleDeleteSelected]);

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

    const diffResult = useMemo(
        () => (compareActive ? computeDirectoryDiff(leftDirData, rightDirData) : null),
        [compareActive, leftDirData, rightDirData]
    );

    const displayedLeftData = useMemo(() => {
        if (!compareActive || !showDiffOnly || !leftDirData || !diffResult) return leftDirData;
        return {
            ...leftDirData,
            directories: (leftDirData.directories || []).filter(d => diffResult.leftDiffPaths.has(d.path)),
            files: (leftDirData.files || []).filter(f => diffResult.leftDiffPaths.has(f.path)),
        };
    }, [compareActive, showDiffOnly, leftDirData, diffResult]);

    const displayedRightData = useMemo(() => {
        if (!compareActive || !showDiffOnly || !rightDirData || !diffResult) return rightDirData;
        return {
            ...rightDirData,
            directories: (rightDirData.directories || []).filter(d => diffResult.rightDiffPaths.has(d.path)),
            files: (rightDirData.files || []).filter(f => diffResult.rightDiffPaths.has(f.path)),
        };
    }, [compareActive, showDiffOnly, rightDirData, diffResult]);

    const handleToggleCompare = useCallback(() => {
        if (compareActive) {
            setCompareActive(false);
            setShowDiffOnly(false);
            return;
        }
        const diff = computeDirectoryDiff(leftDirData, rightDirData);
        setCompareActive(true);

        if (leftDirData) {
            const leftDiffItems = [
                ...(leftDirData.directories || []).filter(d => diff.leftDiffPaths.has(d.path)).map(d => ({ ...d, isDirectory: true })),
                ...(leftDirData.files || []).filter(f => diff.leftDiffPaths.has(f.path)).map(f => ({ ...f, isDirectory: false })),
            ];
            setLeftSelected(leftDiffItems);
        }
        if (rightDirData) {
            const rightDiffItems = [
                ...(rightDirData.directories || []).filter(d => diff.rightDiffPaths.has(d.path)).map(d => ({ ...d, isDirectory: true })),
                ...(rightDirData.files || []).filter(f => diff.rightDiffPaths.has(f.path)).map(f => ({ ...f, isDirectory: false })),
            ];
            setRightSelected(rightDiffItems);
        }

        const totalDiffs = diff.leftOnlyCount + diff.rightOnlyCount + diff.modifiedCount;
        if (totalDiffs === 0) {
            showSuccess('Directories match');
        } else {
            showInfo(`Compare: ${diff.leftOnlyCount} left only, ${diff.rightOnlyCount} right only, ${diff.modifiedCount} modified`);
        }
    }, [compareActive, leftDirData, rightDirData]);

    const leftItemCount = (displayedLeftData?.directories?.length || 0) + (displayedLeftData?.files?.length || 0);
    const rightItemCount = (displayedRightData?.directories?.length || 0) + (displayedRightData?.files?.length || 0);

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
                        title={`${t('dualPane.moveToOpposite')} (Shift+F6)`}
                    >
                        {t('dualPane.moveToOpposite')} (Shift+F6)
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
                    <button
                        className={`dual-pane-btn ${compareActive ? 'primary' : ''}`}
                        onClick={handleToggleCompare}
                        title="Compare directories"
                    >
                        ≠ Compare
                    </button>
                    {compareActive && (
                        <button
                            className={`dual-pane-btn ${showDiffOnly ? 'primary' : ''}`}
                            onClick={() => setShowDiffOnly(prev => !prev)}
                            title="Show differences only"
                        >
                            {showDiffOnly ? 'Show All' : 'Diff Only'}
                        </button>
                    )}
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
                                                activePaneRef.current = 'left';
                                                setActivePane('left');
                                                loadPaneDirectory('left', vol.mount_point, true);
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
                            data={displayedLeftData}
                            isLoading={leftLoading}
                            viewMode={viewMode}
                            isActive={activePane === 'left'}
                            targetDirectory={leftPath}
                            onRefresh={() => loadPaneDirectory('left', leftPathRef.current, false)}
                            disableArrowKeys={isPreviewOpen}
                            onColumnsChange={onColumnsChange}
                            selectedItems={leftSelected}
                            onSelectItem={handleLeftSelect}
                            onSelectMultiple={setLeftSelected}
                            onClearSelection={() => setLeftSelected([])}
                            onLoadDirectory={(p) => {
                                loadPaneDirectory('left', p, activePaneRef.current === 'left');
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
                                                activePaneRef.current = 'right';
                                                setActivePane('right');
                                                loadPaneDirectory('right', vol.mount_point, true);
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
                            data={displayedRightData}
                            isLoading={rightLoading}
                            viewMode={viewMode}
                            isActive={activePane === 'right'}
                            targetDirectory={rightPath}
                            onRefresh={() => loadPaneDirectory('right', rightPathRef.current, false)}
                            disableArrowKeys={isPreviewOpen}
                            onColumnsChange={onColumnsChange}
                            selectedItems={rightSelected}
                            onSelectItem={handleRightSelect}
                            onSelectMultiple={setRightSelected}
                            onClearSelection={() => setRightSelected([])}
                            onLoadDirectory={(p) => {
                                loadPaneDirectory('right', p, activePaneRef.current === 'right');
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
