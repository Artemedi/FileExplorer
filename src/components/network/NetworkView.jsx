import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSftp } from '../../providers/SftpProvider';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useHistory } from '../../providers/HistoryProvider';
import { showSuccess, showError, showConfirm } from '../../utils/NotificationSystem';
import AddSftpConnectionView from '../sidebar/AddSftpConnectionView';
import Modal from '../common/Modal';
import Button from '../common/Button';
import { useNetworkHealth, getHealthDisplay } from '../../hooks/useNetworkHealth';
import { compareNetworkItems, groupNetworkItems } from '../../utils/networkSort';
import './networkView.css';

const NETWORK_SHARES_STORAGE_KEY = 'fileExplorerNetworkShares';

/**
 * NetworkView component that displays available network connections
 * and provides management for SFTP connections
 */
const NetworkView = () => {
    const { currentSftpConnection, disconnectSftp, createSftpUrl } = useSftp();
    const { loadDirectory } = useFileSystem();
    const { navigateTo } = useHistory();
    const [isAddSftpModalOpen, setIsAddSftpModalOpen] = useState(false);
    const [localSftpConnections, setLocalSftpConnections] = useState([]);
    const [networkShares, setNetworkShares] = useState(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(NETWORK_SHARES_STORAGE_KEY) || '[]');
            return Array.isArray(saved) ? saved : [];
        } catch {
            return [];
        }
    });
    const [isAddShareModalOpen, setIsAddShareModalOpen] = useState(false);
    const [shareName, setShareName] = useState('');
    const [sharePath, setSharePath] = useState('');
    const [shareUsername, setShareUsername] = useState('');
    const [sharePassword, setSharePassword] = useState('');
    const [shareRemember, setShareRemember] = useState(true);
    const [shareConnecting, setShareConnecting] = useState(false);
    const [shareError, setShareError] = useState(null);
    const [groupByAlpha, setGroupByAlpha] = useState(true);

    const networkTargets = [
        ...networkShares.map((s) => ({
            id: `smb:${s.path}`,
            host: '',
            port: null,
            unc_path: s.path
        })),
        ...localSftpConnections.map((c) => ({
            id: `sftp:${c.name}`,
            host: c.host,
            port: Number(c.port || 22),
            unc_path: null
        }))
    ];
    const { statusesById: endpointHealthById } = useNetworkHealth(networkTargets);

    // Load SFTP connections
    useEffect(() => {
        const loadConnections = () => {
            try {
                const saved = JSON.parse(localStorage.getItem('fileExplorerSftpConnections') || '[]');
                setLocalSftpConnections(Array.isArray(saved) ? saved : []);
            } catch (err) {
                setLocalSftpConnections([]);
            }
        };

        loadConnections();
        
        // Listen for connection updates
        const handler = () => loadConnections();
        const storageHandler = (e) => {
            if (e.key === 'fileExplorerSftpConnections') loadConnections();
        };
        window.addEventListener('sftp-connections-updated', handler);
        window.addEventListener('storage', storageHandler);
        
        return () => {
            window.removeEventListener('sftp-connections-updated', handler);
            window.removeEventListener('storage', storageHandler);
        };
    }, []);

    // Add SFTP connection (never store plaintext password in localStorage)
    const addSftpConnection = (conn) => {
        try {
            const { password: _omitted, ...safeConn } = conn || {};
            let existing = [];
            try {
                const parsed = JSON.parse(localStorage.getItem('fileExplorerSftpConnections') || '[]');
                existing = Array.isArray(parsed) ? parsed : [];
            } catch {
                existing = [];
            }
            const newConnections = [...existing, safeConn];
            localStorage.setItem('fileExplorerSftpConnections', JSON.stringify(newConnections));
            window.dispatchEvent(new CustomEvent('sftp-connections-updated'));
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'fileExplorerSftpConnections',
                newValue: JSON.stringify(newConnections)
            }));
            showSuccess(`SFTP connection "${safeConn.name}" added successfully`);
            setIsAddSftpModalOpen(false);
        } catch (err) {
            showError('Failed to add SFTP connection');
        }
    };

    // Remove SFTP connection
    const removeSftpConnection = async (connection) => {
        const confirmRemove = await showConfirm(`Are you sure you want to remove the SFTP connection "${connection.name}"?`);
        if (!confirmRemove) return;

        try {
            const connectionKey = `${connection.username}@${connection.host}:${connection.port || 22}`;
            await invoke('remove_sftp_credentials', { connectionKey }).catch(() => {});

            let existing = [];
            try {
                const parsed = JSON.parse(localStorage.getItem('fileExplorerSftpConnections') || '[]');
                existing = Array.isArray(parsed) ? parsed : [];
            } catch {
                existing = [];
            }
            const newConnections = existing.filter(c => c.name !== connection.name);
            localStorage.setItem('fileExplorerSftpConnections', JSON.stringify(newConnections));
            window.dispatchEvent(new CustomEvent('sftp-connections-updated'));
            window.dispatchEvent(new StorageEvent('storage', {
                key: 'fileExplorerSftpConnections',
                newValue: JSON.stringify(newConnections)
            }));

            if (currentSftpConnection?.name === connection.name) {
                disconnectSftp();
            }
            showSuccess(`SFTP connection "${connection.name}" removed successfully.`);
        } catch (err) {
            showError(`Failed to remove SFTP connection: ${err?.message || err}`);
        }
    };

    // Connect to SFTP server
    const handleConnectToSftp = async (connection) => {
        try {
            const sftpPath = createSftpUrl(connection, '.');
            window.dispatchEvent(new CustomEvent('force-explorer-view'));
            const ok = await loadDirectory(sftpPath);
            if (ok) {
                navigateTo(sftpPath);
                showSuccess(`Connected to ${connection.name}`);
            }
        } catch (error) {
            console.error('Failed to connect to SFTP:', error);
            showError(`Failed to connect to ${connection.name}: ${error.message || error}`);
        }
    };

    const saveNetworkShares = (nextShares) => {
        setNetworkShares(nextShares);
        try {
            localStorage.setItem(NETWORK_SHARES_STORAGE_KEY, JSON.stringify(nextShares));
            window.dispatchEvent(new CustomEvent('network-shares-updated'));
        } catch {
            // ignore storage quota errors
        }
    };

    const handleOpenNetworkShare = async (share) => {
        try {
            if (share.username) {
                await invoke('connect_network_share', {
                    uncPath: share.path,
                    username: share.username,
                    password: '',
                    remember: false
                });
            }
            window.dispatchEvent(new CustomEvent('force-explorer-view'));
            const ok = await loadDirectory(share.path);
            if (ok) {
                navigateTo(share.path);
                showSuccess(`Opened ${share.name || share.path}`);
            }
        } catch (error) {
            showError(`Failed to open "${share.path}": ${error?.message || error}`);
        }
    };

    const handleAddNetworkShare = async () => {
        const trimmedPath = sharePath.trim().replace(/\//g, '\\');
        if (!trimmedPath.startsWith('\\\\')) {
            setShareError('Enter a UNC network path like \\\\server\\share');
            return;
        }
        const derivedName = shareName.trim() || trimmedPath.replace(/^\\+/, '').split('\\').filter(Boolean).slice(0, 2).join('\\') || trimmedPath;

        setShareConnecting(true);
        setShareError(null);
        try {
            if (shareUsername.trim()) {
                await invoke('connect_network_share', {
                    uncPath: trimmedPath,
                    username: shareUsername.trim(),
                    password: sharePassword,
                    remember: shareRemember
                });
            }
            await invoke('open_directory', { path: trimmedPath });

            const nextShares = [
                ...networkShares.filter(s => s.path !== trimmedPath),
                {
                    name: derivedName,
                    path: trimmedPath,
                    ...(shareUsername.trim() ? { username: shareUsername.trim() } : {})
                }
            ];
            saveNetworkShares(nextShares);
            setIsAddShareModalOpen(false);
            setShareName('');
            setSharePath('');
            setShareUsername('');
            setSharePassword('');

            window.dispatchEvent(new CustomEvent('force-explorer-view'));
            const ok = await loadDirectory(trimmedPath);
            if (ok) {
                navigateTo(trimmedPath);
            }
            showSuccess(`Connected to "${derivedName}"`);
        } catch (err) {
            setShareError(typeof err === 'string' ? err : (err?.message || 'Failed to access network share'));
        } finally {
            setShareConnecting(false);
        }
    };

    const handleRemoveNetworkShare = async (share) => {
        const confirmed = await showConfirm(`Remove network share "${share.name}" from saved list?`);
        if (!confirmed) return;
        saveNetworkShares(networkShares.filter(s => s.path !== share.path));
    };

    return (
        <div className="network-view">
            <div className="network-view-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                    <h2 className="network-view-title">Network</h2>
                    <p className="network-view-subtitle">Manage and connect to remote servers and SMB/UNC shares</p>
                </div>
                <button
                    type="button"
                    onClick={() => setGroupByAlpha((prev) => !prev)}
                    style={{
                        padding: '6px 12px',
                        fontSize: '12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--text-primary)',
                        cursor: 'pointer'
                    }}
                    title="Toggle grouping (0-9 · A-Z · А-Я)"
                >
                    {groupByAlpha ? 'Grouped: 0-9 · A-Z · А-Я' : 'Sorted: 0-9 → A-Z → А-Я'}
                </button>
            </div>

            <div className="network-connections-section">
                <div className="section-header">
                    <h3 className="section-title">Network Shares (SMB / UNC)</h3>
                    <button
                        className="add-connection-button"
                        onClick={() => {
                            setShareError(null);
                            setIsAddShareModalOpen(true);
                        }}
                        title="Add SMB / UNC Network Share"
                    >
                        <span className="icon icon-plus"></span>
                        <span>Add Network Share</span>
                    </button>
                </div>

                <div className="connections-grid">
                    {networkShares.length === 0 ? (
                        <div className="empty-connections">
                            <div className="empty-connections-icon">
                                <span className="icon icon-folder"></span>
                            </div>
                            <h4>No saved network shares</h4>
                            <p>Open local network or domain paths like \\server\share directly</p>
                            <button
                                className="add-first-connection-button"
                                onClick={() => {
                                    setShareError(null);
                                    setIsAddShareModalOpen(true);
                                }}
                            >
                                Add Network Share
                            </button>
                        </div>
                    ) : groupByAlpha ? (
                        groupNetworkItems(networkShares).map(({ group, items }) => (
                            <React.Fragment key={group}>
                                <div style={{ gridColumn: '1 / -1', fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', opacity: 0.65, paddingTop: '4px' }}>
                                    {group} ({items.length})
                                </div>
                                {items.map((share) => {
                                    const health = getHealthDisplay(endpointHealthById[`smb:${share.path}`]);
                                    return (
                                    <div key={share.path} className="connection-card">
                                        <div className="connection-icon">
                                            <span className="icon icon-folder"></span>
                                        </div>
                                        <div className="connection-details">
                                            <h4 className="connection-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                <span>{share.name}</span>
                                                <span
                                                    title={health.title}
                                                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 500, opacity: 0.9 }}
                                                >
                                                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: health.color, display: 'inline-block' }} />
                                                    <span>{health.label}</span>
                                                </span>
                                            </h4>
                                            <p className="connection-address" title={`${share.path}${share.username ? ` · ${share.username}` : ''}`}>
                                                {share.path}
                                                {share.username ? ` · ${share.username}` : ''}
                                            </p>
                                        </div>
                                        <div className="connection-actions">
                                            <button
                                                className="connect-button"
                                                onClick={() => handleOpenNetworkShare(share)}
                                                title="Open network share"
                                            >
                                                <span className="icon icon-play"></span>
                                                Open
                                            </button>
                                            <button
                                                className="remove-connection-button"
                                                onClick={() => handleRemoveNetworkShare(share)}
                                                title="Remove network share"
                                                aria-label={`Remove ${share.name}`}
                                            >
                                                <span className="icon icon-x"></span>
                                            </button>
                                        </div>
                                    </div>
                                    );
                                })}
                            </React.Fragment>
                        ))
                    ) : (
                        [...networkShares].sort(compareNetworkItems).map((share) => {
                            const health = getHealthDisplay(endpointHealthById[`smb:${share.path}`]);
                            return (
                            <div key={share.path} className="connection-card">
                                <div className="connection-icon">
                                    <span className="icon icon-folder"></span>
                                </div>
                                <div className="connection-details">
                                    <h4 className="connection-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <span>{share.name}</span>
                                        <span
                                            title={health.title}
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 500, opacity: 0.9 }}
                                        >
                                            <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: health.color, display: 'inline-block' }} />
                                            <span>{health.label}</span>
                                        </span>
                                    </h4>
                                    <p className="connection-address" title={`${share.path}${share.username ? ` · ${share.username}` : ''}`}>
                                        {share.path}
                                        {share.username ? ` · ${share.username}` : ''}
                                    </p>
                                </div>
                                <div className="connection-actions">
                                    <button
                                        className="connect-button"
                                        onClick={() => handleOpenNetworkShare(share)}
                                        title="Open network share"
                                    >
                                        <span className="icon icon-play"></span>
                                        Open
                                    </button>
                                    <button
                                        className="remove-connection-button"
                                        onClick={() => handleRemoveNetworkShare(share)}
                                        title="Remove network share"
                                        aria-label={`Remove ${share.name}`}
                                    >
                                        <span className="icon icon-x"></span>
                                    </button>
                                </div>
                            </div>
                            );
                        })
                    )}
                </div>
            </div>

            <div className="network-connections-section">
                <div className="section-header">
                    <h3 className="section-title">SFTP Connections</h3>
                    <button
                        className="add-connection-button"
                        onClick={() => setIsAddSftpModalOpen(true)}
                        title="Add SFTP Connection"
                    >
                        <span className="icon icon-plus"></span>
                        <span>Add Connection</span>
                    </button>
                </div>

                <div className="connections-grid">
                    {localSftpConnections.length === 0 ? (
                        <div className="empty-connections">
                            <div className="empty-connections-icon">
                                <span className="icon icon-network"></span>
                            </div>
                            <h4>No SFTP connections</h4>
                            <p>Add an SFTP connection to get started with remote file access</p>
                            <button
                                className="add-first-connection-button"
                                onClick={() => setIsAddSftpModalOpen(true)}
                            >
                                <span className="icon icon-plus"></span>
                                Add Your First Connection
                            </button>
                        </div>
                    ) : groupByAlpha ? (
                        groupNetworkItems(localSftpConnections).map(({ group, items }) => (
                            <React.Fragment key={group}>
                                <div style={{ gridColumn: '1 / -1', fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', opacity: 0.65, paddingTop: '4px' }}>
                                    {group} ({items.length})
                                </div>
                                {items.map((connection) => {
                                    const health = getHealthDisplay(endpointHealthById[`sftp:${connection.name}`]);
                                    return (
                                    <div key={connection.name} className="connection-card">
                                        <div className="connection-icon">
                                            <span className="icon icon-network"></span>
                                        </div>
                                        <div className="connection-details">
                                            <h4 className="connection-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                <span>{connection.name}</span>
                                                <span
                                                    title={health.title}
                                                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 500, opacity: 0.9 }}
                                                >
                                                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: health.color, display: 'inline-block' }} />
                                                    <span>{health.label}</span>
                                                </span>
                                            </h4>
                                            <p className="connection-address" title={`${connection.username || 'guest'}@${connection.host}:${connection.port}`}>
                                                {connection.username || 'guest'}@{connection.host}:{connection.port}
                                                {connection.authType ? ` · ${connection.authType}` : ''}
                                            </p>
                                        </div>
                                        <div className="connection-actions">
                                            <button
                                                className="connect-button"
                                                onClick={() => handleConnectToSftp(connection)}
                                                title="Connect to this SFTP server"
                                            >
                                                <span className="icon icon-play"></span>
                                                Connect
                                            </button>
                                            <button
                                                className="connect-button"
                                                onClick={() => window.dispatchEvent(new CustomEvent('open-ssh-terminal', { detail: { connection } }))}
                                                title="Open SSH terminal for this server"
                                            >
                                                <span className="icon icon-terminal"></span>
                                                SSH
                                            </button>
                                            <button
                                                className="remove-connection-button"
                                                onClick={() => removeSftpConnection(connection)}
                                                title="Remove SFTP Connection"
                                                aria-label={`Remove ${connection.name}`}
                                            >
                                                <span className="icon icon-x"></span>
                                            </button>
                                        </div>
                                    </div>
                                    );
                                })}
                            </React.Fragment>
                        ))
                    ) : (
                        [...localSftpConnections].sort(compareNetworkItems).map((connection) => {
                            const health = getHealthDisplay(endpointHealthById[`sftp:${connection.name}`]);
                            return (
                            <div key={connection.name} className="connection-card">
                                <div className="connection-icon">
                                    <span className="icon icon-network"></span>
                                </div>
                                <div className="connection-details">
                                    <h4 className="connection-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <span>{connection.name}</span>
                                        <span
                                            title={health.title}
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 500, opacity: 0.9 }}
                                        >
                                            <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: health.color, display: 'inline-block' }} />
                                            <span>{health.label}</span>
                                        </span>
                                    </h4>
                                    <p className="connection-address" title={`${connection.username || 'guest'}@${connection.host}:${connection.port}`}>
                                        {connection.username || 'guest'}@{connection.host}:{connection.port}
                                        {connection.authType ? ` · ${connection.authType}` : ''}
                                    </p>
                                </div>
                                <div className="connection-actions">
                                    <button
                                        className="connect-button"
                                        onClick={() => handleConnectToSftp(connection)}
                                        title="Connect to this SFTP server"
                                    >
                                        <span className="icon icon-play"></span>
                                        Connect
                                    </button>
                                    <button
                                        className="connect-button"
                                        onClick={() => window.dispatchEvent(new CustomEvent('open-ssh-terminal', { detail: { connection } }))}
                                        title="Open SSH terminal for this server"
                                    >
                                        <span className="icon icon-terminal"></span>
                                        SSH
                                    </button>
                                    <button
                                        className="remove-connection-button"
                                        onClick={() => removeSftpConnection(connection)}
                                        title="Remove SFTP Connection"
                                        aria-label={`Remove ${connection.name}`}
                                    >
                                        <span className="icon icon-x"></span>
                                    </button>
                                </div>
                            </div>
                            );
                        })
                    )}
                </div>
            </div>

            <div className="network-info-section">
                <h3 className="section-title">About Network Features</h3>
                <div className="info-cards">
                    <div className="info-card">
                        <div className="info-icon">
                            <span className="icon icon-shield"></span>
                        </div>
                        <div className="info-content">
                            <h4>Secure Connections</h4>
                            <p>All SFTP connections use secure SSH protocols to protect your data during transfer.</p>
                        </div>
                    </div>
                    <div className="info-card">
                        <div className="info-icon">
                            <span className="icon icon-folder"></span>
                        </div>
                        <div className="info-content">
                            <h4>File Operations</h4>
                            <p>Perform all standard file operations on remote files just like local ones.</p>
                        </div>
                    </div>
                    <div className="info-card">
                        <div className="info-icon">
                            <span className="icon icon-sync"></span>
                        </div>
                        <div className="info-content">
                            <h4>Seamless Integration</h4>
                            <p>Remote files appear alongside local files with full explorer functionality.</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Add SFTP Connection Modal */}
            <AddSftpConnectionView
                isOpen={isAddSftpModalOpen}
                onClose={() => setIsAddSftpModalOpen(false)}
                onAdd={addSftpConnection}
                existingConnections={localSftpConnections}
            />

            <Modal
                isOpen={isAddShareModalOpen}
                onClose={() => setIsAddShareModalOpen(false)}
                title="Add Network Share (SMB / UNC)"
                size="sm"
                footer={
                    <>
                        <Button variant="ghost" onClick={() => setIsAddShareModalOpen(false)}>Cancel</Button>
                        <Button
                            variant="primary"
                            onClick={handleAddNetworkShare}
                            disabled={shareConnecting || !sharePath.trim()}
                        >
                            {shareConnecting ? 'Connecting...' : 'Open & Save'}
                        </Button>
                    </>
                }
            >
                <form onSubmit={e => { e.preventDefault(); handleAddNetworkShare(); }}>
                    <div className="form-group">
                        <label htmlFor="share-path">Network Path (UNC)</label>
                        <input
                            type="text"
                            id="share-path"
                            className="input"
                            value={sharePath}
                            onChange={e => setSharePath(e.target.value)}
                            placeholder="\\server\share\folder"
                            autoFocus
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="share-name">Name (optional)</label>
                        <input
                            type="text"
                            id="share-name"
                            className="input"
                            value={shareName}
                            onChange={e => setShareName(e.target.value)}
                            placeholder="Share name"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="share-username">Username (optional for domain / guest)</label>
                        <input
                            type="text"
                            id="share-username"
                            className="input"
                            value={shareUsername}
                            onChange={e => setShareUsername(e.target.value)}
                            placeholder="DOMAIN\user or leave blank"
                        />
                    </div>
                    {shareUsername.trim() && (
                        <>
                            <div className="form-group">
                                <label htmlFor="share-password">Password</label>
                                <input
                                    type="password"
                                    id="share-password"
                                    className="input"
                                    value={sharePassword}
                                    onChange={e => setSharePassword(e.target.value)}
                                    placeholder="Password (stored in OS keyring)"
                                />
                            </div>
                            <div className="form-group">
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={shareRemember}
                                        onChange={e => setShareRemember(e.target.checked)}
                                    />
                                    <span>Save password securely in OS keyring</span>
                                </label>
                            </div>
                        </>
                    )}
                    {shareError && <div className="input-hint" style={{ color: 'var(--error, #e53e3e)' }}>{shareError}</div>}
                </form>
            </Modal>
        </div>
    );
};

export default NetworkView;