import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { showConfirm, showError, showPasswordPrompt, showSuccess } from '../utils/NotificationSystem';
import { parseSudoFindOutput } from '../utils/sftpSudoParser';

const SFTP_CONNECTIONS_STORAGE_KEY = 'fileExplorerSftpConnections';
const HOST_KEY_UNTRUSTED_PREFIX = 'HOST_KEY_UNTRUSTED:';

const SftpContext = createContext({
    sftpConnections: [],
    currentSftpConnection: null,
    currentSftpPath: null,
    loadSftpDirectory: () => {},
    createSftpFile: () => {},
    createSftpDirectory: () => {},
    deleteSftpItem: () => {},
    renameSftpItem: () => {},
    copySftpItem: () => {},
    moveSftpItem: () => {},
    openSftpFile: () => {},
    downloadAndOpenSftpFile: () => {},
    isSftpPath: () => false,
    parseSftpPath: () => null,
    navigateToSftpConnection: () => {},
    disconnectSftp: () => {},
    createSftpUrl: () => null,
    createSftpPath: () => null,
    executeSshCommand: async () => null,
    runSshSudoOperation: async () => false,
    listDirWithSudo: async () => null,
    startSshPty: async () => null
});

export const useSftp = () => useContext(SftpContext);

/**
 * Validates and parses an SFTP port into an integer in [1, 65535].
 * Defaults to 22 only when port is null/undefined; rejects empty strings and non-numeric values.
 */
function parseSftpPort(port) {
    if (port === undefined || port === null) return 22;
    if (typeof port === 'number') {
        return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
    }
    if (typeof port === 'string') {
        const trimmed = port.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        const portNum = Number.parseInt(trimmed, 10);
        return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : null;
    }
    return null;
}

function getErrorMessage(error) {
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    return String(error);
}

function isSftpNonFallbackError(error) {
    const msg = getErrorMessage(error).toLowerCase();
    return (
        msg.startsWith('host_key_untrusted:') ||
        msg.includes('host key') ||
        msg.includes('authentication') ||
        msg.includes('auth') ||
        msg.includes('password') ||
        msg.includes('permission denied') ||
        msg.includes('timed out') ||
        msg.includes('timeout') ||
        msg.includes('connection refused') ||
        msg.includes('connection reset') ||
        msg.includes('network') ||
        msg.includes('failed to connect') ||
        msg.includes('invalid sftp port') ||
        msg.includes('cancelled')
    );
}

function normalizeSftpEntryPath(rawPath) {
    if (typeof rawPath !== 'string') return '';
    return rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function isDotEntry(normalizedPath) {
    const trimmed = normalizedPath.replace(/\/+$/, '');
    if (!trimmed) return true;
    const base = trimmed.split('/').pop();
    return base === '.' || base === '..';
}

function buildSftpConnectionKey(conn) {
    const portNum = parseSftpPort(conn?.port) ?? 22;
    return `${String(conn?.username || '').trim()}@${String(conn?.host || '').trim()}:${portNum}`;
}

/**
 * Strips plaintext passwords from connection objects before storing in React state or localStorage,
 * and returns any legacy entries that need to be migrated to the Rust credential store.
 */
function sanitizeConnectionsList(rawConnections) {
    if (!Array.isArray(rawConnections)) {
        return { sanitized: [], toMigrate: [], hadPasswordField: false };
    }

    let hadPasswordField = false;
    const toMigrate = [];
    const sanitized = rawConnections.map((conn) => {
        if (!conn || typeof conn !== 'object') return conn;
        if ('password' in conn) {
            hadPasswordField = true;
            if (typeof conn.password === 'string' && conn.password.length > 0) {
                toMigrate.push({
                    connectionKey: buildSftpConnectionKey(conn),
                    password: conn.password
                });
            }
        }
        const { password: _omitted, ...safeConn } = conn;
        return safeConn;
    });

    return { sanitized, toMigrate, hadPasswordField };
}

export default function SftpProvider({ children }) {
    const [sftpConnections, setSftpConnections] = useState([]);
    const [currentSftpConnection, setCurrentSftpConnection] = useState(null);
    const [currentSftpPath, setCurrentSftpPath] = useState(null);
    const connectionCache = useRef(new Map());
    const sudoPasswordCacheRef = useRef(new Map());
    const pendingMigrationRef = useRef(Promise.resolve());

    const readAndMigrateConnections = useCallback(() => {
        try {
            const raw = JSON.parse(localStorage.getItem(SFTP_CONNECTIONS_STORAGE_KEY) || '[]');
            const { sanitized, toMigrate, hadPasswordField } = sanitizeConnectionsList(raw);

            if (hadPasswordField) {
                localStorage.setItem(SFTP_CONNECTIONS_STORAGE_KEY, JSON.stringify(sanitized));
            }

            if (toMigrate.length > 0) {
                const migrationJob = Promise.allSettled(
                    toMigrate.map(({ connectionKey, password }) =>
                        invoke('store_sftp_credentials', { connectionKey, password })
                    )
                );
                pendingMigrationRef.current = pendingMigrationRef.current.then(() => migrationJob);
            }

            // Sync SSH auth/compression profiles to Rust backend
            for (const conn of sanitized) {
                if (!conn?.host) continue;
                const connectionKey = buildSftpConnectionKey(conn);
                if (conn.authType || conn.privateKeyPath || conn.certificatePath || conn.compressionMode) {
                    Promise.resolve(
                        invoke('store_ssh_profile', {
                            connectionKey,
                            authType: conn.authType || null,
                            privateKeyPath: conn.privateKeyPath || null,
                            certificatePath: conn.certificatePath || null,
                            compressionMode: conn.compressionMode || null
                        })
                    ).catch(() => {});
                }
            }

            return sanitized;
        } catch (err) {
            console.error('Failed to load SFTP connections:', getErrorMessage(err));
            return [];
        }
    }, []);

    // Load SFTP connections from localStorage
    const loadSftpConnections = useCallback(() => {
        const sanitized = readAndMigrateConnections();
        setSftpConnections(sanitized);
        return sanitized;
    }, [readAndMigrateConnections]);

    // Initialize SFTP connections on mount
    React.useEffect(() => {
        loadSftpConnections();
        const handler = () => loadSftpConnections();
        window.addEventListener('sftp-connections-updated', handler);
        return () => window.removeEventListener('sftp-connections-updated', handler);
    }, [loadSftpConnections]);

    /**
     * Invokes a Rust SFTP command with port validation, credential migration sync,
     * and interactive HOST_KEY_UNTRUSTED verification/retry.
     */
    const invokeSftp = useCallback(async (command, connection, extraArgs = {}) => {
        const portNum = parseSftpPort(connection?.port);
        if (portNum === null) {
            throw new Error(`Invalid SFTP port: ${connection?.port}`);
        }

        await pendingMigrationRef.current;

        const payload = {
            host: connection.host,
            port: portNum,
            username: connection.username || '',
            password: connection.password || '',
            ...(command === 'load_dir' && (
                connection.authType ||
                connection.privateKeyPath ||
                connection.certificatePath ||
                connection.compressionMode
            ) ? {
                authType: connection.authType || null,
                privateKeyPath: connection.privateKeyPath || null,
                certificatePath: connection.certificatePath || null,
                compressionMode: connection.compressionMode || null
            } : {}),
            ...extraArgs
        };

        try {
            return await invoke(command, payload);
        } catch (error) {
            const errMsg = getErrorMessage(error).trim();
            if (!errMsg.startsWith(HOST_KEY_UNTRUSTED_PREFIX)) {
                throw error;
            }

            const fingerprint = errMsg.slice(HOST_KEY_UNTRUSTED_PREFIX.length).trim();
            const confirmed = await showConfirm(
                `The authenticity of host '${connection.host}:${portNum}' can't be established.\nFingerprint: ${fingerprint}\n\nDo you want to trust this host key and continue?`,
                'Untrusted SSH Host Key'
            );

            if (!confirmed) {
                throw new Error('Host key verification cancelled by user');
            }

            await invoke('trust_sftp_host_key', {
                host: connection.host,
                port: portNum,
                expectedFingerprint: fingerprint
            });

            return await invoke(command, payload);
        }
    }, []);

    // Check if a path is an SFTP path
    const isSftpPath = useCallback((path) => {
        return typeof path === 'string' && (path.startsWith('sftp://') || path.startsWith('sftp:'));
    }, []);

    // Parse SFTP path to extract connection details and remote path
    const parseSftpPath = useCallback((path) => {
        if (!isSftpPath(path)) {
            return null;
        }

        try {
            let connections = sftpConnections;
            if (connections.length === 0) {
                connections = readAndMigrateConnections();
            }

            if (path.startsWith('sftp://')) {
                const url = new URL(path);
                const urlUsername = decodeURIComponent(url.username || '');
                const urlHostname = url.hostname;
                const urlPort = url.port || '22';

                const connection = connections.find((conn) => {
                    const connPort = parseSftpPort(conn.port) ?? conn.port ?? 22;
                    return (
                        (conn.username || '') === urlUsername &&
                        (conn.host || '') === urlHostname &&
                        String(connPort) === urlPort
                    );
                });

                const remotePath = decodeURIComponent(url.pathname || '/') || '/';
                return {
                    connection,
                    remotePath,
                    connectionName: connection?.name
                };
            }

            // Connection name format: sftp:connectionName[:remotePath]
            const withoutPrefix = path.slice('sftp:'.length);

            // Match longest known connection name first so ':' inside connection names works reliably
            const sortedConnections = [...connections].sort(
                (a, b) => (b?.name?.length || 0) - (a?.name?.length || 0)
            );
            for (const conn of sortedConnections) {
                if (!conn?.name) continue;
                if (withoutPrefix === conn.name) {
                    return {
                        connection: conn,
                        remotePath: '.',
                        connectionName: conn.name
                    };
                }
                if (withoutPrefix.startsWith(`${conn.name}:`)) {
                    const remotePath = withoutPrefix.slice(conn.name.length + 1) || '.';
                    return {
                        connection: conn,
                        remotePath,
                        connectionName: conn.name
                    };
                }
            }

            // Fallback when connection is not found in known connections
            const colonIndex = withoutPrefix.indexOf(':');
            if (colonIndex === -1) {
                return {
                    connection: undefined,
                    remotePath: '.',
                    connectionName: withoutPrefix
                };
            }

            return {
                connection: undefined,
                remotePath: withoutPrefix.slice(colonIndex + 1) || '.',
                connectionName: withoutPrefix.slice(0, colonIndex)
            };
        } catch (err) {
            console.error('Failed to parse SFTP path:', getErrorMessage(err));
            return null;
        }
    }, [sftpConnections, isSftpPath, readAndMigrateConnections]);

    // Create SFTP URL for a connection and path
    const createSftpUrl = useCallback((connection, remotePath = '/') => {
        if (!connection) return null;
        return `sftp:${connection.name}:${remotePath}`;
    }, []);

    // Create SFTP path for a connection and path (internal format)
    const createSftpPath = useCallback((connection, remotePath = '.') => {
        if (!connection) return null;
        return `sftp:${connection.name}:${remotePath}`;
    }, []);

    const isPermissionDeniedError = useCallback((err) => {
        const msg = getErrorMessage(err).toLowerCase();
        return msg.includes('permission denied') || msg.includes('eacces') || msg.includes('operation not permitted');
    }, []);

    const isSudoAuthError = useCallback((err) => {
        const msg = getErrorMessage(err).toLowerCase();
        return (
            msg.includes('incorrect password') ||
            msg.includes('sorry, try again') ||
            msg.includes('authentication failure') ||
            msg.includes('a password is required') ||
            msg.includes('wrong password')
        );
    }, []);

    const executeWithSudoPassword = useCallback(async (connection, promptText, runner) => {
        const cacheKey = buildSftpConnectionKey(connection);
        let sudoPassword = sudoPasswordCacheRef.current.get(cacheKey);
        let promptedNow = false;

        if (!sudoPassword) {
            sudoPassword = await showPasswordPrompt(promptText, 'Elevated SSH Operation (sudo)');
            if (!sudoPassword) {
                return { cancelled: true, result: null };
            }
            sudoPasswordCacheRef.current.set(cacheKey, sudoPassword);
            promptedNow = true;
        }

        try {
            const result = await runner(sudoPassword);
            return { cancelled: false, result };
        } catch (err) {
            if (isSudoAuthError(err)) {
                sudoPasswordCacheRef.current.delete(cacheKey);
                if (!promptedNow) {
                    const retryPassword = await showPasswordPrompt(
                        `Cached sudo password failed on ${connection.host}.\nEnter sudo password:`,
                        'Elevated SSH Operation (sudo)'
                    );
                    if (!retryPassword) {
                        return { cancelled: true, result: null };
                    }
                    sudoPasswordCacheRef.current.set(cacheKey, retryPassword);
                    try {
                        const retryResult = await runner(retryPassword);
                        return { cancelled: false, result: retryResult };
                    } catch (retryErr) {
                        if (isSudoAuthError(retryErr)) {
                            sudoPasswordCacheRef.current.delete(cacheKey);
                        }
                        throw retryErr;
                    }
                }
            }
            throw err;
        }
    }, [isSudoAuthError]);

    const listDirWithSudo = useCallback(async (connection, remotePath) => {
        if (!connection?.host) return null;
        const targetDir = remotePath || '.';
        const outcome = await executeWithSudoPassword(
            connection,
            `Permission denied for "${targetDir}".\nEnter sudo password to open with sudo on ${connection.host}:`,
            (sudoPassword) =>
                invokeSftp('ssh_sudo_exec', connection, {
                    sudoPassword,
                    operation: 'list_dir',
                    path: targetDir,
                    targetPath: null,
                    content: null,
                    authType: connection.authType || null,
                    privateKeyPath: connection.privateKeyPath || null,
                    certificatePath: connection.certificatePath || null,
                    compressionMode: connection.compressionMode || null,
                })
        );
        if (outcome.cancelled) return null;

        const parsed = parseSudoFindOutput(outcome.result, connection, targetDir, createSftpUrl);
        return {
            directory: createSftpUrl(connection, targetDir),
            directories: parsed.directories,
            files: parsed.files,
            elevated: true,
        };
    }, [executeWithSudoPassword, invokeSftp, createSftpUrl]);

    // Navigate to an SFTP connection
    const navigateToSftpConnection = useCallback(async (connection, remotePath = '.', options = {}) => {
        if (!connection) {
            console.error('No connection provided to navigateToSftpConnection');
            return null;
        }

        try {
            const sftpPath = remotePath || '.';
            if (options?.isCurrent?.() === false) return null;
            const result = await invokeSftp('load_dir', connection, { directory: sftpPath });
            if (options?.isCurrent?.() === false) return null;
            const dirData = JSON.parse(result);

            const mapEntries = (items, isDirectory) => {
                const mapped = [];
                for (const rawItem of items || []) {
                    const rawPath = typeof rawItem === 'string' ? rawItem : (rawItem?.path || rawItem?.name || '');
                    const normalized = normalizeSftpEntryPath(rawPath);
                    if (isDotEntry(normalized)) continue;

                    const fullPath = normalized.startsWith('./') ? normalized.substring(2) : normalized;
                    const trimmedFull = fullPath.replace(/\/+$/, '');
                    const name = trimmedFull.split('/').pop() || trimmedFull;
                    const sizeBytes = typeof rawItem === 'object' && rawItem !== null
                        ? (rawItem.size_in_bytes ?? rawItem.size ?? 0)
                        : 0;
                    const lastModified = typeof rawItem === 'object' && rawItem !== null
                        ? (rawItem.last_modified ?? rawItem.modified ?? null)
                        : null;
                    const isSymlink = typeof rawItem === 'object' && rawItem !== null
                        ? Boolean(rawItem.is_symlink)
                        : false;

                    const entry = {
                        name: name || (isDirectory ? 'Directory' : 'File'),
                        path: createSftpUrl(connection, fullPath),
                        isDirectory,
                        is_symlink: isSymlink,
                        size_in_bytes: sizeBytes,
                        last_modified: lastModified,
                        size: sizeBytes,
                        modified: lastModified
                    };

                    if (isDirectory) {
                        entry.sub_file_count = typeof rawItem === 'object' && rawItem !== null
                            ? (rawItem.sub_file_count ?? 0)
                            : 0;
                        entry.sub_dir_count = typeof rawItem === 'object' && rawItem !== null
                            ? (rawItem.sub_dir_count ?? 0)
                            : 0;
                    }

                    mapped.push(entry);
                }
                return mapped;
            };

            const transformedData = {
                directory: createSftpUrl(connection, remotePath),
                directories: mapEntries(dirData.directories, true),
                files: mapEntries(dirData.files, false)
            };

            // Update active SFTP state only for the current directory request.
            if (options?.isCurrent?.() === false) return null;
            setCurrentSftpConnection(connection);
            setCurrentSftpPath(remotePath);

            return transformedData;
        } catch (error) {
            const errMsg = getErrorMessage(error);
            if (options?.isCurrent?.() === false) return null;
            console.error('Failed to load SFTP directory:', errMsg);
            if (isPermissionDeniedError(error) && !options?.silentError) {
                try {
                    const elevatedData = await listDirWithSudo(connection, remotePath || '.');
                    if (options?.isCurrent?.() === false) return null;
                    if (elevatedData) {
                        setCurrentSftpConnection(connection);
                        setCurrentSftpPath(remotePath || '.');
                        return elevatedData;
                    }
                } catch (sudoErr) {
                    if (options?.isCurrent?.() === false) return null;
                    showError(`sudo open failed for "${remotePath}": ${getErrorMessage(sudoErr)}`);
                    return null;
                }
                showError(`Permission denied for "${remotePath}" (user ${connection.username || 'unknown'})`);
                return null;
            }
            if (!options?.silentError) {
                if (isPermissionDeniedError(error)) {
                    showError(`Permission denied for "${remotePath}" (user ${connection.username || 'unknown'})`);
                } else {
                    showError(`Failed to load "${remotePath}": ${errMsg}`);
                }
            }
            return null;
        }
    }, [createSftpUrl, invokeSftp, isPermissionDeniedError, listDirWithSudo]);

    // Load SFTP directory
    const loadSftpDirectory = useCallback(async (sftpPath, options = {}) => {
        if (options?.isCurrent?.() === false) return null;
        const parsed = parseSftpPath(sftpPath);

        if (!parsed || !parsed.connection) {
            console.error('Invalid SFTP path or connection not found');
            if (!options?.silentError) {
                showError('Invalid SFTP path or connection not found');
            }
            return null;
        }

        try {
            return await navigateToSftpConnection(parsed.connection, parsed.remotePath, options);
        } catch (error) {
            const errMsg = getErrorMessage(error);
            if (options?.isCurrent?.() === false) return null;
            console.error('Error in loadSftpDirectory:', errMsg);
            if (!options?.silentError) {
                showError(`Failed to load SFTP directory: ${errMsg}`);
            }
            return null;
        }
    }, [parseSftpPath, navigateToSftpConnection]);

    const runSshSudoOperation = useCallback(async (connection, operation, remotePath, targetPath = null, content = null) => {
        if (!connection?.host) return false;
        try {
            const outcome = await executeWithSudoPassword(
                connection,
                `Permission denied for "${remotePath}".\nEnter sudo password to run "${operation}" on ${connection.host}:`,
                (sudoPassword) =>
                    invokeSftp('ssh_sudo_exec', connection, {
                        sudoPassword,
                        operation,
                        path: remotePath,
                        targetPath,
                        content,
                        authType: connection.authType || null,
                        privateKeyPath: connection.privateKeyPath || null,
                        certificatePath: connection.certificatePath || null,
                        compressionMode: connection.compressionMode || null
                    })
            );
            return !outcome.cancelled;
        } catch (sudoErr) {
            showError(`sudo ${operation} failed: ${getErrorMessage(sudoErr)}`);
            return false;
        }
    }, [executeWithSudoPassword, invokeSftp]);

    const executeSshCommand = useCallback(async (connection, command, workingDir = null) => {
        const raw = await invokeSftp('ssh_execute_command', connection, {
            command,
            workingDir,
            authType: connection.authType || null,
            privateKeyPath: connection.privateKeyPath || null,
            certificatePath: connection.certificatePath || null,
            compressionMode: connection.compressionMode || null
        });
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }, [invokeSftp]);

    const startSshPty = useCallback(async (connection, workingDir = '.') => {
        return await invokeSftp('ssh_start_pty', connection, {
            workingDir,
            authType: connection.authType || null,
            privateKeyPath: connection.privateKeyPath || null,
            certificatePath: connection.certificatePath || null,
            compressionMode: connection.compressionMode || null
        });
    }, [invokeSftp]);

    // SFTP file operations
    const createSftpFile = useCallback(async (sftpPath, fileName) => {
        const parsed = parseSftpPath(sftpPath);
        if (!parsed || !parsed.connection) return false;

        const filePath = `${parsed.remotePath}/${fileName}`.replace(/\/+/g, '/');
        try {
            await invokeSftp('create_file_sftp', parsed.connection, { filePath });
            showSuccess(`File "${fileName}" created successfully`);
            return true;
        } catch (error) {
            if (isPermissionDeniedError(error)) {
                const elevated = await runSshSudoOperation(parsed.connection, 'create_file', filePath);
                if (elevated) {
                    showSuccess(`File "${fileName}" created with sudo`);
                    return true;
                }
            }
            const errMsg = getErrorMessage(error);
            console.error('Failed to create SFTP file:', errMsg);
            showError(`Failed to create file: ${errMsg}`);
            return false;
        }
    }, [parseSftpPath, invokeSftp, runSshSudoOperation]);

    const createSftpDirectory = useCallback(async (sftpPath, dirName) => {
        const parsed = parseSftpPath(sftpPath);
        if (!parsed || !parsed.connection) return false;

        const directoryPath = `${parsed.remotePath}/${dirName}`.replace(/\/+/g, '/');
        try {
            await invokeSftp('create_directory_sftp', parsed.connection, { directoryPath });
            showSuccess(`Directory "${dirName}" created successfully`);
            return true;
        } catch (error) {
            if (isPermissionDeniedError(error)) {
                const elevated = await runSshSudoOperation(parsed.connection, 'mkdir', directoryPath);
                if (elevated) {
                    showSuccess(`Directory "${dirName}" created with sudo`);
                    return true;
                }
            }
            const errMsg = getErrorMessage(error);
            console.error('Failed to create SFTP directory:', errMsg);
            showError(`Failed to create directory: ${errMsg}`);
            return false;
        }
    }, [parseSftpPath, invokeSftp, runSshSudoOperation]);

    const deleteSftpItem = useCallback(async (sftpPath, isDirectory) => {
        const parsed = parseSftpPath(sftpPath);
        if (!parsed || !parsed.connection) return false;

        try {
            if (isDirectory === true) {
                await invokeSftp('delete_directory_sftp', parsed.connection, { directoryPath: parsed.remotePath });
                showSuccess('Directory deleted successfully');
                return true;
            }
            if (isDirectory === false) {
                await invokeSftp('delete_file_sftp', parsed.connection, { filePath: parsed.remotePath });
                showSuccess('File deleted successfully');
                return true;
            }

            try {
                await invokeSftp('delete_file_sftp', parsed.connection, { filePath: parsed.remotePath });
                showSuccess('File deleted successfully');
                return true;
            } catch (fileError) {
                if (isSftpNonFallbackError(fileError)) throw fileError;
                await invokeSftp('delete_directory_sftp', parsed.connection, { directoryPath: parsed.remotePath });
                showSuccess('Directory deleted successfully');
                return true;
            }
        } catch (error) {
            if (
                isPermissionDeniedError(error) &&
                parsed.remotePath !== '/' &&
                parsed.remotePath !== '.'
            ) {
                const op = isDirectory === false ? 'delete_file' : 'delete_dir';
                const elevated = await runSshSudoOperation(parsed.connection, op, parsed.remotePath);
                if (elevated) {
                    showSuccess('Item deleted with sudo');
                    return true;
                }
            }
            const errMsg = getErrorMessage(error);
            console.error('Failed to delete SFTP item:', errMsg);
            showError(`Failed to delete item: ${errMsg}`);
            return false;
        }
    }, [parseSftpPath, invokeSftp, runSshSudoOperation]);

    const renameSftpItem = useCallback(async (sftpPath, newName, isDirectory) => {
        const parsed = parseSftpPath(sftpPath);
        if (!parsed || !parsed.connection) return false;

        const normalizedRemote = normalizeSftpEntryPath(parsed.remotePath);
        const pathParts = normalizedRemote.split('/');
        pathParts[pathParts.length - 1] = newName;
        const newPath = pathParts.join('/');

        try {
            if (isDirectory === true) {
                await invokeSftp('rename_directory_sftp', parsed.connection, {
                    oldPath: parsed.remotePath,
                    newPath
                });
            } else if (isDirectory === false) {
                await invokeSftp('rename_file_sftp', parsed.connection, {
                    oldPath: parsed.remotePath,
                    newPath
                });
            } else {
                try {
                    await invokeSftp('rename_file_sftp', parsed.connection, {
                        oldPath: parsed.remotePath,
                        newPath
                    });
                } catch (fileError) {
                    if (isSftpNonFallbackError(fileError)) throw fileError;
                    await invokeSftp('rename_directory_sftp', parsed.connection, {
                        oldPath: parsed.remotePath,
                        newPath
                    });
                }
            }

            showSuccess(`Item renamed to "${newName}" successfully`);
            return true;
        } catch (error) {
            if (isPermissionDeniedError(error)) {
                const elevated = await runSshSudoOperation(parsed.connection, 'rename', parsed.remotePath, newPath);
                if (elevated) {
                    showSuccess(`Item renamed to "${newName}" with sudo`);
                    return true;
                }
            }
            const errMsg = getErrorMessage(error);
            console.error('Failed to rename SFTP item:', errMsg);
            showError(`Failed to rename item: ${errMsg}`);
            return false;
        }
    }, [parseSftpPath, invokeSftp, runSshSudoOperation]);

    const copySftpItem = useCallback(async (sftpPath, targetPath, isDirectory) => {
        const sourceParsed = parseSftpPath(sftpPath);
        const targetParsed = parseSftpPath(targetPath);

        if (!sourceParsed || !targetParsed || !sourceParsed.connection || !targetParsed.connection) {
            return false;
        }

        if (sourceParsed.connection.name !== targetParsed.connection.name) {
            showError('Copying between different SFTP connections is not yet supported');
            return false;
        }

        try {
            const args = {
                sourcePath: sourceParsed.remotePath,
                destinationPath: targetParsed.remotePath
            };

            if (isDirectory === true) {
                await invokeSftp('copy_directory_sftp', sourceParsed.connection, args);
            } else if (isDirectory === false) {
                await invokeSftp('copy_file_sftp', sourceParsed.connection, args);
            } else {
                try {
                    await invokeSftp('copy_file_sftp', sourceParsed.connection, args);
                } catch (fileError) {
                    if (isSftpNonFallbackError(fileError)) throw fileError;
                    await invokeSftp('copy_directory_sftp', sourceParsed.connection, args);
                }
            }

            showSuccess('Item copied successfully');
            return true;
        } catch (error) {
            const errMsg = getErrorMessage(error);
            console.error('Failed to copy SFTP item:', errMsg);
            showError(`Failed to copy item: ${errMsg}`);
            return false;
        }
    }, [parseSftpPath, invokeSftp]);

    const moveSftpItem = useCallback(async (sftpPath, targetPath, isDirectory) => {
        const sourceParsed = parseSftpPath(sftpPath);
        const targetParsed = parseSftpPath(targetPath);

        if (!sourceParsed || !targetParsed || !sourceParsed.connection || !targetParsed.connection) {
            return false;
        }

        if (sourceParsed.connection.name !== targetParsed.connection.name) {
            showError('Moving between different SFTP connections is not yet supported');
            return false;
        }

        try {
            const args = {
                sourcePath: sourceParsed.remotePath,
                destinationPath: targetParsed.remotePath
            };

            if (isDirectory === true) {
                await invokeSftp('move_directory_sftp', sourceParsed.connection, args);
            } else if (isDirectory === false) {
                await invokeSftp('move_file_sftp', sourceParsed.connection, args);
            } else {
                try {
                    await invokeSftp('move_file_sftp', sourceParsed.connection, args);
                } catch (fileError) {
                    if (isSftpNonFallbackError(fileError)) throw fileError;
                    await invokeSftp('move_directory_sftp', sourceParsed.connection, args);
                }
            }

            showSuccess('Item moved successfully');
            return true;
        } catch (error) {
            const errMsg = getErrorMessage(error);
            console.error('Failed to move SFTP item:', errMsg);
            showError(`Failed to move item: ${errMsg}`);
            return false;
        }
    }, [parseSftpPath, invokeSftp]);

    const openSftpFile = useCallback(async (sftpPath) => {
        const parsed = parseSftpPath(sftpPath);
        if (!parsed || !parsed.connection) return null;

        try {
            return await invokeSftp('open_file_sftp', parsed.connection, {
                filePath: parsed.remotePath
            });
        } catch (error) {
            if (isPermissionDeniedError(error)) {
                try {
                    const outcome = await executeWithSudoPassword(
                        parsed.connection,
                        `Permission denied for "${parsed.remotePath}".\nEnter sudo password to read file on ${parsed.connection.host}:`,
                        (sudoPassword) =>
                            invokeSftp('ssh_sudo_exec', parsed.connection, {
                                sudoPassword,
                                operation: 'read_file',
                                path: parsed.remotePath,
                                targetPath: null,
                                content: null,
                                authType: parsed.connection.authType || null,
                                privateKeyPath: parsed.connection.privateKeyPath || null,
                                certificatePath: parsed.connection.certificatePath || null,
                                compressionMode: parsed.connection.compressionMode || null,
                            })
                    );
                    if (!outcome.cancelled) {
                        return outcome.result;
                    }
                } catch (sudoErr) {
                    showError(`sudo read failed: ${getErrorMessage(sudoErr)}`);
                    return null;
                }
            }
            const errMsg = getErrorMessage(error);
            console.error('Failed to open SFTP file:', errMsg);
            showError(`Failed to open file: ${errMsg}`);
            return null;
        }
    }, [parseSftpPath, invokeSftp, isPermissionDeniedError, executeWithSudoPassword]);

    const downloadAndOpenSftpFile = useCallback(async (sftpPath, openFile = true) => {
        const parsed = parseSftpPath(sftpPath);
        if (!parsed || !parsed.connection) {
            showError('Invalid SFTP path or connection not found');
            return null;
        }

        try {
            const result = await invokeSftp('download_and_open_sftp_file', parsed.connection, {
                filePath: parsed.remotePath,
                openFile
            });

            if (openFile) {
                showSuccess('File opened successfully');
            } else {
                showSuccess('File downloaded successfully');
            }

            return result;
        } catch (error) {
            const errMsg = getErrorMessage(error);
            console.error('Failed to download SFTP file:', errMsg);
            showError(`Failed to download file: ${errMsg}`);
            return null;
        }
    }, [parseSftpPath, invokeSftp]);

    const disconnectSftp = useCallback(() => {
        setCurrentSftpConnection(null);
        setCurrentSftpPath(null);
        connectionCache.current.clear();
        sudoPasswordCacheRef.current.clear();
    }, []);

    const value = {
        sftpConnections,
        currentSftpConnection,
        currentSftpPath,
        loadSftpDirectory,
        createSftpFile,
        createSftpDirectory,
        deleteSftpItem,
        renameSftpItem,
        copySftpItem,
        moveSftpItem,
        openSftpFile,
        downloadAndOpenSftpFile,
        isSftpPath,
        parseSftpPath,
        navigateToSftpConnection,
        disconnectSftp,
        createSftpUrl,
        createSftpPath,
        executeSshCommand,
        runSshSudoOperation,
        listDirWithSudo,
        startSshPty
    };

    return (
        <SftpContext.Provider value={value}>
            {children}
        </SftpContext.Provider>
    );
}
