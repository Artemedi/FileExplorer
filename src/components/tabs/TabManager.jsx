import React, { useState, useEffect, useRef } from 'react';
import { useHistory } from '../../providers/HistoryProvider';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useSftp } from '../../providers/SftpProvider';
import { useTranslation } from '../../i18n';
import IconButton from '../common/IconButton';
import './tabs.css';

/**
 * TabManager component - Manages multiple tabs for file explorer navigation
 *
 * @param {Object} props - Component props
 * @param {React.ReactNode} props.children - Child components to render in the active tab
 * @returns {React.ReactElement} TabManager component
 */
const TabManager = ({ children }) => {
    const [tabs, setTabs] = useState(() => {
        try {
            const saved = localStorage.getItem('explr_saved_tabs');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed;
                }
            }
        } catch (e) {
            console.error('Failed to parse saved tabs:', e);
        }
        return [];
    });
    const [activeTabId, setActiveTabId] = useState(() => {
        try {
            const savedId = localStorage.getItem('explr_active_tab_id');
            if (savedId) return savedId;
        } catch (_) {}
        return null;
    });
    const { currentPath } = useHistory();
    const { loadDirectory } = useFileSystem();
    const { isSftpPath, parseSftpPath } = useSftp();
    const { t } = useTranslation();
    const [contextMenu, setContextMenu] = useState(null);
    const draggedTabIndexRef = useRef(-1);

    useEffect(() => {
        const hideMenu = () => setContextMenu(null);
        window.addEventListener('click', hideMenu);
        return () => window.removeEventListener('click', hideMenu);
    }, []);

    const closeOtherTabs = (tabId) => {
        setTabs(prev => prev.filter(t => t.id === tabId));
        switchToTab(tabId);
        setContextMenu(null);
    };

    const handleCopyPath = (path) => {
        if (path) {
            navigator.clipboard.writeText(path).catch(() => {});
        }
        setContextMenu(null);
    };

    // Persist tabs to localStorage
    useEffect(() => {
        if (tabs.length > 0) {
            try {
                localStorage.setItem('explr_saved_tabs', JSON.stringify(tabs));
            } catch (e) {
                console.error('Failed to save tabs:', e);
            }
        }
    }, [tabs]);

    // Persist active tab ID
    useEffect(() => {
        if (activeTabId) {
            try {
                localStorage.setItem('explr_active_tab_id', activeTabId);
            } catch (_) {}
        }
    }, [activeTabId]);

    // Restore active tab on mount
    useEffect(() => {
        if (tabs.length > 0) {
            const active = tabs.find(t => t.id === activeTabId) || tabs[0];
            setActiveTabId(active.id);
            if (active.path && active.path !== currentPath) {
                loadDirectory(active.path).catch(() => {});
            }
        }
    }, []);

    /**
     * Initialize with current path
     */
    useEffect(() => {
        if (currentPath && tabs.length === 0) {
            const initialTab = {
                id: generateTabId(),
                title: getTabTitle(currentPath),
                path: currentPath,
                isActive: true
            };
            setTabs([initialTab]);
            setActiveTabId(initialTab.id);
        }
    }, [currentPath, tabs.length]);

    /**
     * Update active tab when path changes
     */
    useEffect(() => {
        if (currentPath && activeTabId) {
            setTabs(prevTabs =>
                prevTabs.map(tab =>
                    tab.id === activeTabId
                        ? { ...tab, title: getTabTitle(currentPath), path: currentPath }
                        : tab
                )
            );
        }
    }, [currentPath, activeTabId]);

    /**
     * Generates a unique ID for a new tab
     * @returns {string} Unique tab ID
     */
    const generateTabId = () => {
        return 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    };

    /**
     * Extracts a display title from a file path
     * @param {string} path - The file path
     * @returns {string} The extracted tab title
     */
    const getTabTitle = (path) => {
        if (!path) return 'Home';
        
        // Handle SFTP paths
        if (isSftpPath(path)) {
            const parsed = parseSftpPath(path);
            if (parsed && parsed.connection) {
                const remotePath = parsed.remotePath || '.';
                if (remotePath === '.' || remotePath === '/') {
                    return parsed.connection.name;
                } else {
                    const segments = remotePath.split('/').filter(Boolean);
                    const folderName = segments.length > 0 ? segments[segments.length - 1] : parsed.connection.name;
                    return `${parsed.connection.name}: ${folderName}`;
                }
            }
            return 'SFTP';
        }
        
        // Handle regular file system paths
        const segments = path.split(/[/\\]/).filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] : 'Root';
    };

    /**
     * Gets the full path for tooltip display
     * @param {string} path - The file path
     * @returns {string} The full path for tooltip
     */
    const getFullPathForTooltip = (path) => {
        if (!path) return 'Home';
        
        // Handle SFTP paths - convert to standard format
        if (isSftpPath(path)) {
            const parsed = parseSftpPath(path);
            if (parsed && parsed.connection) {
                const remotePath = parsed.remotePath || '/';
                return `sftp://${parsed.connection.username}@${parsed.connection.host}:${parsed.connection.port}${remotePath}`;
            }
            return path;
        }
        
        // Return regular path as-is
        return path;
    };

    /**
     * Creates a new tab with the current path
     */
    const createNewTab = () => {
        const newTab = {
            id: generateTabId(),
            title: getTabTitle(currentPath),
            path: currentPath,
            isActive: false
        };

        setTabs(prevTabs => [...prevTabs, newTab]);
        setActiveTabId(newTab.id);
    };

    /**
     * Closes a tab and handles switching to another tab if needed
     * @param {string} tabId - ID of the tab to close
     * @param {React.MouseEvent} [event] - Optional click event
     */
    const closeTab = (tabId, event) => {
        event?.stopPropagation();

        if (tabs.length <= 1) return; // Don't close the last tab

        const tabIndex = tabs.findIndex(tab => tab.id === tabId);
        const isActiveTab = tabId === activeTabId;
        const remainingTabs = tabs.filter(tab => tab.id !== tabId);

        setTabs(remainingTabs);

        // If we closed the active tab, switch to another tab
        if (isActiveTab && remainingTabs.length > 0) {
            const nextTabIndex = Math.min(tabIndex, remainingTabs.length - 1);
            const nextTab = remainingTabs[nextTabIndex];
            setActiveTabId(nextTab.id);
            if (nextTab.path && nextTab.path !== currentPath) {
                loadDirectory(nextTab.path).catch(() => {});
            }
        }
    };

    /**
     * Switches to a different tab and loads its directory
     * @param {string} tabId - ID of the tab to switch to
     * @async
     */
    const switchToTab = async (tabId) => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return;

        setActiveTabId(tabId);

        // Load the directory for this tab
        if (tab.path !== currentPath) {
            try {
                await loadDirectory(tab.path);
            } catch (error) {
                console.error('Failed to load directory for tab:', error);
            }
        }
    };

    /**
     * Creates a duplicate of an existing tab
     * @param {string} tabId - ID of the tab to duplicate
     */
    const duplicateTab = (tabId) => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return;

        const duplicatedTab = {
            id: generateTabId(),
            title: tab.title,
            path: tab.path,
            isActive: false
        };

        const tabIndex = tabs.findIndex(t => t.id === tabId);
        const newTabs = [...tabs];
        newTabs.splice(tabIndex + 1, 0, duplicatedTab);

        setTabs(newTabs);
        setActiveTabId(duplicatedTab.id);
    };

    /**
     * Reorders tabs after a drag and drop operation
     * @param {number} dragIndex - Index of the tab being dragged
     * @param {number} hoverIndex - Index where the tab should be inserted
     */
    const reorderTabs = (dragIndex, hoverIndex) => {
        if (dragIndex < 0 || dragIndex >= tabs.length || hoverIndex < 0 || hoverIndex >= tabs.length || dragIndex === hoverIndex) {
            return;
        }
        const newTabs = [...tabs];
        const draggedTab = newTabs[dragIndex];
        newTabs.splice(dragIndex, 1);
        newTabs.splice(hoverIndex, 0, draggedTab);
        setTabs(newTabs);
    };

    /**
     * Handles double-click events to prevent text selection
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
    };

    /**
     * Handles mouse down events to prevent text selection
     * @param {React.MouseEvent} e - The mouse down event
     */
    const handleMouseDown = (e) => {
        // Prevent text selection on mouse down
        e.preventDefault();
    };

    /**
     * Handles selectstart events to prevent text selection
     * @param {React.SyntheticEvent} e - The selectstart event
     */
    const handleSelectStart = (e) => {
        // Prevent any text selection
        e.preventDefault();
        return false;
    };

    /**
     * Handles close button interactions with text selection prevention
     * @param {string} tabId - ID of the tab to close
     * @param {React.MouseEvent} e - The click event
     */
    const handleCloseTab = (tabId, e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Clear any existing text selection
        if (window.getSelection) {
            window.getSelection().removeAllRanges();
        }
        
        closeTab(tabId, e);
    };

    return (
        <div className="tab-manager">
            <div className="tab-bar">
                <div className="tab-list">
                    {tabs.map((tab, index) => (
                        <div
                            key={tab.id}
                            className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
                            onClick={() => switchToTab(tab.id)}
                            onDoubleClick={handleDoubleClick}
                            onMouseDown={handleMouseDown}
                            onSelectStart={handleSelectStart}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    tabId: tab.id,
                                    path: tab.path
                                });
                            }}
                            draggable
                            onDragStart={(e) => {
                                draggedTabIndexRef.current = index;
                                e.dataTransfer.setData('text/plain', '');
                                e.dataTransfer.effectAllowed = 'move';
                            }}
                            onDragOver={(e) => {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = 'move';
                            }}
                            onDrop={(e) => {
                                e.preventDefault();
                                const dragIndex = draggedTabIndexRef.current;
                                draggedTabIndexRef.current = -1;
                                reorderTabs(dragIndex, index);
                            }}
                        >
                            <div className="tab-content">
                                <span className="tab-icon">
                                    <span className="icon icon-folder"></span>
                                </span>
                                <span className="tab-title" title={getFullPathForTooltip(tab.path)}>
                                    {tab.title}
                                </span>
                                {tabs.length > 1 && (
                                    <button
                                        className="tab-close"
                                        onClick={(e) => handleCloseTab(tab.id, e)}
                                        onDoubleClick={handleDoubleClick}
                                        onMouseDown={handleMouseDown}
                                        onSelectStart={handleSelectStart}
                                        aria-label="Close tab"
                                    >
                                        <span className="icon icon-x"></span>
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                    
                    <div className="new-tab-button">
                        <IconButton
                            icon="plus"
                            size="sm"
                            onClick={createNewTab}
                        />
                    </div>
                </div>
            </div>

            <div className="tab-content-area">
                {children}
            </div>

            {contextMenu && (
                <div
                    className="tab-context-menu"
                    style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="tab-context-menu-item" onClick={() => { duplicateTab(contextMenu.tabId); setContextMenu(null); }}>
                        {t('tabs.duplicateTab')}
                    </div>
                    <div className="tab-context-menu-item" onClick={() => handleCopyPath(contextMenu.path)}>
                        {t('tabs.copyPath')}
                    </div>
                    <div className="tab-context-menu-divider" />
                    {tabs.length > 1 && (
                        <>
                            <div className="tab-context-menu-item" onClick={() => { closeTab(contextMenu.tabId); setContextMenu(null); }}>
                                {t('tabs.closeTab')}
                            </div>
                            <div className="tab-context-menu-item" onClick={() => closeOtherTabs(contextMenu.tabId)}>
                                {t('tabs.closeOtherTabs')}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export default TabManager;