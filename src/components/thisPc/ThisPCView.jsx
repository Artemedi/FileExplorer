import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useHistory } from '../../providers/HistoryProvider';
import { formatFileSize } from '../../utils/formatters';
import './thisPc.css';
import {showConfirm, showError, showSuccess} from "../../utils/NotificationSystem.js";
import DiskManagerModal from './DiskManagerModal';

/**
 * ThisPCView component - Displays system information, user folders, and storage drives
 * Similar to "This PC" or "My Computer" in Windows Explorer
 *
 * @returns {React.ReactElement} ThisPCView component
 */
const ThisPCView = () => {
    const [systemInfo, setSystemInfo] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const { volumes, loadDirectory, loadVolumes } = useFileSystem();
    const { navigateTo } = useHistory();

    // Common folders for different operating systems
    const [userFolders, setUserFolders] = useState([]);
    const [physicalDisks, setPhysicalDisks] = useState([]);
    const [disksLoading, setDisksLoading] = useState(false);
    const [disksError, setDisksError] = useState(null);
    const [diskActionState, setDiskActionState] = useState(null);
    const ejectTimerRef = useRef(null);

    const loadPhysicalDisks = async () => {
        setDisksLoading(true);
        setDisksError(null);
        try {
            const disks = await invoke('get_physical_disks_info');
            setPhysicalDisks(Array.isArray(disks) ? disks : []);
        } catch (error) {
            setDisksError(typeof error === 'string' ? error : (error?.message || 'Failed to load disk layout'));
        } finally {
            setDisksLoading(false);
        }
    };

    useEffect(() => {
        loadPhysicalDisks();
    }, []);

    useEffect(() => {
        return () => {
            if (ejectTimerRef.current) {
                clearTimeout(ejectTimerRef.current);
            }
        };
    }, []);

    /**
     * Load system information on component mount
     */
    useEffect(() => {
        loadSystemInfo();
    }, []);

    /**
     * Load user folders when systemInfo is available
     */
    useEffect(() => {
        if (systemInfo) {
            loadUserFolders();
        }
    }, [systemInfo]);

    /**
     * Loads system information from the backend
     * @async
     */
    const loadSystemInfo = async () => {
        try {
            const metaDataJson = await invoke('get_meta_data_as_json');
            const metaData = JSON.parse(metaDataJson);
            setSystemInfo(metaData);
        } catch (error) {
            console.error('Failed to load system info:', error);
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Loads user folders based on the current operating system
     * Checks which standard folders exist and adds them to the userFolders state
     * @async
     */
    const loadUserFolders = async () => {
        if (!systemInfo) return;

        console.log('Loading user folders for OS:', systemInfo.current_running_os);
        console.log('User home directory:', systemInfo.user_home_dir);

        const folders = [];

        try {
            // Get all possible paths for each folder type
            const videoPaths = getVideosPaths();
            console.log('Video paths to check:', videoPaths);

            // Common user folder paths - some folders might have multiple possible names
            const folderConfigs = [
                {
                    name: 'Desktop',
                    paths: [getDesktopPath()],
                    icon: 'desktop'
                },
                {
                    name: 'Documents',
                    paths: [getDocumentsPath()],
                    icon: 'documents'
                },
                {
                    name: 'Downloads',
                    paths: [getDownloadsPath()],
                    icon: 'downloads'
                },
                {
                    name: 'Pictures',
                    paths: [getPicturesPath()],
                    icon: 'pictures'
                },
                {
                    name: 'Music',
                    paths: [getMusicPath()],
                    icon: 'music'
                },
                {
                    name: 'Videos',
                    paths: videoPaths,
                    icon: 'videos'
                }
            ];

            // Check which folders exist for each configuration
            for (const config of folderConfigs) {
                let foundPath = null;

                console.log(`Checking ${config.name} with paths:`, config.paths);

                // Try each possible path for this folder type
                for (const path of config.paths) {
                    console.log(`Trying path: ${path}`);
                    try {
                        await invoke('open_directory', { path });
                        console.log(`Path exists and is accessible: ${path}`);
                        foundPath = path;
                        break; // Use the first path that works
                    } catch (error) {
                        console.log(`Path failed: ${path}`, error.message || error);
                        // This path doesn't exist or isn't accessible, try the next one
                        continue;
                    }
                }

                // If we found a working path, add it to the folders list
                if (foundPath) {
                    console.log(`Adding ${config.name} folder with path: ${foundPath}`);
                    folders.push({
                        name: config.name,
                        path: foundPath,
                        icon: config.icon
                    });
                } else {
                    console.log(`No accessible path found for ${config.name}`);
                }
            }
        } catch (error) {
            console.error('Failed to load user folders:', error);
        }

        console.log('Final user folders:', folders);
        setUserFolders(folders);
    };

    /**
     * Gets the desktop folder path based on the current OS
     * @returns {string} Desktop folder path
     */
    const getDesktopPath = () => {
        if (systemInfo.current_running_os === 'windows') {
            return `${systemInfo.user_home_dir}\\Desktop`;
        }
        return `${systemInfo.user_home_dir}/Desktop`;
    };

    /**
     * Gets the documents folder path based on the current OS
     * @returns {string} Documents folder path
     */
    const getDocumentsPath = () => {
        if (systemInfo.current_running_os === 'windows') {
            return `${systemInfo.user_home_dir}\\Documents`;
        }
        return `${systemInfo.user_home_dir}/Documents`;
    };

    /**
     * Gets the downloads folder path based on the current OS
     * @returns {string} Downloads folder path
     */
    const getDownloadsPath = () => {
        if (systemInfo.current_running_os === 'windows') {
            return `${systemInfo.user_home_dir}\\Downloads`;
        }
        return `${systemInfo.user_home_dir}/Downloads`;
    };

    /**
     * Gets the pictures folder path based on the current OS
     * @returns {string} Pictures folder path
     */
    const getPicturesPath = () => {
        if (systemInfo.current_running_os === 'windows') {
            return `${systemInfo.user_home_dir}\\Pictures`;
        }
        return `${systemInfo.user_home_dir}/Pictures`;
    };

    /**
     * Gets the music folder path based on the current OS
     * @returns {string} Music folder path
     */
    const getMusicPath = () => {
        if (systemInfo.current_running_os === 'windows') {
            return `${systemInfo.user_home_dir}\\Music`;
        }
        return `${systemInfo.user_home_dir}/Music`;
    };

    /**
     * Gets possible paths for videos folder based on the current OS
     * Handles different naming conventions across operating systems
     * @returns {Array<string>} Array of possible video folder paths
     */
    const getVideosPaths = () => {
        if (!systemInfo) {
            console.warn('getVideosPaths called without systemInfo');
            return [];
        }

        // Return an array of possible video folder paths
        let paths;
        if (systemInfo.current_running_os === 'windows') {
            paths = [
                `${systemInfo.user_home_dir}\\Videos`,
                `${systemInfo.user_home_dir}\\Movies`
            ];
        } else {
            paths = [
                `${systemInfo.user_home_dir}/Movies`,
                `${systemInfo.user_home_dir}/Videos`
            ];
        }

        console.log('Generated video paths:', paths);
        return paths;
    };

    /**
     * Handles clicking on a folder item
     * Navigates to the selected folder
     * @param {string} path - The path to navigate to
     * @async
     */
    const handleFolderClick = async (path) => {
        console.log('Clicking folder with path:', path);
        try {
            const ok = await loadDirectory(path);
            if (ok) {
                navigateTo(path);
            }
        } catch (error) {
            console.error('Failed to navigate to folder:', error);
            showError(`Cannot access ${path}. The folder may not exist or is inaccessible.`);
        }
    };

    /**
     * Handles clicking on a volume/drive item
     * @param {Object} volume - The volume object to navigate to
     */
    const handleVolumeClick = (volume) => {
        handleFolderClick(volume.mount_point);
    };

    /**
     * Safely ejects a removable volume
     * @param {Object} volume - The volume to eject
     * @async
     */
    const ejectVolume = async (volume) => {
        if (!volume.is_removable) return;

        const confirmEject = await showConfirm(`Are you sure you want to safely eject ${volume.volume_name}?`);
        if (!confirmEject) return;

        try {
            await invoke('eject_volume', { mountPoint: volume.mount_point });
            showSuccess(`${volume.volume_name} has been safely ejected.`);
            // Reload volumes to update the UI after ejection
            if (ejectTimerRef.current) {
                clearTimeout(ejectTimerRef.current);
            }
            ejectTimerRef.current = setTimeout(() => {
                loadVolumes();
            }, 1000);
        } catch (error) {
            console.error('Failed to eject volume:', error);
            let errorMessage = error?.message || String(error);

            // Parse error message if it's JSON
            try {
                const parsedError = JSON.parse(errorMessage);
                errorMessage = parsedError.custom_message || parsedError.error_message || errorMessage;
            } catch (e) {
                // If not JSON, use as-is
            }

            showError(`Failed to eject ${volume.volume_name}: ${errorMessage}`);
        }
    };

    if (isLoading) {
        return (
            <div className="this-pc-loading">
                <div className="spinner"></div>
                <p>Loading system information...</p>
            </div>
        );
    }

    return (
        <div className="this-pc-view">
            <div className="this-pc-header">
                <h2>This PC</h2>
                {systemInfo && (
                    <div className="system-info">
                        <span>Running {systemInfo.current_running_os}</span>
                        {systemInfo.current_cpu_architecture && (
                            <span> • {systemInfo.current_cpu_architecture}</span>
                        )}
                    </div>
                )}
            </div>

            {/* User Folders Section */}
            {userFolders.length > 0 && (
                <div className="pc-section">
                    <h3>Folders</h3>
                    <div className="folders-grid">
                        {userFolders.map((folder) => (
                            <div
                                key={folder.path}
                                className="folder-item"
                                onClick={() => handleFolderClick(folder.path)}
                            >
                                <div className="folder-icon">
                                    <span className={`icon icon-${folder.icon}`}></span>
                                </div>
                                <div className="folder-details">
                                    <div className="folder-name">{folder.name}</div>
                                    <div className="folder-path">{folder.path}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Drives Section */}
            <div className="pc-section">
                <h3>Drives</h3>
                <div className="drives-grid">
                    {volumes.map((volume) => {
                        const usedSpace = volume.size - volume.available_space;
                        const usedPercentage = volume.size > 0 ? (usedSpace / volume.size) * 100 : 0;

                        return (
                            <div
                                key={volume.mount_point}
                                className="drive-item"
                                onClick={() => handleVolumeClick(volume)}
                            >
                                <div className="drive-icon">
                                    <span className={`icon icon-${volume.is_removable ? 'usb' : 'drive'}`}></span>
                                </div>

                                <div className="drive-details">
                                    <div className="drive-name">
                                        {volume.volume_name || volume.mount_point}
                                    </div>
                                    <div className="drive-path">
                                        {volume.mount_point} • {volume.file_system}
                                    </div>

                                    <div className="drive-storage">
                                        <div className="storage-info">
                                            <span>{formatFileSize(volume.available_space)} free of {formatFileSize(volume.size)}</span>
                                        </div>
                                        <div className="storage-bar">
                                            <div
                                                className="storage-used"
                                                style={{ width: `${Math.min(usedPercentage, 100)}%` }}
                                            ></div>
                                        </div>
                                    </div>
                                </div>

                                {volume.is_removable && (
                                    <div className="drive-actions">
                                        <button
                                            className="eject-button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                ejectVolume(volume);
                                            }}
                                            title="Safely eject"
                                        >
                                            <span className="icon icon-eject"></span>
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Disk & Partition Manager (Stage 1: Inspection & Partition Map) */}
            <div className="pc-section">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <h3 style={{ margin: 0 }}>Disks &amp; Partitions</h3>
                    <button
                        className="eject-button"
                        style={{ padding: '4px 10px', fontSize: '12px', width: 'auto', height: 'auto' }}
                        onClick={loadPhysicalDisks}
                        disabled={disksLoading}
                        title="Refresh physical disks and partitions"
                    >
                        {disksLoading ? 'Scanning...' : 'Refresh Disks'}
                    </button>
                </div>
                {disksError && (
                    <div className="input-hint" style={{ color: 'var(--error, #e53e3e)', marginBottom: '10px' }}>
                        {disksError}
                    </div>
                )}
                {physicalDisks.length === 0 && !disksLoading ? (
                    <div className="no-drives">No physical disk layout available</div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {physicalDisks.map((disk) => {
                            const totalSize = disk.size_bytes || 1;
                            return (
                                <div
                                    key={disk.index}
                                    style={{
                                        border: '1px solid var(--border, #2a2d32)',
                                        borderRadius: '8px',
                                        padding: '12px 14px',
                                        background: 'var(--surface, rgba(255,255,255,0.03))'
                                    }}
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                                        <div>
                                            <strong>Disk {disk.index}: {disk.model || 'Physical Disk'}</strong>
                                            {disk.is_system && (
                                                <span style={{ marginLeft: '8px', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', background: 'rgba(6, 114, 239, 0.2)', color: 'var(--accent, #3b82f6)' }}>
                                                    System
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                            <span style={{ fontSize: '12px', opacity: 0.8, marginRight: '4px' }}>
                                                {disk.partition_style} • {disk.bus_type} • {formatFileSize(disk.size_bytes)} • {disk.health_status}
                                            </span>
                                            <button
                                                type="button"
                                                disabled={disk.is_system}
                                                onClick={() => setDiskActionState({ mode: 'create_partition', disk })}
                                                title={disk.is_system ? 'Disabled on system disk' : 'Create new partition'}
                                                style={{ padding: '3px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: disk.is_system ? 'not-allowed' : 'pointer', opacity: disk.is_system ? 0.45 : 1 }}
                                            >
                                                + Partition
                                            </button>
                                            <button
                                                type="button"
                                                disabled={disk.is_system}
                                                onClick={() => setDiskActionState({ mode: 'initialize_disk', disk })}
                                                title={disk.is_system ? 'Disabled on system disk' : 'Initialize GPT / MBR'}
                                                style={{ padding: '3px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: disk.is_system ? 'not-allowed' : 'pointer', opacity: disk.is_system ? 0.45 : 1 }}
                                            >
                                                GPT/MBR
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setDiskActionState({ mode: 'create_image', disk })}
                                                title="Create .img or .img.zst image of this disk"
                                                style={{ padding: '3px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                                            >
                                                Image
                                            </button>
                                            <button
                                                type="button"
                                                disabled={disk.is_system}
                                                onClick={() => setDiskActionState({ mode: 'clone_restore', disk })}
                                                title={disk.is_system ? 'Disabled on system disk' : 'Clone disk/partition or restore image'}
                                                style={{ padding: '3px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: disk.is_system ? 'not-allowed' : 'pointer', opacity: disk.is_system ? 0.45 : 1 }}
                                            >
                                                Clone / Restore
                                            </button>
                                        </div>
                                    </div>

                                    {disk.partitions && disk.partitions.length > 0 && (
                                        <>
                                            <div style={{ display: 'flex', height: '14px', borderRadius: '4px', overflow: 'hidden', background: 'rgba(255,255,255,0.08)', marginBottom: '10px', gap: '2px' }}>
                                                {disk.partitions.map((part) => {
                                                    const pct = Math.max(2, (part.size_bytes / totalSize) * 100);
                                                    const bg = part.drive_letter ? 'var(--accent, #0672ef)' : 'rgba(148, 163, 184, 0.45)';
                                                    return (
                                                        <div
                                                            key={part.number}
                                                            style={{ width: `${pct}%`, background: bg, height: '100%' }}
                                                            title={`Partition ${part.number}${part.drive_letter ? ` (${part.drive_letter})` : ''} • ${part.file_system || part.partition_type} • ${formatFileSize(part.size_bytes)}`}
                                                        />
                                                    );
                                                })}
                                            </div>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                                {disk.partitions.map((part) => {
                                                    const isMounted = Boolean(part.drive_letter && (part.drive_letter.includes(':') || part.drive_letter.startsWith('/')));
                                                    const openPath = part.drive_letter && part.drive_letter.endsWith(':')
                                                        ? `${part.drive_letter}\\`
                                                        : part.drive_letter;
                                                    const protectedPart = disk.is_system || part.is_system;
                                                    return (
                                                        <div
                                                            key={part.number}
                                                            style={{
                                                                padding: '8px 10px',
                                                                borderRadius: '6px',
                                                                border: '1px solid var(--border, #2a2d32)',
                                                                background: 'rgba(255,255,255,0.02)',
                                                                fontSize: '12px',
                                                                display: 'flex',
                                                                flexDirection: 'column',
                                                                gap: '6px',
                                                            }}
                                                        >
                                                            <div
                                                                onClick={() => {
                                                                    if (isMounted && openPath) {
                                                                        loadDirectory(openPath).then((ok) => {
                                                                            if (ok) navigateTo(openPath);
                                                                        });
                                                                    }
                                                                }}
                                                                style={{ cursor: isMounted ? 'pointer' : 'default' }}
                                                            >
                                                                <div style={{ fontWeight: 600 }}>
                                                                    {part.drive_letter || `Part ${part.number}`}
                                                                    {part.label ? ` (${part.label})` : ''}
                                                                </div>
                                                                <div style={{ opacity: 0.75 }}>
                                                                    {part.file_system || part.partition_type} • {formatFileSize(part.size_bytes)}
                                                                    {typeof part.free_bytes === 'number' ? ` (${formatFileSize(part.free_bytes)} free)` : ''}
                                                                </div>
                                                            </div>
                                                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                                                <button
                                                                    type="button"
                                                                    disabled={protectedPart}
                                                                    onClick={() => setDiskActionState({ mode: 'format', disk, partition: part })}
                                                                    style={{ padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: protectedPart ? 'not-allowed' : 'pointer', opacity: protectedPart ? 0.45 : 1 }}
                                                                >
                                                                    Format
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    disabled={protectedPart}
                                                                    onClick={() => setDiskActionState({ mode: 'resize_partition', disk, partition: part })}
                                                                    style={{ padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: protectedPart ? 'not-allowed' : 'pointer', opacity: protectedPart ? 0.45 : 1 }}
                                                                >
                                                                    Resize
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    disabled={protectedPart}
                                                                    onClick={() => setDiskActionState({ mode: 'delete_partition', disk, partition: part })}
                                                                    style={{ padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: '#f87171', cursor: protectedPart ? 'not-allowed' : 'pointer', opacity: protectedPart ? 0.45 : 1 }}
                                                                >
                                                                    Delete
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setDiskActionState({ mode: 'create_image', disk, partition: part })}
                                                                    style={{ padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                                                                >
                                                                    Image
                                                                </button>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* System Information */}
            {systemInfo && (
                <div className="pc-section">
                    <h3>System Information</h3>
                    <div className="system-details">
                        <div className="detail-row">
                            <span className="detail-label">Operating System:</span>
                            <span className="detail-value">{systemInfo.current_running_os}</span>
                        </div>
                        {systemInfo.current_cpu_architecture && (
                            <div className="detail-row">
                                <span className="detail-label">Architecture:</span>
                                <span className="detail-value">{systemInfo.current_cpu_architecture}</span>
                            </div>
                        )}
                        {systemInfo.user_home_dir && (
                            <div className="detail-row">
                                <span className="detail-label">User Directory:</span>
                                <span className="detail-value">{systemInfo.user_home_dir}</span>
                            </div>
                        )}
                        {systemInfo.version && (
                            <div className="detail-row">
                                <span className="detail-label">Version:</span>
                                <span className="detail-value">{systemInfo.version}</span>
                            </div>
                        )}
                    </div>
                </div>
            )}
            {diskActionState && (
                <DiskManagerModal
                    actionState={diskActionState}
                    disks={physicalDisks}
                    isLinux={Boolean(systemInfo?.current_running_os?.toLowerCase().includes('linux'))}
                    onClose={() => setDiskActionState(null)}
                    onCompleted={() => {
                        loadPhysicalDisks();
                        loadVolumes();
                    }}
                />
            )}
        </div>
    );
};

export default ThisPCView;

