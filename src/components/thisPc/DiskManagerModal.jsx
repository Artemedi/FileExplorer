import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save, open } from '@tauri-apps/plugin-dialog';
import { formatFileSize } from '../../utils/formatters';
import { showError, showSuccess } from '../../utils/NotificationSystem.js';

/**
 * Modal for Disk & Partition Management (Stages 2–4):
 * format, create/resize/delete partition, initialize GPT/MBR, create .img/.img.zst, and clone/restore.
 */
const DiskManagerModal = ({ actionState, disks, isLinux, onClose, onCompleted }) => {
    const { mode, disk, partition } = actionState || {};
    const [supportedFs, setSupportedFs] = useState([]);
    const [fileSystem, setFileSystem] = useState('');
    const [label, setLabel] = useState('');
    const [quickFormat, setQuickFormat] = useState(true);
    const [sizeMb, setSizeMb] = useState('');
    const [driveLetter, setDriveLetter] = useState('');
    const [partitionStyle, setPartitionStyle] = useState('GPT');
    const [supportedBounds, setSupportedBounds] = useState(null);
    const [confirmInput, setConfirmInput] = useState('');
    const [sudoPassword, setSudoPassword] = useState('');

    // Imaging & cloning state
    const [outputPath, setOutputPath] = useState('');
    const [compressZstd, setCompressZstd] = useState(true);
    const [uploadToSftp, setUploadToSftp] = useState(false);
    const [sftpConnections, setSftpConnections] = useState([]);
    const [selectedSftpKey, setSelectedSftpKey] = useState('');
    const [sftpRemotePath, setSftpRemotePath] = useState('/tmp/disk-backup.img.zst');

    const [sourceKind, setSourceKind] = useState('image');
    const [sourceDiskIndex, setSourceDiskIndex] = useState('');
    const [sourcePartNum, setSourcePartNum] = useState('');
    const [sourceImagePath, setSourceImagePath] = useState('');
    const [targetPartNum, setTargetPartNum] = useState('');

    const [isBusy, setIsBusy] = useState(false);
    const [progress, setProgress] = useState(null);
    const [formError, setFormError] = useState(null);

    const expectedConfirmToken = (() => {
        if (!disk) return '';
        if (mode === 'clone_restore' && targetPartNum) {
            return `PART-${disk.index}-${targetPartNum}`;
        }
        if (partition && ['format', 'delete_partition', 'resize_partition'].includes(mode)) {
            return `PART-${disk.index}-${partition.number}`;
        }
        return `DISK-${disk.index}`;
    })();

    useEffect(() => {
        setFormError(null);
        setConfirmInput('');
        setProgress(null);

        invoke('get_supported_filesystems')
            .then((list) => {
                const items = Array.isArray(list) ? list : [];
                setSupportedFs(items);
                if (items.length > 0) setFileSystem(items[0]);
            })
            .catch(() => {});

        try {
            const raw = localStorage.getItem('fileExplorerSftpConnections');
            const parsed = raw ? JSON.parse(raw) : [];
            const list = Array.isArray(parsed) ? parsed : [];
            setSftpConnections(list);
            if (list.length > 0) {
                setSelectedSftpKey(`${list[0].username}@${list[0].host}:${list[0].port || 22}`);
            }
        } catch {
            setSftpConnections([]);
        }

        if (mode === 'resize_partition' && disk && partition) {
            setSizeMb(String(Math.max(16, Math.floor(partition.size_bytes / (1024 * 1024)))));
            invoke('get_partition_supported_size', {
                diskIndex: disk.index,
                partitionNumber: partition.number,
            })
                .then(setSupportedBounds)
                .catch(() => setSupportedBounds(null));
        }

        if (mode === 'create_image' && disk) {
            const suffix = partition ? `disk${disk.index}-part${partition.number}` : `disk${disk.index}`;
            setOutputPath(`${suffix}.img.zst`);
            setSftpRemotePath(`/tmp/${suffix}.img.zst`);
        }

        if (mode === 'clone_restore' && disks?.length > 0) {
            const other = disks.find((d) => d.index !== disk?.index) || disks[0];
            if (other) setSourceDiskIndex(String(other.index));
        }
    }, [mode, disk?.index, partition?.number]);

    useEffect(() => {
        let unlisten = null;
        listen('disk-image-progress', (event) => {
            if (event?.payload) {
                setProgress(event.payload);
            }
        }).then((fn) => {
            unlisten = fn;
        });
        return () => {
            if (unlisten) unlisten();
        };
    }, []);

    if (!actionState || !disk) return null;

    const handleBrowseOutput = async () => {
        try {
            const picked = await save({
                defaultPath: outputPath || `disk${disk.index}.${compressZstd ? 'img.zst' : 'img'}`,
                filters: [{ name: 'Disk Image', extensions: ['img', 'zst'] }],
            });
            if (picked) setOutputPath(picked);
        } catch (err) {
            setFormError(String(err));
        }
    };

    const handleBrowseSourceImage = async () => {
        try {
            const picked = await open({
                multiple: false,
                filters: [{ name: 'Disk Image', extensions: ['img', 'zst'] }],
            });
            if (typeof picked === 'string') setSourceImagePath(picked);
        } catch (err) {
            setFormError(String(err));
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setFormError(null);
        setIsBusy(true);
        try {
            let msg = 'Operation completed.';
            if (mode === 'format') {
                msg = await invoke('format_partition', {
                    diskIndex: disk.index,
                    partitionNumber: partition.number,
                    fileSystem,
                    label: label.trim() || null,
                    quick: quickFormat,
                    confirmTarget: confirmInput,
                    sudoPassword: sudoPassword || null,
                });
            } else if (mode === 'create_partition') {
                msg = await invoke('create_partition', {
                    diskIndex: disk.index,
                    sizeMb: sizeMb ? Number(sizeMb) : null,
                    fileSystem: fileSystem || null,
                    label: label.trim() || null,
                    driveLetter: driveLetter.trim() || null,
                    confirmTarget: confirmInput,
                    sudoPassword: sudoPassword || null,
                });
            } else if (mode === 'resize_partition') {
                msg = await invoke('resize_partition', {
                    diskIndex: disk.index,
                    partitionNumber: partition.number,
                    newSizeMb: Number(sizeMb),
                    confirmTarget: confirmInput,
                    sudoPassword: sudoPassword || null,
                });
            } else if (mode === 'delete_partition') {
                msg = await invoke('delete_partition', {
                    diskIndex: disk.index,
                    partitionNumber: partition.number,
                    confirmTarget: confirmInput,
                    sudoPassword: sudoPassword || null,
                });
            } else if (mode === 'initialize_disk') {
                msg = await invoke('initialize_disk', {
                    diskIndex: disk.index,
                    partitionStyle,
                    confirmTarget: confirmInput,
                    sudoPassword: sudoPassword || null,
                });
            } else if (mode === 'create_image') {
                let sftpTarget = null;
                if (uploadToSftp) {
                    const conn = sftpConnections.find(
                        (c) => `${c.username}@${c.host}:${c.port || 22}` === selectedSftpKey
                    );
                    if (!conn) {
                        throw new Error('Select a saved SFTP connection for remote upload.');
                    }
                    sftpTarget = {
                        host: conn.host,
                        port: Number(conn.port || 22),
                        username: conn.username,
                        password: conn.password || null,
                        auth_type: conn.authType || null,
                        private_key_path: conn.privateKeyPath || null,
                        certificate_path: conn.certificatePath || null,
                        remote_path: sftpRemotePath.trim(),
                    };
                }
                const res = await invoke('create_disk_image', {
                    diskIndex: disk.index,
                    partitionNumber: partition ? partition.number : null,
                    outputPath: outputPath.trim(),
                    compressZstd,
                    sftpTarget,
                });
                msg = `Image created (${formatFileSize(res.bytes_processed)}) → ${res.destination}`;
            } else if (mode === 'clone_restore') {
                const res = await invoke('clone_or_restore_disk', {
                    sourceKind,
                    sourceDiskIndex: sourceKind !== 'image' ? Number(sourceDiskIndex) : null,
                    sourcePartitionNumber: sourceKind === 'partition' && sourcePartNum ? Number(sourcePartNum) : null,
                    sourceImagePath: sourceKind === 'image' ? sourceImagePath.trim() : null,
                    targetDiskIndex: disk.index,
                    targetPartitionNumber: targetPartNum ? Number(targetPartNum) : null,
                    confirmTarget: confirmInput,
                });
                msg = `Completed (${formatFileSize(res.bytes_processed)}) → ${res.destination}`;
            }

            showSuccess(msg);
            onCompleted();
            onClose();
        } catch (err) {
            const errMsg = typeof err === 'string' ? err : (err?.message || 'Disk operation failed.');
            setFormError(errMsg);
            showError(errMsg);
        } finally {
            setIsBusy(false);
        }
    };

    const titles = {
        format: `Format Partition ${partition?.number} (Disk ${disk.index})`,
        create_partition: `Create Partition on Disk ${disk.index}`,
        resize_partition: `Resize Partition ${partition?.number} (Disk ${disk.index})`,
        delete_partition: `Delete Partition ${partition?.number} (Disk ${disk.index})`,
        initialize_disk: `Initialize Disk ${disk.index} (GPT / MBR)`,
        create_image: partition
            ? `Create Image of Partition ${partition.number} (Disk ${disk.index})`
            : `Create Image of Disk ${disk.index}`,
        clone_restore: `Clone / Restore to Disk ${disk.index}`,
    };

    const needsConfirm = mode !== 'create_image';

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.65)',
                zIndex: 2000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '16px',
            }}
            onClick={() => !isBusy && onClose()}
        >
            <div
                style={{
                    width: '100%',
                    maxWidth: '520px',
                    background: 'var(--bg-secondary, #1b1e23)',
                    border: '1px solid var(--border, #2a2d32)',
                    borderRadius: '10px',
                    padding: '18px 20px',
                    color: 'var(--text-primary, #f3f4f6)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>{titles[mode] || 'Disk Operation'}</h3>
                    <button
                        type="button"
                        disabled={isBusy}
                        onClick={onClose}
                        style={{ background: 'transparent', border: 'none', color: 'inherit', fontSize: '18px', cursor: 'pointer' }}
                    >
                        ×
                    </button>
                </div>

                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {(mode === 'format' || mode === 'create_partition') && (
                        <>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                File System
                                <select
                                    value={fileSystem}
                                    onChange={(e) => setFileSystem(e.target.value)}
                                    style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                >
                                    {supportedFs.map((fs) => (
                                        <option key={fs} value={fs}>{fs}</option>
                                    ))}
                                </select>
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                Volume Label (optional)
                                <input
                                    type="text"
                                    maxLength={32}
                                    value={label}
                                    onChange={(e) => setLabel(e.target.value)}
                                    placeholder="e.g. DATA_USB"
                                    style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                />
                            </label>
                        </>
                    )}

                    {mode === 'format' && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                            <input
                                type="checkbox"
                                checked={quickFormat}
                                onChange={(e) => setQuickFormat(e.target.checked)}
                            />
                            Quick Format
                        </label>
                    )}

                    {mode === 'create_partition' && (
                        <>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                Size in MB (leave blank for maximum unallocated space)
                                <input
                                    type="number"
                                    min={16}
                                    value={sizeMb}
                                    onChange={(e) => setSizeMb(e.target.value)}
                                    placeholder="Max available"
                                    style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                />
                            </label>
                            {!isLinux && (
                                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                    Drive Letter (optional, e.g. E)
                                    <input
                                        type="text"
                                        maxLength={2}
                                        value={driveLetter}
                                        onChange={(e) => setDriveLetter(e.target.value)}
                                        placeholder="Auto-assign"
                                        style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                    />
                                </label>
                            )}
                        </>
                    )}

                    {mode === 'resize_partition' && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                            New Size (MB)
                            {supportedBounds && (
                                <span style={{ fontSize: '11px', opacity: 0.75 }}>
                                    Supported: {Math.ceil(supportedBounds.min_bytes / (1024 * 1024))} MB – {Math.floor(supportedBounds.max_bytes / (1024 * 1024))} MB
                                </span>
                            )}
                            <input
                                type="number"
                                min={16}
                                required
                                value={sizeMb}
                                onChange={(e) => setSizeMb(e.target.value)}
                                style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                            />
                        </label>
                    )}

                    {mode === 'initialize_disk' && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                            Partition Table Style
                            <select
                                value={partitionStyle}
                                onChange={(e) => setPartitionStyle(e.target.value)}
                                style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                            >
                                <option value="GPT">GPT (UEFI / Modern &gt;2TB)</option>
                                <option value="MBR">MBR (Legacy BIOS)</option>
                            </select>
                        </label>
                    )}

                    {mode === 'create_image' && (
                        <>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                Destination Image Path (local or \\server\share\image.img.zst)
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <input
                                        type="text"
                                        required
                                        value={outputPath}
                                        onChange={(e) => setOutputPath(e.target.value)}
                                        style={{ flex: 1, padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                    />
                                    <button type="button" onClick={handleBrowseOutput} style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
                                        Browse
                                    </button>
                                </div>
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                                <input
                                    type="checkbox"
                                    checked={compressZstd}
                                    onChange={(e) => setCompressZstd(e.target.checked)}
                                />
                                Compress on the fly with Zstandard (.img.zst)
                            </label>
                            {sftpConnections.length > 0 && (
                                <div style={{ borderTop: '1px solid var(--border, #2a2d32)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                                        <input
                                            type="checkbox"
                                            checked={uploadToSftp}
                                            onChange={(e) => setUploadToSftp(e.target.checked)}
                                        />
                                        Also upload image to saved SFTP server
                                    </label>
                                    {uploadToSftp && (
                                        <>
                                            <select
                                                value={selectedSftpKey}
                                                onChange={(e) => setSelectedSftpKey(e.target.value)}
                                                style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                            >
                                                {sftpConnections.map((c) => {
                                                    const k = `${c.username}@${c.host}:${c.port || 22}`;
                                                    return <option key={k} value={k}>{c.name} ({k})</option>;
                                                })}
                                            </select>
                                            <input
                                                type="text"
                                                value={sftpRemotePath}
                                                onChange={(e) => setSftpRemotePath(e.target.value)}
                                                placeholder="/backups/disk.img.zst"
                                                style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                            />
                                        </>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {mode === 'clone_restore' && (
                        <>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                Source Type
                                <select
                                    value={sourceKind}
                                    onChange={(e) => setSourceKind(e.target.value)}
                                    style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                >
                                    <option value="image">Image File (.img / .img.zst)</option>
                                    <option value="disk">Clone Physical Disk → Disk</option>
                                    <option value="partition">Clone Partition → Partition/Disk</option>
                                </select>
                            </label>
                            {sourceKind === 'image' ? (
                                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                    Source Image File
                                    <div style={{ display: 'flex', gap: '8px' }}>
                                        <input
                                            type="text"
                                            required
                                            value={sourceImagePath}
                                            onChange={(e) => setSourceImagePath(e.target.value)}
                                            placeholder="Path to .img or .img.zst"
                                            style={{ flex: 1, padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                        />
                                        <button type="button" onClick={handleBrowseSourceImage} style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
                                            Browse
                                        </button>
                                    </div>
                                </label>
                            ) : (
                                <>
                                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                        Source Disk
                                        <select
                                            value={sourceDiskIndex}
                                            onChange={(e) => setSourceDiskIndex(e.target.value)}
                                            style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                        >
                                            {disks.map((d) => (
                                                <option key={d.index} value={d.index}>
                                                    Disk {d.index}: {d.model} ({formatFileSize(d.size_bytes)})
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    {sourceKind === 'partition' && (
                                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                            Source Partition Number
                                            <input
                                                type="number"
                                                min={1}
                                                required
                                                value={sourcePartNum}
                                                onChange={(e) => setSourcePartNum(e.target.value)}
                                                style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                            />
                                        </label>
                                    )}
                                </>
                            )}
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                                Target Partition Number (leave blank to write entire Disk {disk.index})
                                <input
                                    type="number"
                                    min={1}
                                    value={targetPartNum}
                                    onChange={(e) => setTargetPartNum(e.target.value)}
                                    placeholder="Entire disk"
                                    style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                />
                            </label>
                        </>
                    )}

                    {isLinux && !['create_image', 'clone_restore'].includes(mode) && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                            sudo password (optional, if not using pkexec)
                            <input
                                type="password"
                                value={sudoPassword}
                                onChange={(e) => setSudoPassword(e.target.value)}
                                placeholder="Leave blank for pkexec / root"
                                style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                            />
                        </label>
                    )}

                    {needsConfirm && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', color: '#f87171' }}>
                            Destructive operation — type <code>{expectedConfirmToken}</code> to confirm:
                            <input
                                type="text"
                                required
                                value={confirmInput}
                                onChange={(e) => setConfirmInput(e.target.value)}
                                placeholder={expectedConfirmToken}
                                style={{ padding: '7px 10px', borderRadius: '6px', background: '#111317', color: '#f3f4f6', border: '1px solid #ef4444' }}
                            />
                        </label>
                    )}

                    {progress && (
                        <div style={{ fontSize: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                <span>{progress.stage}</span>
                                <span>{progress.percent.toFixed(1)}% ({formatFileSize(progress.bytes_processed)})</span>
                            </div>
                            <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(100, progress.percent)}%`, height: '100%', background: 'var(--accent, #3b82f6)' }} />
                            </div>
                        </div>
                    )}

                    {formError && (
                        <div style={{ fontSize: '12px', color: '#f87171', whiteSpace: 'pre-wrap' }}>
                            {formError}
                        </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '6px' }}>
                        <button
                            type="button"
                            disabled={isBusy}
                            onClick={onClose}
                            style={{ padding: '7px 14px', borderRadius: '6px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={isBusy}
                            style={{
                                padding: '7px 14px',
                                borderRadius: '6px',
                                border: 'none',
                                background: needsConfirm ? '#dc2626' : 'var(--accent, #0672ef)',
                                color: '#fff',
                                cursor: isBusy ? 'wait' : 'pointer',
                                fontWeight: 600,
                            }}
                        >
                            {isBusy ? 'Working...' : 'Execute'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default DiskManagerModal;
