
import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import Modal from '../common/Modal';
import Button from '../common/Button';

/**
 * Parses and validates an SFTP port string/number in [1, 65535].
 * @param {string|number} port
 * @returns {number|null}
 */
function parseValidPort(port) {
	const trimmed = String(port ?? '').trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const portNum = Number.parseInt(trimmed, 10);
	return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : null;
}

/**
 * AddSftpConnectionView - Modal for adding a new SFTP connection
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the modal is open
 * @param {Function} props.onClose - Function to close the modal
 * @param {Function} props.onAdd - Function to add the SFTP connection
 * @param {Array} [props.existingConnections] - Optional list of existing connections for uniqueness check
 */
const AddSftpConnectionView = ({ isOpen, onClose, onAdd, existingConnections }) => {
	const [name, setName] = useState('');
	const [host, setHost] = useState('localhost');
	const [port, setPort] = useState('22');
	const [authType, setAuthType] = useState('password');
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [privateKeyPath, setPrivateKeyPath] = useState('');
	const [certificatePath, setCertificatePath] = useState('');
	const [compressionMode, setCompressionMode] = useState('auto');
	const [testing, setTesting] = useState(false);
	const [saving, setSaving] = useState(false);
	const [testResult, setTestResult] = useState(null);
	const [error, setError] = useState(null);

	const pickFilePath = async (setter) => {
		try {
			const selected = await openDialog({ multiple: false, directory: false });
			if (typeof selected === 'string' && selected.trim()) {
				setter(selected);
			}
		} catch (e) {
			setError(e?.toString() || 'Failed to open file picker');
		}
	};

	const resetForm = () => {
		setName('');
		setHost('localhost');
		setPort('22');
		setAuthType('password');
		setUsername('');
		setPassword('');
		setPrivateKeyPath('');
		setCertificatePath('');
		setCompressionMode('auto');
		setTestResult(null);
		setError(null);
	};

	const handleTestConnection = async () => {
		const trimmedHost = host.trim();
		if (trimmedHost.startsWith('\\\\') || trimmedHost.startsWith('//')) {
			setError('UNC network paths (\\\\server\\share) use SMB, not SFTP. Use "Add Network Share (SMB / UNC)" in Network View.');
			return;
		}
		const portNum = parseValidPort(port);
		if (!portNum) {
			setError('Port must be a number between 1 and 65535');
			return;
		}
		if ((authType === 'key' || authType === 'certificate') && !privateKeyPath.trim()) {
			setError('Private key path is required for key/certificate authentication');
			return;
		}
		setTesting(true);
		setTestResult(null);
		setError(null);
		try {
			const effectiveUsername = authType === 'guest' ? '' : username.trim();
			await invoke('load_dir', {
				host: host.trim(),
				port: portNum,
				username: effectiveUsername,
				password,
				directory: ".",
				authType,
				privateKeyPath: privateKeyPath.trim() || null,
				certificatePath: certificatePath.trim() || null,
				compressionMode
			});
			setTestResult('Connection successful!');
		} catch (e) {
			setTestResult(null);
			setError(e?.toString() || 'Connection failed');
		} finally {
			setTesting(false);
		}
	};

	const handleAdd = async () => {
		const trimmedName = name.trim();
		const trimmedHost = host.trim();
		const trimmedUsername = authType === 'guest' ? '' : username.trim();
		const portNum = parseValidPort(port);

		if (!trimmedName || !trimmedHost) {
			setError('Name and host are required');
			return;
		}
		if (trimmedHost.startsWith('\\\\') || trimmedHost.startsWith('//')) {
			setError('UNC network paths (\\\\server\\share) use SMB, not SFTP. Use "Add Network Share (SMB / UNC)" in Network View.');
			return;
		}
		if (trimmedName.includes(':')) {
			setError('Connection name cannot contain ":"');
			return;
		}
		if (!portNum) {
			setError('Port must be a number between 1 and 65535');
			return;
		}

		let connectionsList = Array.isArray(existingConnections) ? existingConnections : null;
		if (!connectionsList) {
			try {
				const parsed = JSON.parse(localStorage.getItem('fileExplorerSftpConnections') || '[]');
				connectionsList = Array.isArray(parsed) ? parsed : [];
			} catch {
				connectionsList = [];
			}
		}
		if (connectionsList.some(c => c?.name === trimmedName)) {
			setError(`A connection named "${trimmedName}" already exists`);
			return;
		}

		if ((authType === 'key' || authType === 'certificate') && !privateKeyPath.trim()) {
			setError('Private key path is required for key/certificate authentication');
			return;
		}

		setSaving(true);
		setError(null);
		try {
			const connectionKey = `${trimmedUsername}@${trimmedHost}:${portNum}`;
			await invoke('store_ssh_profile', {
				connectionKey,
				authType,
				privateKeyPath: privateKeyPath.trim() || null,
				certificatePath: certificatePath.trim() || null,
				compressionMode
			}).catch(() => {});

			if (password.length > 0) {
				await invoke('store_sftp_credentials', { connectionKey, password });
			}

			onAdd({
				name: trimmedName,
				host: trimmedHost,
				port: portNum,
				username: trimmedUsername,
				authType,
				...(privateKeyPath.trim() ? { privateKeyPath: privateKeyPath.trim() } : {}),
				...(certificatePath.trim() ? { certificatePath: certificatePath.trim() } : {}),
				compressionMode
			});
			resetForm();
		} catch (e) {
			setError(e?.toString() || 'Failed to store SFTP credentials');
		} finally {
			setSaving(false);
		}
	};

	const handleClose = () => {
		resetForm();
		onClose();
	};

	return (
		<Modal
			isOpen={isOpen}
			onClose={handleClose}
			title="Add SFTP Connection"
			size="sm"
			footer={
				<>
					<Button variant="ghost" onClick={handleClose}>Cancel</Button>
					<Button
						variant="secondary"
						onClick={handleTestConnection}
						disabled={testing || !host.trim() || !String(port).trim()}
					>
						{testing ? 'Testing...' : 'Test Connection'}
					</Button>
					<Button
						variant="primary"
						onClick={handleAdd}
						disabled={saving || !name.trim() || !host.trim() || !String(port).trim()}
					>
						{saving ? 'Adding...' : 'Add'}
					</Button>
				</>
			}
		>
			<form onSubmit={e => { e.preventDefault(); handleAdd(); }}>
				<div className="form-group">
					<label htmlFor="sftp-name">Name</label>
					<input
						type="text"
						id="sftp-name"
						className="input"
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder="Connection name"
						autoFocus
					/>
				</div>
				<div className="form-group">
					<label htmlFor="sftp-host">IP / Host</label>
					<input
						type="text"
						id="sftp-host"
						className="input"
						value={host}
						onChange={e => setHost(e.target.value)}
						placeholder="localhost or IP address"
					/>
				</div>
				<div className="form-group">
					<label htmlFor="sftp-port">Port</label>
					<input
						type="number"
						id="sftp-port"
						className="input"
						value={port}
						onChange={e => setPort(e.target.value)}
						min="1"
						max="65535"
					/>
				</div>
				<div className="form-group">
					<label htmlFor="sftp-auth-type">Authentication</label>
					<select
						id="sftp-auth-type"
						className="input"
						value={authType}
						onChange={e => setAuthType(e.target.value)}
					>
						<option value="password">Password</option>
						<option value="key">SSH Private Key</option>
						<option value="certificate">SSH Key + Certificate</option>
						<option value="agent">SSH Agent</option>
						<option value="guest">Guest / Anonymous</option>
					</select>
				</div>
				{authType !== 'guest' && (
					<div className="form-group">
						<label htmlFor="sftp-username">Username</label>
						<input
							type="text"
							id="sftp-username"
							className="input"
							value={username}
							onChange={e => setUsername(e.target.value)}
							placeholder="Username (leave blank for guest)"
						/>
					</div>
				)}
				{(authType === 'key' || authType === 'certificate') && (
					<div className="form-group">
						<label htmlFor="sftp-private-key">Private Key Path</label>
						<div style={{ display: 'flex', gap: '8px' }}>
							<input
								type="text"
								id="sftp-private-key"
								className="input"
								value={privateKeyPath}
								onChange={e => setPrivateKeyPath(e.target.value)}
								placeholder="~/.ssh/id_ed25519"
							/>
							<Button type="button" variant="secondary" onClick={() => pickFilePath(setPrivateKeyPath)}>
								Browse
							</Button>
						</div>
					</div>
				)}
				{authType === 'certificate' && (
					<div className="form-group">
						<label htmlFor="sftp-certificate">Certificate Path</label>
						<div style={{ display: 'flex', gap: '8px' }}>
							<input
								type="text"
								id="sftp-certificate"
								className="input"
								value={certificatePath}
								onChange={e => setCertificatePath(e.target.value)}
								placeholder="~/.ssh/id_ed25519-cert.pub"
							/>
							<Button type="button" variant="secondary" onClick={() => pickFilePath(setCertificatePath)}>
								Browse
							</Button>
						</div>
					</div>
				)}
				{(authType === 'password' || authType === 'key' || authType === 'certificate') && (
					<div className="form-group">
						<label htmlFor="sftp-password">
							{authType === 'password' ? 'Password' : 'Key Passphrase (optional)'}
						</label>
						<input
							type="password"
							id="sftp-password"
							className="input"
							value={password}
							onChange={e => setPassword(e.target.value)}
							placeholder={authType === 'password' ? 'Password (stored in OS keyring)' : 'Passphrase'}
						/>
					</div>
				)}
				<div className="form-group">
					<label htmlFor="sftp-compression">Transfer Compression</label>
					<select
						id="sftp-compression"
						className="input"
						value={compressionMode}
						onChange={e => setCompressionMode(e.target.value)}
					>
						<option value="auto">Auto (recommended)</option>
						<option value="always">Always</option>
						<option value="off">Off</option>
					</select>
				</div>
				{testResult && <div className="input-hint" style={{ color: 'var(--success)' }}>{testResult}</div>}
				{error && <div className="input-hint" style={{ color: 'var(--error, #e53e3e)' }}>{error}</div>}
			</form>
		</Modal>
	);
};

export default AddSftpConnectionView;
