
import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
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
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [testing, setTesting] = useState(false);
	const [saving, setSaving] = useState(false);
	const [testResult, setTestResult] = useState(null);
	const [error, setError] = useState(null);

	const handleTestConnection = async () => {
		const portNum = parseValidPort(port);
		if (!portNum) {
			setError('Port must be a number between 1 and 65535');
			return;
		}
		setTesting(true);
		setTestResult(null);
		setError(null);
		try {
			await invoke('load_dir', {
				host: host.trim(),
				port: portNum,
				username: username.trim(),
				password,
				directory: "."
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
		const trimmedUsername = username.trim();
		const portNum = parseValidPort(port);

		if (!trimmedName || !trimmedHost || !trimmedUsername) {
			setError('Name, host, and username are required');
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

		setSaving(true);
		setError(null);
		try {
			const connectionKey = `${trimmedUsername}@${trimmedHost}:${portNum}`;
			await invoke('store_sftp_credentials', { connectionKey, password });

			onAdd({
				name: trimmedName,
				host: trimmedHost,
				port: portNum,
				username: trimmedUsername
			});
			setName('');
			setHost('localhost');
			setPort('22');
			setUsername('');
			setPassword('');
			setTestResult(null);
			setError(null);
		} catch (e) {
			setError(e?.toString() || 'Failed to store SFTP credentials');
		} finally {
			setSaving(false);
		}
	};

	const handleClose = () => {
		setName('');
		setHost('localhost');
		setPort('22');
		setUsername('');
		setPassword('');
		setTestResult(null);
		setError(null);
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
						disabled={testing || !host.trim() || !port.trim() || !username.trim()}
					>
						{testing ? 'Testing...' : 'Test Connection'}
					</Button>
					<Button
						variant="primary"
						onClick={handleAdd}
						disabled={saving || !name.trim() || !host.trim() || !String(port).trim() || !username.trim()}
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
					<label htmlFor="sftp-username">Username</label>
					<input
						type="text"
						id="sftp-username"
						className="input"
						value={username}
						onChange={e => setUsername(e.target.value)}
						placeholder="Username"
					/>
				</div>
				<div className="form-group">
					<label htmlFor="sftp-password">Password</label>
					<input
						type="password"
						id="sftp-password"
						className="input"
						value={password}
						onChange={e => setPassword(e.target.value)}
						placeholder="Password"
					/>
				</div>
				{testResult && <div className="input-hint" style={{ color: 'var(--success)' }}>{testResult}</div>}
				{error && <div className="input-hint" style={{ color: 'var(--error, #e53e3e)' }}>{error}</div>}
			</form>
		</Modal>
	);
};

export default AddSftpConnectionView;
