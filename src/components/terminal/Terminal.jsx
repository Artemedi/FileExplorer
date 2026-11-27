import React, { useState, useRef, useEffect, useContext } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useHistory } from '../../providers/HistoryProvider';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useSettings } from '../../providers/SettingsProvider';
import { useSftp } from '../../providers/SftpProvider';
import Icon from '../common/Icon';
import { ExplorerTabsContext } from '../tabs/TabManager';
import XtermSshView from './XtermSshView';
import { joinPath } from '../../utils/pathUtils';
import {
    buildShellIntegrationCommand,
    consumeOscChunk,
    escapePosixSingleQuote,
    extractOscDirectory,
    extractOscPromptState,
    getParentRemoteDirs,
    isElevationCommand,
    normalizeRemotePosixPath,
} from '../../utils/terminalOsc';
import './terminal.css';

const MAX_PTY_INPUT_BYTES = 1024 * 1024;
const MAX_PTY_INPUT_ITEMS = 1024;
const MAX_PENDING_PTY_OUTPUT = 256 * 1024; // UTF-16 code units, not bytes
const PTY_STARTUP_TRUNCATED = '[SSH startup output truncated; newest output retained]';

const isLocalDirectory = (path) => typeof path === 'string' && path.length > 0 && !path.startsWith('sftp:');

const parseCommandArgs = (input) => {
    const tokens = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (/\s/.test(ch)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += ch;
        }
    }
    if (current.length > 0) {
        tokens.push(current);
    }
    return tokens;
};

const formatCommandResponse = (rawOutput, command) => {
    let parsed = rawOutput;
    if (typeof rawOutput === 'string') {
        try {
            parsed = JSON.parse(rawOutput);
        } catch {
            return { type: 'output', content: rawOutput || '' };
        }
    }

    if (parsed && typeof parsed === 'object' && ('status' in parsed || 'stdout' in parsed || 'stderr' in parsed)) {
        const stdout = (parsed.stdout || '').trim();
        const stderr = (parsed.stderr || '').trim();
        const status = parsed.status ?? 0;

        if (status === 0) {
            return { type: 'output', content: stdout || '' };
        }

        if (status === 1 && !stdout && !stderr) {
            const cmdName = parseCommandArgs(command)[0] || command;
            return { type: 'error', content: `Command not found: ${cmdName}` };
        }

        if (stderr) {
            return { type: 'error', content: stdout ? `${stdout}\n${stderr}` : stderr };
        }

        return {
            type: 'error',
            content: stdout || `Command failed with status ${status}`,
        };
    }

    return { type: 'output', content: rawOutput || '' };
};

const escapeHtml = (str) => String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const stripAnsiCodes = (str) => String(str ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');

const buildWelcomeEntry = (label, dir) => ({
    type: 'system',
    content: `File Explorer Terminal v2.0 (${label})
Current directory: ${dir || '/'}

Type 'help' to see available commands.
Command history is persistent across sessions.
Use Ctrl+R for reverse search, Ctrl+C to interrupt commands.`,
    timestamp: new Date().toLocaleTimeString(),
});

const getSshConnectionKey = (conn) =>
    JSON.stringify([conn.name || '', conn.username || 'guest', conn.host, Number(conn.port || 22)]);

const getExplorerSshKey = (explorerTabId, conn) => JSON.stringify([explorerTabId, getSshConnectionKey(conn)]);

const buildSshTab = (id, conn, remoteDir, followsExplorer, explorerTabId = null, numbered = false) => {
    const label = `SSH: ${conn.name || conn.host}${followsExplorer && !numbered ? '' : ' #' + id.slice(4)}`;
    const dir = remoteDir || '.';
    return {
        id,
        label,
        history: [
            buildWelcomeEntry(label, dir),
            {
                type: 'system',
                content: `[SSH] Terminal session ready for ${conn.username || 'guest'}@${conn.host}:${conn.port || 22}`,
                timestamp: new Date().toLocaleTimeString(),
            },
        ],
        sshConnection: conn,
        sshFollowsExplorer: followsExplorer,
        sshExplorerTabId: explorerTabId,
        sshWorkingDir: dir,
        sshConfirmedDir: null,
        ptySessionId: null,
        ptyStatus: 'idle',
        ptyDisabledManually: false,
    };
};

const parsePrompt = (promptStr = '') => {
    const atIdx = promptStr.indexOf('@');
    const colonIdx = promptStr.indexOf(':', atIdx + 1);
    const user = atIdx !== -1 ? promptStr.slice(0, atIdx) : 'user';
    const host = colonIdx !== -1
        ? promptStr.slice(atIdx + 1, colonIdx)
        : (atIdx !== -1 ? promptStr.slice(atIdx + 1) : 'localhost');
    let path = colonIdx !== -1 ? promptStr.slice(colonIdx + 1) : '/';
    if (path.endsWith('$')) {
        path = path.slice(0, -1);
    }
    return { user, host, path };
};

const resolveTerminalCdPath = (targetPath, basePath) => {
    const rawTarget = (targetPath || '').trim();
    const isWindowsDrive = /^[A-Za-z]:/.test(rawTarget) || (!rawTarget.startsWith('/') && /^[A-Za-z]:/.test(basePath || ''));

    let combined;
    if (/^[A-Za-z]:/.test(rawTarget) || rawTarget.startsWith('/')) {
        combined = rawTarget;
    } else if (/^\\\\/.test(rawTarget)) {
        combined = rawTarget;
    } else {
        const base = basePath || '/';
        const normalizedBase = base.replace(/[/\\]+$/, '') || (base.startsWith('/') ? '/' : '');
        combined = normalizedBase === '/' ? `/${rawTarget}` : `${normalizedBase}/${rawTarget}`;
    }

    if (isWindowsDrive || /^[A-Za-z]:/.test(combined)) {
        const driveMatch = combined.match(/^([A-Za-z]:)(.*)$/);
        const drive = driveMatch ? driveMatch[1] : '';
        const rest = driveMatch ? driveMatch[2] : combined;
        const parts = rest.split(/[/\\]+/);
        const stack = [];
        for (const part of parts) {
            if (!part || part === '.') continue;
            if (part === '..') {
                if (stack.length > 0) stack.pop();
            } else {
                stack.push(part);
            }
        }
        return stack.length > 0 ? `${drive}\\${stack.join('\\')}` : `${drive}\\`;
    }

    const parts = combined.split('/');
    const stack = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (stack.length > 0) stack.pop();
        } else {
            stack.push(part);
        }
    }
    return stack.length > 0 ? '/' + stack.join('/') : '/';
};

/**
 * Terminal component - Provides a command-line interface within the application
 * Supports built-in commands and passes through system commands
 *
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the terminal is currently open
 * @param {Function} props.onToggle - Callback function to toggle terminal visibility
 * @returns {React.ReactElement} Terminal component
 */
const Terminal = ({ isOpen, onToggle, explorerVisible = true }) => {
    const { currentPath, navigateTo } = useHistory();
    const { loadDirectory, getDirectoryRequestId } = useFileSystem();
    const explorerTabs = useContext(ExplorerTabsContext);
    const explorerScope = explorerTabs?.scope;
    // Standalone Terminal consumers have a single implicit Explorer owner.
    const explorerTabId = explorerTabs ? explorerScope.tabId : 'legacy';
    const explorerHome = !explorerVisible || explorerTabs?.tabs.find((tab) => tab.id === explorerTabId)?.path === null;
    const explorerHomeRef = useRef(explorerHome);
    explorerHomeRef.current = explorerHome;
    const explorerScopeRef = useRef(null);
    explorerScopeRef.current = explorerTabs?.getScope || (() => null);
    const directoryRequestIdRef = useRef(getDirectoryRequestId);
    directoryRequestIdRef.current = getDirectoryRequestId;
    const lastExplorerRevisionRef = useRef(null);
    const { settings } = useSettings();
    const { isSftpPath, parseSftpPath, createSftpUrl, executeSshCommand, startSshPty } = useSftp();
    const parsedSftp = isSftpPath(currentPath) ? parseSftpPath(currentPath) : null;
    const currentPathRef = useRef(currentPath);
    currentPathRef.current = currentPath;

    const [isFullscreen, setIsFullscreen] = useState(false);
    const xtermControllersRef = useRef({});
    const nextSshTabIdRef = useRef(0);
    const explorerSshTabsRef = useRef(new Map());
    const pendingPtyStartsRef = useRef(new Map());
    const ptyOwnersRef = useRef(new Map());
    const earlyPtyExitRef = useRef(new Map());
    const pendingPtyOutputRef = useRef(new Map());
    const finalizingPtyRef = useRef(new Map());
    const failedPtyWritesRef = useRef(new Set());
    const ptyInputQueuesRef = useRef(new Map());
    const [ptyListenersReady, setPtyListenersReady] = useState(false);
    const terminalNavigationRef = useRef(new Map());
    const explorerCdRef = useRef(new Map());
    const oscBufferRef = useRef(new Map());
    const shellIdleRef = useRef(new Map());
    const shellHookSeenRef = useRef(new Map());
    const ptyInputLineRef = useRef(new Map());
    const sshHomeDirRef = useRef(new Map());
    const lastFailedSyncDirRef = useRef(new Map());
    const pendingElevationReinjectRef = useRef(new Map());
    const elevationTimerRef = useRef(new Map());
    const forceSyncNextOscRef = useRef(new Set());

    const loadDirectoryRef = useRef(loadDirectory);
    loadDirectoryRef.current = loadDirectory;
    const isSftpPathRef = useRef(isSftpPath);
    isSftpPathRef.current = isSftpPath;
    const parseSftpPathRef = useRef(parseSftpPath);
    parseSftpPathRef.current = parseSftpPath;
    const createSftpUrlRef = useRef(createSftpUrl);
    createSftpUrlRef.current = createSftpUrl;

    const [terminalTabs, setTerminalTabs] = useState(() => ([
        {
            id: 'local',
            label: 'Local',
            history: [buildWelcomeEntry('Local', currentPath || '/')],
            sshConnection: null,
            sshWorkingDir: '.',
            ptySessionId: null,
            ptyDisabledManually: false,
        },
    ]));
    const [activeTabId, setActiveTabId] = useState('local');
    const activeTabIdRef = useRef(activeTabId);
    const terminalSelectionRevisionRef = useRef(0);
    const selectTerminalTab = (id) => {
        if (activeTabIdRef.current !== id) {
            activeTabIdRef.current = id;
            terminalSelectionRevisionRef.current += 1;
        }
        setActiveTabId(id);
    };
    const terminalTabsRef = useRef(terminalTabs);
    terminalTabsRef.current = terminalTabs;

    const activeTab = terminalTabs.find((t) => t.id === activeTabId) || terminalTabs[0];
    const commandHistory = activeTab?.history || [];
    const activeSshConnection = activeTab?.sshConnection || null;
    const sshWorkingDir = activeTab?.sshWorkingDir || '.';
    const ptySessionId = activeTab?.ptySessionId || null;

    const updateTab = (tabId, updater) => {
        setTerminalTabs((prev) =>
            prev.map((tab) => {
                if (tab.id !== tabId) return tab;
                return typeof updater === 'function' ? updater(tab) : { ...tab, ...updater };
            })
        );
    };

    const setCommandHistory = (updater, targetId = activeTabIdRef.current) => {
        updateTab(targetId, (tab) => ({
            ...tab,
            history: typeof updater === 'function' ? updater(tab.history) : updater,
        }));
    };

    const [currentCommand, setCurrentCommand] = useState('');
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [persistentHistory, setPersistentHistory] = useState([]);
    const [isExecuting, setIsExecuting] = useState(false);
    const [abortController, setAbortController] = useState(null);
    const [isSearchMode, setIsSearchMode] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [selectedSearchIndex, setSelectedSearchIndex] = useState(-1);
    const inputRef = useRef(null);
    const terminalRef = useRef(null);
    const ptySessionIdRef = useRef(null);
    ptySessionIdRef.current = ptySessionId;

    const cleanupSessionTracking = (sessionId) => {
        if (!sessionId) return;
        pendingPtyOutputRef.current.delete(sessionId);
        explorerCdRef.current.delete(sessionId);
        failedPtyWritesRef.current.delete(sessionId);
        const queue = ptyInputQueuesRef.current.get(sessionId);
        if (queue) {
            queue.active?.resolve(false);
            for (const item of queue.pending) item.resolve(false);
            queue.pending.length = 0;
            ptyInputQueuesRef.current.delete(sessionId);
        }
        oscBufferRef.current.delete(sessionId);
        shellIdleRef.current.delete(sessionId);
        shellHookSeenRef.current.delete(sessionId);
        ptyInputLineRef.current.delete(sessionId);
        pendingElevationReinjectRef.current.delete(sessionId);
        const timer = elevationTimerRef.current.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            elevationTimerRef.current.delete(sessionId);
        }
    };

    const pausePtyInput = (sessionId, queue, error) => {
        if (ptyInputQueuesRef.current.get(sessionId) !== queue) return;
        failedPtyWritesRef.current.add(sessionId);
        // Drop queued input rather than replaying it after Resume. An IPC
        // already submitted cannot be recalled.
        for (const item of queue.pending) {
            queue.bytes -= item.bytes;
            item.resolve(false);
        }
        queue.pending.length = 0;
        ptyInputLineRef.current.delete(sessionId);
        shellIdleRef.current.set(sessionId, false);
        pendingElevationReinjectRef.current.delete(sessionId);
        const timer = elevationTimerRef.current.get(sessionId);
        if (timer) clearTimeout(timer);
        elevationTimerRef.current.delete(sessionId);
        updateTab(queue.tabId, (tab) => tab.ptySessionId !== sessionId ? tab : ({
            ...tab,
            ptyWriteError: String(error),
        }));
    };

    const drainPtyInput = async (sessionId, queue) => {
        const isCurrent = () => ptyInputQueuesRef.current.get(sessionId) === queue &&
            ptyOwnersRef.current.get(sessionId) === queue.tabId;
        if (queue.active) return;
        while (isCurrent() && !failedPtyWritesRef.current.has(sessionId) && queue.pending.length) {
            const item = queue.pending.shift();
            queue.active = item;
            try {
                await invoke('ssh_write_pty', { sessionId, data: item.data });
                item.resolve(isCurrent());
            } catch (error) {
                pausePtyInput(sessionId, queue, error);
                item.resolve(false);
            } finally {
                queue.bytes -= item.bytes;
                queue.active = null;
            }
        }
        if (isCurrent() && !queue.pending.length && !queue.active &&
            !failedPtyWritesRef.current.has(sessionId)) ptyInputQueuesRef.current.delete(sessionId);
    };

    // All sources of PTY input share one bounded, per-session FIFO.
    const writePty = (sessionId, data, userInput = false) => {
        const tabId = ptyOwnersRef.current.get(sessionId);
        if (!tabId || failedPtyWritesRef.current.has(sessionId)) return Promise.resolve(false);
        if (!data) return Promise.resolve(true);
        let queue = ptyInputQueuesRef.current.get(sessionId);
        if (!queue) {
            queue = { tabId, pending: [], active: null, bytes: 0 };
            ptyInputQueuesRef.current.set(sessionId, queue);
        }
        const bytes = data.length > MAX_PTY_INPUT_BYTES
            ? MAX_PTY_INPUT_BYTES + 1 : new TextEncoder().encode(data).byteLength;
        if (bytes > MAX_PTY_INPUT_BYTES - queue.bytes ||
            queue.pending.length + Number(Boolean(queue.active)) >= MAX_PTY_INPUT_ITEMS) {
            pausePtyInput(sessionId, queue, 'SSH frontend input queue is full');
            return Promise.resolve(false);
        }
        if (userInput) trackPtyUserInput(sessionId, data);
        return new Promise(resolve => {
            queue.pending.push({ data, bytes, resolve });
            queue.bytes += bytes;
            drainPtyInput(sessionId, queue);
        });
    };

    const injectShellIntegration = (sessionId) => {
        if (!sessionId) return;
        return writePty(sessionId, buildShellIntegrationCommand());
    };

    const fetchHomeDirForTab = async (tabId, conn) => {
        if (!tabId || !conn?.host || sshHomeDirRef.current.has(tabId)) return;
        try {
            const res = await executeSshCommand(conn, 'printf %s "$HOME"', '.');
            const home = res?.stdout?.trim();
            if (res?.exit_code === 0 && home && home.startsWith('/') &&
                terminalTabsRef.current.some((tab) => tab.id === tabId)) {
                sshHomeDirRef.current.set(tabId, normalizeRemotePosixPath(home));
            }
        } catch {
            // Ignore $HOME probe failures
        }
    };

    const setupPtySessionHooks = (tabId, conn, sessionId) => {
        if (!sessionId) return;
        fetchHomeDirForTab(tabId, conn);
        setTimeout(() => {
            if (ptyOwnersRef.current.get(sessionId) === tabId) injectShellIntegration(sessionId);
        }, 350);
    };

    const syncExplorerToRemoteDir = async (ownerTab, targetDir, forceRetry = false) => {
        const scope = explorerScopeRef.current();
        const ownerId = ownerTab?.id;
        if (!ownerTab?.sshConnection || !ownerTab.sshFollowsExplorer ||
            ownerTab.sshExplorerTabId !== (scope ? scope.tabId : 'legacy') ||
            scope?.switching || explorerHomeRef.current || ownerId !== activeTabIdRef.current || !targetDir ||
            explorerSshTabsRef.current.get(getExplorerSshKey(ownerTab.sshExplorerTabId, ownerTab.sshConnection)) !== ownerId) return;
        const normalizedTarget = normalizeRemotePosixPath(targetDir);
        const cur = currentPathRef.current;
        if (!isSftpPathRef.current(cur)) return;
        const parsedCur = parseSftpPathRef.current(cur);
        if (!parsedCur?.connection ||
            getSshConnectionKey(parsedCur.connection) !== getSshConnectionKey(ownerTab.sshConnection)) return;

        const curRemotePath = normalizeRemotePosixPath(parsedCur.remotePath || '/');
        if (!forceRetry && normalizedTarget === curRemotePath &&
            lastFailedSyncDirRef.current.get(ownerId) !== normalizedTarget) return;

        const selectionRevision = terminalSelectionRevisionRef.current;
        const token = { scope, path: null };
        terminalNavigationRef.current.set(ownerId, token);
        const isCurrent = () => {
            const live = terminalTabsRef.current.find((tab) => tab.id === ownerId);
            return Boolean(terminalNavigationRef.current.get(ownerId) === token &&
                explorerScopeRef.current() === scope && !explorerHomeRef.current &&
                terminalSelectionRevisionRef.current === selectionRevision &&
                activeTabIdRef.current === ownerId &&
                live?.sshFollowsExplorer &&
                live.sshExplorerTabId === ownerTab.sshExplorerTabId &&
                explorerSshTabsRef.current.get(getExplorerSshKey(live.sshExplorerTabId, live.sshConnection)) === ownerId &&
                live.ptySessionId === ownerTab.ptySessionId &&
                (!ownerTab.ptySessionId || ptyOwnersRef.current.get(ownerTab.ptySessionId) === ownerId));
        };

        let committed = false;
        const loadTarget = async (path, silent = false) => {
            if (!isCurrent()) return 'stale';
            token.path = createSftpUrlRef.current(ownerTab.sshConnection, path);
            const pending = loadDirectoryRef.current(token.path, {
                ...(silent ? { silent: true, silentError: true } : {}),
                isCurrent,
            });
            const requestId = directoryRequestIdRef.current?.();
            const ok = await pending;
            // loadDirectory itself commits the path and data. A stale failure
            // must never start a parent-directory fallback for a newer owner.
            if (explorerScopeRef.current() !== scope ||
                terminalSelectionRevisionRef.current !== selectionRevision ||
                (requestId !== undefined && directoryRequestIdRef.current?.() !== requestId)) return 'stale';
            if (ok) {
                committed = true;
                return 'ok';
            }
            return isCurrent() ? 'failed' : 'stale';
        };

        try {
            const result = await loadTarget(normalizedTarget);
            if (result === 'ok') {
                lastFailedSyncDirRef.current.delete(ownerId);
            } else if (result === 'failed') {
                lastFailedSyncDirRef.current.set(ownerId, normalizedTarget);
                for (const parentDir of getParentRemoteDirs(normalizedTarget, 3)) {
                    if (parentDir === curRemotePath) break;
                    const parentResult = await loadTarget(parentDir, true);
                    if (parentResult !== 'failed') break;
                }
            }
        } catch {
            // Ignore directory sync navigation errors.
        } finally {
            if (!committed && terminalNavigationRef.current.get(ownerId) === token) {
                terminalNavigationRef.current.delete(ownerId);
            }
        }
    };
    const syncExplorerToRemoteDirRef = useRef(syncExplorerToRemoteDir);
    syncExplorerToRemoteDirRef.current = syncExplorerToRemoteDir;

    const trackPtyUserInput = (sessionId, data) => {
        if (!sessionId || !data) return;
        let line = ptyInputLineRef.current.get(sessionId) || '';
        for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
                shellIdleRef.current.set(sessionId, false);
                if (isElevationCommand(line)) {
                    pendingElevationReinjectRef.current.set(sessionId, true);
                }
                line = '';
            } else if (ch === '\x7f' || ch === '\b') {
                line = line.slice(0, -1);
            } else if (ch === '\x03' || ch === '\x15') {
                line = '';
            } else if (ch >= ' ') {
                line += ch;
            }
        }
        ptyInputLineRef.current.set(sessionId, line.slice(-256));
    };

    useEffect(() => {
        let unlistenOut = null;
        let unlistenExit = null;
        let active = true;

        (async () => {
            try {
                unlistenOut = await listen('ssh-pty-output', (event) => {
                    const payload = event?.payload;
                    if (!active || !payload?.session_id) return;

                    const sessionId = payload.session_id;
                    const owner = ptyOwnersRef.current.get(sessionId);
                    if (finalizingPtyRef.current.has(sessionId) ||
                        (!owner && pendingPtyStartsRef.current.size === 0)) return;

                    // Preserve initial VT output until the xterm controller mounts.
                    const ctrl = xtermControllersRef.current[sessionId];
                    if (ctrl) {
                        ctrl.write(payload.data);
                    } else {
                        const previous = pendingPtyOutputRef.current.get(sessionId);
                        const combined = (previous?.text || '') + payload.data;
                        const truncated = previous?.truncated || combined.length > MAX_PENDING_PTY_OUTPUT;
                        let text = combined.slice(-MAX_PENDING_PTY_OUTPUT);
                        // Do not retain half of a surrogate pair at the cut.
                        if (truncated && /^[\uDC00-\uDFFF]/.test(text)) text = text.slice(1);
                        pendingPtyOutputRef.current.set(sessionId, { text, truncated });
                    }
                    if (!owner) return;

                    // Buffer partial OSC / ESC sequences across PTY output chunks
                    const prevOscBuf = oscBufferRef.current.get(payload.session_id) || '';
                    const { completed: oscChunk, remainingBuffer } = consumeOscChunk(prevOscBuf, payload.data);
                    oscBufferRef.current.set(payload.session_id, remainingBuffer);

                    const promptState = extractOscPromptState(oscChunk);
                    if (promptState) {
                        shellHookSeenRef.current.set(payload.session_id, true);
                        shellIdleRef.current.set(payload.session_id, promptState === 'idle');
                        if (promptState === 'idle') {
                            pendingElevationReinjectRef.current.delete(payload.session_id);
                        }
                    }

                    // Re-inject shell hook after sudo -i / su reaches the elevated shell prompt
                    if (pendingElevationReinjectRef.current.get(payload.session_id)) {
                        const plainChunk = stripAnsiCodes(payload.data);
                        if (!/password|пароль|passphrase|try again/i.test(plainChunk) &&
                            /(?:^|\n)[^\r\n]*(?:#|\$|>|%)\s*$/.test(plainChunk)
                        ) {
                            const prevTimer = elevationTimerRef.current.get(payload.session_id);
                            if (prevTimer) clearTimeout(prevTimer);
                            const sidToReinject = payload.session_id;
                            elevationTimerRef.current.set(
                                sidToReinject,
                                setTimeout(() => {
                                    elevationTimerRef.current.delete(sidToReinject);
                                    if (pendingElevationReinjectRef.current.get(sidToReinject)) {
                                        pendingElevationReinjectRef.current.delete(sidToReinject);
                                        injectShellIntegration(sidToReinject);
                                    }
                                }, 180)
                            );
                        }
                    }

                    // Follow directory changes emitted by remote shell (OSC 7 / OSC 0/2)
                    const ownerTab = terminalTabsRef.current.find((t) => t.ptySessionId === payload.session_id);
                    const homeDir = ownerTab ? sshHomeDirRef.current.get(ownerTab.id) : null;
                    const detectedDir = extractOscDirectory(oscChunk, homeDir);
                    if (!detectedDir && promptState === 'idle') explorerCdRef.current.delete(sessionId);
                    if (detectedDir && detectedDir.startsWith('/') && ownerTab && ownerTab.sshConnection) {
                        const forceSync = forceSyncNextOscRef.current.has(ownerTab.id);
                        if (forceSync) {
                            forceSyncNextOscRef.current.delete(ownerTab.id);
                        }
                        if (ownerTab.sshConfirmedDir !== detectedDir || ownerTab.sshWorkingDir !== detectedDir) {
                            updateTab(ownerTab.id, { sshWorkingDir: detectedDir, sshConfirmedDir: detectedDir });
                        }
                        const explorerCd = explorerCdRef.current.get(sessionId);
                        if (explorerCd) {
                            if (detectedDir === explorerCd.target || promptState === 'idle') {
                                explorerCdRef.current.delete(sessionId);
                            }
                            return;
                        }
                        if (!ownerTab.sshFollowsExplorer || ownerTab.id !== activeTabIdRef.current) return;
                        if (ownerTab.sshWorkingDir !== detectedDir || forceSync) {
                            syncExplorerToRemoteDirRef.current(ownerTab, detectedDir, forceSync);
                        }
                    }
                });
                if (!active) {
                    if (typeof unlistenOut === 'function') unlistenOut();
                    return;
                }
                unlistenExit = await listen('ssh-pty-exit', (event) => {
                    const payload = event?.payload;
                    if (!active || !payload?.session_id) return;
                    const sessionId = payload.session_id;
                    if (finalizingPtyRef.current.has(sessionId)) return;
                    const tabId = ptyOwnersRef.current.get(sessionId);
                    if (!tabId) {
                        if (pendingPtyStartsRef.current.size > 0) {
                            earlyPtyExitRef.current.set(sessionId, payload.reason);
                        }
                        return;
                    }
                    // Revoke input/navigation immediately; retain the mounted view
                    // until xterm has parsed every write preceding the exit event.
                    finalizingPtyRef.current.set(sessionId, tabId);
                    ptyOwnersRef.current.delete(sessionId);
                    const ctrl = xtermControllersRef.current[sessionId];
                    const pending = pendingPtyOutputRef.current.get(sessionId);
                    let output = stripAnsiCodes(pending?.text || '');
                    cleanupSessionTracking(sessionId);
                    const finishExit = async () => {
                        let incomplete = false;
                        if (ctrl) {
                            updateTab(tabId, (tab) => tab.ptySessionId !== sessionId ? tab : ({
                                ...tab, ptyStatus: 'finishing', ptyWriteError: null,
                            }));
                            try {
                                output = await ctrl.flushBufferText();
                            } catch {
                                incomplete = true;
                                try {
                                    output = ctrl.getBufferText() || output;
                                } catch {
                                    // Retain the pre-controller fallback if the view is gone.
                                }
                            }
                        }
                        if (!active || finalizingPtyRef.current.get(sessionId) !== tabId) return;
                        finalizingPtyRef.current.delete(sessionId);
                        updateTab(tabId, (tab) => tab.ptySessionId !== sessionId ? tab : ({
                            ...tab,
                            ptySessionId: null,
                            ptyStatus: 'disconnected',
                            history: [
                                ...tab.history,
                                ...(pending?.truncated && !output.includes(PTY_STARTUP_TRUNCATED)
                                    ? [{ type: 'system', content: PTY_STARTUP_TRUNCATED, timestamp: new Date().toLocaleTimeString() }] : []),
                                ...(output ? [{ type: 'output', content: output, timestamp: new Date().toLocaleTimeString() }] : []),
                                ...(incomplete ? [{ type: 'error', content: '[SSH final output incomplete: terminal flush failed or timed out]', timestamp: new Date().toLocaleTimeString() }] : []),
                                { type: 'system', content: '[SSH PTY exited: ' + payload.reason + ']', timestamp: new Date().toLocaleTimeString() },
                            ],
                        }));
                    };
                    void finishExit();
                });
                if (active) setPtyListenersReady(true);
                else if (typeof unlistenExit === 'function') unlistenExit();
            } catch {
                if (typeof unlistenOut === 'function') unlistenOut();
                unlistenOut = null;
                // Non-Tauri test environments may not mock event listeners
            }
        })();

        return () => {
            active = false;
            if (typeof unlistenOut === 'function') unlistenOut();
            if (typeof unlistenExit === 'function') unlistenExit();
            unlistenOut = null;
            unlistenExit = null;
            terminalNavigationRef.current.clear();
            explorerCdRef.current.clear();
            pendingPtyStartsRef.current.clear();
            earlyPtyExitRef.current.clear();
            for (const sessionId of ptyOwnersRef.current.keys()) {
                cleanupSessionTracking(sessionId);
                invoke('ssh_close_pty', { sessionId }).catch(() => {});
            }
            ptyOwnersRef.current.clear();
            finalizingPtyRef.current.clear();
            pendingPtyOutputRef.current.clear();
        };
    }, []);

    const newSshTabId = () => 'ssh:' + (++nextSshTabIdRef.current);

    const openIndependentSshTab = (conn, remoteDir = '.') => {
        const tab = buildSshTab(newSshTabId(), conn, remoteDir, false);
        setTerminalTabs((prev) => [...prev, tab]);
        selectTerminalTab(tab.id);
    };

    const ensureAndSelectSshTab = (conn, remoteDir = '.') => {
        const key = getExplorerSshKey(explorerTabId, conn);
        let tabId = explorerSshTabsRef.current.get(key);
        if (!tabId) {
            tabId = newSshTabId();
            explorerSshTabsRef.current.set(key, tabId);
        }
        const id = tabId;
        setTerminalTabs((prev) => {
            if (prev.some((t) => t.id === id)) {
                return prev.map((t) =>
                    t.id === id
                        ? {
                            ...t,
                            sshConnection: conn,
                            sshWorkingDir: t.ptySessionId || t.ptyStatus === 'connecting'
                                ? t.sshWorkingDir : (remoteDir || t.sshWorkingDir),
                        }
                        : t
                );
            }
            const numbered = prev.some((tab) => tab.sshConnection &&
                getSshConnectionKey(tab.sshConnection) === getSshConnectionKey(conn));
            return [...prev, buildSshTab(id, conn, remoteDir, true, explorerTabId, numbered)];
        });
        selectTerminalTab(id);
    };

    useEffect(() => {
        const handleOpenSsh = (e) => {
            const conn = e?.detail?.connection;
            if (!conn?.host) return;
            openIndependentSshTab(conn, '.');
        };
        window.addEventListener('open-ssh-terminal', handleOpenSsh);
        return () => window.removeEventListener('open-ssh-terminal', handleOpenSsh);
    }, []);

    // A binding belongs to a logical tab, not to the underlying shell.
    // Revoke pending navigation synchronously before changing ownership.
    const revokeBinding = (tab) => {
        if (tab.sshFollowsExplorer) {
            const key = getExplorerSshKey(tab.sshExplorerTabId, tab.sshConnection);
            if (explorerSshTabsRef.current.get(key) === tab.id) explorerSshTabsRef.current.delete(key);
        }
        terminalNavigationRef.current.delete(tab.id);
        lastFailedSyncDirRef.current.delete(tab.id);
        forceSyncNextOscRef.current.delete(tab.id);
        // Keep a pending injected cd until its OSC/prompt arrives; it must
        // not become a user-originated navigation after reattachment.
        terminalSelectionRevisionRef.current += 1;
    };

    const independentBinding = (tab) => ({
        ...tab,
        sshExplorerTabId: null,
        sshFollowsExplorer: false,
        label: 'SSH: ' + (tab.sshConnection.name || tab.sshConnection.host) + ' #' + tab.id.slice(4),
        ptyStatus: tab.ptyStatus === 'idle' ? 'stopped' : tab.ptyStatus,
        ptyDisabledManually: tab.ptyStatus === 'idle' || tab.ptyDisabledManually,
    });

    const canAttachToExplorer = (tab) => Boolean(tab?.sshConnection && explorerTabs &&
        explorerTabId && !explorerScope?.switching && !explorerHome && parsedSftp?.connection &&
        getSshConnectionKey(tab.sshConnection) === getSshConnectionKey(parsedSftp.connection));

    const changeBinding = (tab, attach) => {
        const scope = explorerScopeRef.current();
        if (!tab?.sshConnection || activeTabIdRef.current !== tab.id) return;
        if (attach && (!canAttachToExplorer(tab) || scope !== explorerScope)) return;
        const key = attach ? getExplorerSshKey(scope.tabId, tab.sshConnection) : null;
        const previousId = attach ? explorerSshTabsRef.current.get(key) : null;
        const previous = terminalTabsRef.current.find((item) => item.id === previousId && item.id !== tab.id);
        revokeBinding(tab);
        if (previous) revokeBinding(previous);
        if (attach) explorerSshTabsRef.current.set(key, tab.id);
        // No PTY starts/stops, input injection, or directory changes here.
        setTerminalTabs((prev) => prev.map((item) => {
            if (previous && item.id === previous.id) return independentBinding(item);
            if (item.id !== tab.id) return item;
            return attach ? { ...item, sshFollowsExplorer: true, sshExplorerTabId: scope.tabId }
                : independentBinding(item);
        }));
    };

    // Closing an Explorer tab unlinks its terminals; it does not close a PTY.
    useEffect(() => {
        if (!explorerTabs) return;
        const liveIds = new Set(explorerTabs.tabs.map((tab) => tab.id));
        const detached = terminalTabsRef.current.filter((tab) => tab.sshFollowsExplorer &&
            !liveIds.has(tab.sshExplorerTabId));
        if (detached.length === 0) return;
        for (const tab of detached) revokeBinding(tab);
        const ids = new Set(detached.map((tab) => tab.id));
        setTerminalTabs((prev) => prev.map((tab) => ids.has(tab.id) ? independentBinding(tab) : tab));
    }, [explorerTabs?.tabs]);

    // Same path is not the same Explorer tab. Wait for the selected tab's
    // directory load to settle before creating or selecting its linked shell.
    useEffect(() => {
        if (!explorerTabId || explorerScope?.switching) return;
        const liveScope = explorerScopeRef.current();
        if (explorerScope && liveScope !== explorerScope) return;
        const revision = explorerScope?.revision ?? 0;
        const changedExplorer = lastExplorerRevisionRef.current !== revision;
        lastExplorerRevisionRef.current = revision;
        const selected = terminalTabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
        if (!changedExplorer && selected?.sshConnection && !selected.sshFollowsExplorer) return;
        if (parsedSftp?.connection && !explorerHome) {
            const tabId = explorerSshTabsRef.current.get(getExplorerSshKey(explorerTabId, parsedSftp.connection));
            const existingTab = terminalTabsRef.current.find((t) => t.id === tabId);
            const origin = terminalNavigationRef.current.get(tabId);
            if (origin && origin.scope === liveScope && origin.path === currentPath) {
                terminalNavigationRef.current.delete(tabId);
                return;
            }
            ensureAndSelectSshTab(parsedSftp.connection, parsedSftp.remotePath || '.');

            const rawTarget = parsedSftp.remotePath;
            const sid = existingTab?.ptySessionId;
            if (
                settings?.terminal_sync_explorer_to_terminal === true &&
                sid && ptyOwnersRef.current.get(sid) === existingTab.id &&
                rawTarget && rawTarget !== '.' &&
                shellHookSeenRef.current.get(sid) === true &&
                shellIdleRef.current.get(sid) === true &&
                !ptyInputLineRef.current.get(sid) && !explorerCdRef.current.has(sid) &&
                !ptyInputQueuesRef.current.get(sid)?.active && !ptyInputQueuesRef.current.get(sid)?.pending.length
            ) {
                const normalizedTarget = normalizeRemotePosixPath(rawTarget);
                const currentPtyDir = existingTab.sshWorkingDir && existingTab.sshWorkingDir !== '.'
                    ? normalizeRemotePosixPath(existingTab.sshWorkingDir)
                    : null;
                if (normalizedTarget !== currentPtyDir) {
                    const pending = { target: normalizedTarget };
                    explorerCdRef.current.set(sid, pending);
                    shellIdleRef.current.set(sid, false);
                    const cmd = ' cd -- ' + escapePosixSingleQuote(normalizedTarget) + '\n';
                    writePty(sid, cmd).then((accepted) => {
                        if (!accepted && explorerCdRef.current.get(sid) === pending) {
                            explorerCdRef.current.delete(sid);
                        }
                    });
                }
            }
        } else if (activeTabIdRef.current.startsWith('ssh:')) {
            selectTerminalTab(terminalTabsRef.current.find((tab) => !tab.sshConnection)?.id || 'local');
        }
    }, [currentPath, explorerTabId, explorerHome, explorerScope?.revision, explorerScope?.switching, parsedSftp?.connection?.name, parsedSftp?.connection?.host, parsedSftp?.connection?.username, parsedSftp?.connection?.port, parsedSftp?.remotePath, settings?.terminal_sync_explorer_to_terminal]);

    const startTabPty = async (tab) => {
        if (!ptyListenersReady || !tab?.sshConnection || tab.ptySessionId ||
            pendingPtyStartsRef.current.has(tab.id) ||
            [...ptyOwnersRef.current.values()].includes(tab.id)) return;

        const tabId = tab.id;
        const attempt = Symbol(tabId);
        pendingPtyStartsRef.current.set(tabId, attempt);
        updateTab(tabId, { ptyStatus: 'connecting', ptyDisabledManually: false, ptyWriteError: null, sshConfirmedDir: null });
        try {
            const sid = await startSshPty(tab.sshConnection, tab.sshWorkingDir || '.', 100, 30);
            if (pendingPtyStartsRef.current.get(tabId) !== attempt) {
                if (sid) await invoke('ssh_close_pty', { sessionId: sid }).catch(() => {});
                return;
            }
            if (!sid) throw new Error('SSH PTY did not return a session ID');
            if (earlyPtyExitRef.current.has(sid)) {
                const reason = earlyPtyExitRef.current.get(sid);
                const pending = pendingPtyOutputRef.current.get(sid);
                const output = stripAnsiCodes(pending?.text || '');
                earlyPtyExitRef.current.delete(sid);
                cleanupSessionTracking(sid);
                updateTab(tabId, (current) => ({
                    ...current,
                    ptyStatus: 'disconnected',
                    history: [...current.history,
                        ...(pending?.truncated ? [{ type: 'system', content: PTY_STARTUP_TRUNCATED, timestamp: new Date().toLocaleTimeString() }] : []),
                        ...(output ? [{ type: 'output', content: output, timestamp: new Date().toLocaleTimeString() }] : []),
                        { type: 'system', content: '[SSH PTY exited: ' + reason + ']', timestamp: new Date().toLocaleTimeString() },
                    ],
                }));
                return;
            }
            ptyOwnersRef.current.set(sid, tabId);
            updateTab(tabId, { ptySessionId: sid, ptyStatus: 'connected' });
            setupPtySessionHooks(tabId, tab.sshConnection, sid);
        } catch (e) {
            if (pendingPtyStartsRef.current.get(tabId) !== attempt) return;
            updateTab(tabId, (current) => ({
                ...current,
                ptyStatus: 'error',
                history: [...current.history, {
                    type: 'error', content: 'Failed to start SSH PTY: ' + e, timestamp: new Date().toLocaleTimeString(),
                }],
            }));
        } finally {
            if (pendingPtyStartsRef.current.get(tabId) === attempt) {
                pendingPtyStartsRef.current.delete(tabId);
            }
            if (pendingPtyStartsRef.current.size === 0) {
                earlyPtyExitRef.current.clear();
                for (const sid of pendingPtyOutputRef.current.keys()) {
                    if (!ptyOwnersRef.current.has(sid)) pendingPtyOutputRef.current.delete(sid);
                }
            }
        }
    };

    const closeTabPty = (tabId) => {
        terminalNavigationRef.current.delete(tabId);
        pendingPtyStartsRef.current.delete(tabId);
        for (const [sessionId, owner] of finalizingPtyRef.current) {
            if (owner === tabId) finalizingPtyRef.current.delete(sessionId);
        }
        for (const [sessionId, owner] of ptyOwnersRef.current) {
            if (owner !== tabId) continue;
            ptyOwnersRef.current.delete(sessionId);
            cleanupSessionTracking(sessionId);
            invoke('ssh_close_pty', { sessionId }).catch(() => {});
        }
    };

    // Initial connection only. Explicit SSH tabs start independently even if
    // selection changes before their connection completes.
    useEffect(() => {
        if (!isOpen || !ptyListenersReady) return;
        for (const tab of terminalTabs) {
            if (!tab.sshConnection || tab.ptySessionId || tab.ptyDisabledManually ||
                tab.ptyStatus !== 'idle') continue;
            if (!tab.sshFollowsExplorer || (tab.id === activeTab?.id &&
                tab.sshExplorerTabId === explorerTabId && !explorerHome && !explorerScope?.switching)) startTabPty(tab);
        }
    }, [isOpen, ptyListenersReady, terminalTabs, activeTab?.id, explorerTabId, explorerHome, explorerScope?.switching]);

    /**
     * Get terminal height from settings with fallback to default value
     * @type {number}
     */
    const terminalHeight = settings.terminal_height || 240;

    /**
     * Load persistent command history from localStorage on component mount
     */
    useEffect(() => {
        try {
            const savedHistory = localStorage.getItem('terminal-command-history');
            if (savedHistory) {
                const parsed = JSON.parse(savedHistory);
                setPersistentHistory(parsed.slice(-50)); // Keep last 50 commands
            }
        } catch (error) {
            console.error('Failed to load command history:', error);
        }
    }, []);

    /**
     * Save command history to localStorage whenever it changes
     */
    useEffect(() => {
        try {
            if (persistentHistory.length > 0) {
                localStorage.setItem('terminal-command-history', JSON.stringify(persistentHistory));
            }
        } catch (error) {
            console.error('Failed to save command history:', error);
        }
    }, [persistentHistory]);

    // Removed the useEffect that automatically adds directory change messages
    // to prevent double messages when using the cd command

    /**
     * Focus input field when terminal opens
     */
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    /**
     * Automatically scroll to the bottom when command history updates
     */
    useEffect(() => {
        if (terminalRef.current) {
            // Ensure proper scrolling without pushing content off screen
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
        }
    }, [commandHistory]);


    /**
     * Cleanup running commands when component unmounts
     */
    useEffect(() => {
        return () => {
            if (abortController) {
                abortController.abort();
            }
        };
    }, [abortController]);

    /**
     * Generates the terminal prompt string with username, hostname and current path
     * @returns {string} Formatted prompt string
     */
    const getPrompt = () => {
        if (activeSshConnection) {
            const username = activeSshConnection.username || 'user';
            const hostname = activeSshConnection.host;
            const pathDisplay = sshWorkingDir || '.';
            const displayPath = pathDisplay.length > 50
                ? '...' + pathDisplay.slice(-47)
                : pathDisplay;
            return `${username}@${hostname}:${displayPath}$`;
        }
        const username = 'user';
        const hostname = 'localhost';
        const pathDisplay = currentPath || '/';
        // Truncate long paths for better display
        const displayPath = pathDisplay.length > 50 
            ? '...' + pathDisplay.slice(-47)
            : pathDisplay;
        return `${username}@${hostname}:${displayPath}$`;
    };

    /**
     * Executes a command using the Tauri backend
     * Handles response parsing and error formatting
     * Supports command cancellation via AbortController
     *
     * @param {string} command - The command to execute
     * @returns {Object} Result object with type and content
     * @async
     */
    const executeCommand = async (command) => {
        const controller = new AbortController();
        setAbortController(controller);
        setIsExecuting(true);

        try {
            if (ptySessionId) {
                const accepted = await writePty(ptySessionId, `${command}\n`);
                return accepted ? null : { type: 'error', content: 'SSH PTY input was not accepted' };
            }
            if (activeSshConnection) {
                const trimmedCmd = command.trim();
                if (trimmedCmd === 'cd' || trimmedCmd.startsWith('cd ')) {
                    const targetDir = trimmedCmd === 'cd' ? '~' : trimmedCmd.slice(3).trim();
                    const quoted = `'${targetDir.replace(/'/g, `'\\''`)}'`;
                    const cdCmd = targetDir === '~' ? 'cd ~ && pwd' : `cd ${quoted} && pwd`;
                    const commandScope = explorerScopeRef.current();
                    const commandSelection = terminalSelectionRevisionRef.current;
                    const commandRequest = directoryRequestIdRef.current?.();
                    const res = await executeSshCommand(activeSshConnection, cdCmd, sshWorkingDir);
                    if (res.exit_code === 0 && res.stdout?.trim()) {
                        const newRemoteDir = res.stdout.trim().split('\n').pop().trim();
                        updateTab(activeTab.id, { sshWorkingDir: newRemoteDir, sshConfirmedDir: newRemoteDir });
                        if (explorerScopeRef.current() === commandScope &&
                            terminalSelectionRevisionRef.current === commandSelection &&
                            directoryRequestIdRef.current?.() === commandRequest) {
                            await syncExplorerToRemoteDir(activeTab, newRemoteDir);
                        }
                        return { type: 'system', content: `[SSH] Directory: ${newRemoteDir}` };
                    }
                    return { type: 'error', content: res.stderr?.trim() || 'cd failed' };
                }

                const res = await executeSshCommand(activeSshConnection, command, sshWorkingDir);
                const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
                return {
                    type: res.exit_code === 0 ? 'output' : 'error',
                    content: combined || (res.exit_code === 0 ? '' : `Exit code ${res.exit_code}`),
                    originalCommand: command,
                };
            }

            // Determine if this is a potentially long-running command
            const longRunningCommands = ['ping', 'traceroute', 'curl', 'wget', 'tail -f', 'watch'];
            const isLongRunning = longRunningCommands.some(cmd => command.toLowerCase().startsWith(cmd));
            
            // Use appropriate command execution method
            const workingDir = isLocalDirectory(currentPath) ? currentPath : null;
            const commandPromise = isLongRunning 
                ? invoke('execute_command_with_timeout', { 
                    command, 
                    workingDirectory: workingDir,
                    timeoutSeconds: 30
                })
                : invoke('execute_command_improved', { 
                    command, 
                    workingDirectory: workingDir 
                });
            const cancelPromise = new Promise((_, reject) => {
                controller.signal.addEventListener('abort', () => {
                    reject(new Error('Command cancelled'));
                });
            });

            const output = await Promise.race([commandPromise, cancelPromise]);
            return formatCommandResponse(output, command);
        } catch (error) {
            // Handle command cancellation
            if (error.message === 'Command cancelled') {
                return {
                    type: 'system',
                    content: 'Command cancelled by user',
                };
            }

            // Format error messages properly
            let errorMessage = '';

            try {
                if (typeof error === 'string') {
                    try {
                        // Try to parse JSON error
                        const parsedError = JSON.parse(error);
                        errorMessage = parsedError.custom_message ||
                            parsedError.message_from_code ||
                            parsedError.message ||
                            error;
                    } catch {
                        errorMessage = error;
                    }
                } else if (typeof error === 'object') {
                    errorMessage = error.custom_message ||
                        error.message_from_code ||
                        error.message ||
                        JSON.stringify(error);
                } else {
                    errorMessage = String(error);
                }
            } catch {
                errorMessage = String(error);
            }

            return {
                type: 'error',
                content: `Error: ${errorMessage}`,
            };
        } finally {
            setIsExecuting(false);
            setAbortController(null);
        }
    };

    /**
     * Handles built-in terminal commands
     * Provides functionality for commands like help, clear, ls, etc.
     *
     * @param {string} command - The command to handle
     * @param {Array<string>} args - Command arguments
     * @returns {Object|null} Command result object or null if not a built-in command
     * @async
     */
    const handleBuiltinCommand = async (command, args) => {
        switch (command) {
            case 'help':
                return {
                    type: 'output',
                    content: `Available commands:
  help                    - Show this help message
  clear [history]         - Clear the terminal (or history with 'clear history')
  history                 - Show recent commands
  ls, dir                 - List directory contents
  pwd                     - Print working directory
  cd [path]               - Change directory (supports .., ~, relative/absolute paths)
  echo <text>             - Print text
  mkdir <name>            - Create directory
  touch <name>            - Create file
  cat <file>              - Display file contents
  tree                    - Show enhanced directory tree with icons
  find <pattern>          - Search for files and directories by name
  which <command>         - Show command type and location
  whoami                  - Show current user
  date                    - Show current date and time
  ping <host>             - Test network connectivity (auto-limited to 4 packets)
  exit                    - Close the terminal
  
  Enhanced features:
  • Persistent command history across sessions (up to 50 commands)
  • Smart tab completion for commands and file paths
  • Real-time directory synchronization with file explorer
  • Syntax highlighting for file listings and paths
  • File type icons and visual formatting
  
  Keyboard shortcuts:
  Ctrl+C                  - Interrupt running command or clear input
  Ctrl+R                  - Reverse search through command history
  ↑/↓                     - Navigate persistent command history
  Tab                     - Smart auto-complete (commands/paths)
  Esc                     - Exit search mode
  
  Note: All system commands run in the current directory.`,
                };

            case 'clear':
                if (args.length > 0 && args[0] === 'history') {
                    // Clear persistent command history
                    setPersistentHistory([]);
                    localStorage.removeItem('terminal-command-history');
                    return {
                        type: 'system',
                        content: 'Command history cleared.',
                    };
                } else {
                    // Clear terminal display
                    setCommandHistory([]);
                    return null;
                }

            case 'history':
                if (persistentHistory.length === 0) {
                    return {
                        type: 'output',
                        content: 'No command history available.',
                    };
                }

                const recentCommands = persistentHistory.slice(-20).map((cmd, index) => {
                    const lineNumber = persistentHistory.length - 20 + index + 1;
                    return `${lineNumber.toString().padStart(3, ' ')}  ${cmd}`;
                }).join('\n');

                return {
                    type: 'output',
                    content: `Recent commands:\n${recentCommands}\n\nTip: Use 'clear history' to clear command history.`,
                };


            case 'cd': {
                console.log('[Terminal cd] Starting cd command with args:', args);
                const getHomeDir = async () => {
                    const homeResult = await invoke('execute_command_improved', {
                        command: 'echo $HOME',
                        workingDirectory: null
                    });
                    const parsed = typeof homeResult === 'string' ? JSON.parse(homeResult) : homeResult;
                    return parsed?.stdout?.trim() || '';
                };

                try {
                    if (args.length === 0) {
                        // No argument provided - go to home directory
                        try {
                            const homeDir = await getHomeDir();
                            if (homeDir) {
                                await invoke('open_directory', { path: homeDir });
                                await navigateTo(homeDir);
                                console.log('[Terminal cd] Successfully navigated to home');
                                return { type: 'output', content: '' }; // Silent success - empty content
                            }
                        } catch (error) {
                            // Fallback to current path
                            console.log('[Terminal cd] Home navigation failed, showing current path');
                            return {
                                type: 'output',
                                content: currentPath || '/',
                            };
                        }
                    }

                    const targetPath = args[0];
                    let finalPath;
                    
                    console.log('[Terminal cd] Input:', targetPath, 'Current path:', currentPath);
                    
                    // Handle ~ and ~/subdir
                    if (targetPath === '~') {
                        finalPath = await getHomeDir();
                    } else if (targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
                        const homeDir = await getHomeDir();
                        if (!homeDir) {
                            throw new Error('Could not resolve home directory');
                        }
                        finalPath = resolveTerminalCdPath(targetPath.slice(2), homeDir);
                    } else {
                        const isAbsoluteTarget = /^[A-Za-z]:/.test(targetPath) || targetPath.startsWith('/') || /^\\\\/.test(targetPath);
                        if (!isAbsoluteTarget && !isLocalDirectory(currentPath)) {
                            return {
                                type: 'error',
                                content: currentPath === null
                                    ? 'cd: No active directory selected (This PC view). Specify an absolute path.'
                                    : 'cd: Relative navigation is not supported on SFTP virtual paths.',
                            };
                        }
                        finalPath = resolveTerminalCdPath(targetPath, currentPath);
                    }

                    if (!finalPath) {
                        throw new Error('Could not resolve target directory');
                    }

                    console.log('[Terminal cd] Resolved to:', finalPath);

                    // Validate directory exists and is accessible before updating navigation history
                    await invoke('open_directory', { path: finalPath });
                    await navigateTo(finalPath);
                    console.log('[Terminal cd] Navigation succeeded');
                    return { type: 'output', content: '' }; // Silent success - empty content

                } catch (error) {
                    console.error('[Terminal cd] Error in cd command:', error);
                    return {
                        type: 'error',
                        content: `cd: ${args[0] || ''}: No such file or directory`,
                    };
                }
            }

            case 'pwd':
                return {
                    type: 'output',
                    content: currentPath || '/',
                };

            case 'whoami':
                return {
                    type: 'output',
                    content: 'user',
                };

            case 'date':
                return {
                    type: 'output',
                    content: new Date().toString(),
                };

            case 'ls':
            case 'dir':
                if (!isLocalDirectory(currentPath)) {
                    return {
                        type: 'error',
                        content: currentPath === null
                            ? 'Cannot list directory: No active directory selected (This PC view).'
                            : 'Cannot list directory: Built-in ls is not supported on SFTP virtual paths.',
                    };
                }
                try {
                    const dirContent = await invoke('open_directory', { path: currentPath });
                    const data = JSON.parse(dirContent);
                    
                    if (data.directories.length === 0 && data.files.length === 0) {
                        return {
                            type: 'output',
                            content: 'Directory is empty',
                        };
                    }
                    
                    // Format directories and files separately for better display
                    const directories = data.directories.map(dir => `${dir.name}/`);
                    const files = data.files.map(file => file.name);
                    
                    // Create formatted output with proper spacing
                    const allItems = [...directories, ...files];
                    const content = allItems.join('  ');
                    
                    return {
                        type: 'output',
                        content: content,
                    };
                } catch (error) {
                    return {
                        type: 'error',
                        content: `Cannot list directory: ${error.message || error}`,
                    };
                }

            case 'tree':
                if (!isLocalDirectory(currentPath)) {
                    return {
                        type: 'error',
                        content: currentPath === null
                            ? 'Cannot generate tree: No active directory selected (This PC view).'
                            : 'Cannot generate tree: Built-in tree is not supported on SFTP virtual paths.',
                    };
                }
                try {
                    const dirContent = await invoke('open_directory', { path: currentPath });
                    const data = JSON.parse(dirContent);
                    
                    const pathParts = currentPath.split('/').filter(part => part);
                    const folderName = pathParts[pathParts.length - 1] || 'root';
                    
                    let tree = `📁 ${folderName}/\n`;
                    
                    const totalItems = data.directories.length + data.files.length;
                    if (totalItems === 0) {
                        tree += '   (empty directory)\n';
                        return {
                            type: 'output',
                            content: tree,
                        };
                    }

                    // Sort directories first, then files
                    const sortedDirectories = data.directories.sort((a, b) => a.name.localeCompare(b.name));
                    const sortedFiles = data.files.sort((a, b) => a.name.localeCompare(b.name));

                    sortedDirectories.forEach((dir, index) => {
                        const isLastDir = index === sortedDirectories.length - 1 && sortedFiles.length === 0;
                        const connector = isLastDir ? '└── ' : '├── ';
                        tree += `${connector}📁 ${dir.name}/\n`;
                    });

                    sortedFiles.forEach((file, index) => {
                        const isLast = index === sortedFiles.length - 1;
                        const connector = isLast ? '└── ' : '├── ';
                        
                        // Get file extension for icon
                        const ext = file.name.split('.').pop()?.toLowerCase() || '';
                        let icon = '📄';
                        
                        if (['js', 'jsx'].includes(ext)) icon = '🟨';
                        else if (['ts', 'tsx'].includes(ext)) icon = '🔷';
                        else if (ext === 'py') icon = '🐍';
                        else if (ext === 'java') icon = '☕';
                        else if (ext === 'rs') icon = '🦀';
                        else if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext)) icon = '🖼️';
                        else if (ext === 'pdf') icon = '📕';
                        else if (['zip', 'tar', 'gz'].includes(ext)) icon = '📦';
                        else if (ext === 'md') icon = '📝';
                        
                        tree += `${connector}${icon} ${file.name}\n`;
                    });

                    tree += `\n📊 ${sortedDirectories.length} directories, ${sortedFiles.length} files`;

                    return {
                        type: 'output',
                        content: tree,
                    };
                } catch (error) {
                    return {
                        type: 'error',
                        content: `Cannot generate tree: ${error.message || error}`,
                    };
                }

            case 'echo':
                return {
                    type: 'output',
                    content: args.join(' '),
                };

            case 'mkdir':
                if (args.length === 0) {
                    return {
                        type: 'error',
                        content: 'mkdir: missing operand',
                    };
                }
                if (!isLocalDirectory(currentPath)) {
                    return {
                        type: 'error',
                        content: currentPath === null
                            ? 'mkdir: No active directory selected (This PC view).'
                            : 'mkdir: Not supported on SFTP virtual paths.',
                    };
                }
                try {
                    await invoke('create_directory', {
                        folderPathAbs: currentPath,
                        folderName: args[0]
                    });
                    return {
                        type: 'output',
                        content: `Directory '${args[0]}' created successfully.`,
                    };
                } catch (error) {
                    return {
                        type: 'error',
                        content: `mkdir: ${error.message || error}`,
                    };
                }

            case 'touch':
                if (args.length === 0) {
                    return {
                        type: 'error',
                        content: 'touch: missing operand',
                    };
                }
                if (!isLocalDirectory(currentPath)) {
                    return {
                        type: 'error',
                        content: currentPath === null
                            ? 'touch: No active directory selected (This PC view).'
                            : 'touch: Not supported on SFTP virtual paths.',
                    };
                }
                try {
                    await invoke('create_file', {
                        folderPathAbs: currentPath,
                        fileName: args[0]
                    });
                    return {
                        type: 'output',
                        content: `File '${args[0]}' created successfully.`,
                    };
                } catch (error) {
                    return {
                        type: 'error',
                        content: `touch: ${error.message || error}`,
                    };
                }

            case 'cat':
                if (args.length === 0) {
                    return {
                        type: 'error',
                        content: 'cat: missing operand',
                    };
                }
                try {
                    const isAbsFile = /^[A-Za-z]:/.test(args[0]) || args[0].startsWith('/');
                    if (!isAbsFile && !isLocalDirectory(currentPath)) {
                        return {
                            type: 'error',
                            content: currentPath === null
                                ? 'cat: No active directory selected (This PC view).'
                                : 'cat: Not supported on SFTP virtual paths.',
                        };
                    }
                    const filePath = isAbsFile
                        ? args[0]
                        : joinPath(currentPath, args[0]);
                    const content = await invoke('open_file', { path: filePath });
                    return {
                        type: 'output',
                        content: content,
                    };
                } catch (error) {
                    return {
                        type: 'error',
                        content: `cat: ${error.message || error}`,
                    };
                }

            case 'find':
                if (args.length === 0) {
                    return {
                        type: 'error',
                        content: 'find: missing search pattern\nUsage: find <pattern>',
                    };
                }
                if (!isLocalDirectory(currentPath)) {
                    return {
                        type: 'error',
                        content: currentPath === null
                            ? 'find: No active directory selected (This PC view).'
                            : 'find: Not supported on SFTP virtual paths.',
                    };
                }
                
                try {
                    const pattern = args[0].toLowerCase();
                    const dirContent = await invoke('open_directory', { path: currentPath });
                    const data = JSON.parse(dirContent);
                    
                    const matches = [
                        ...data.directories.filter(dir => 
                            dir.name.toLowerCase().includes(pattern)
                        ).map(dir => `📁 ${dir.name}/`),
                        ...data.files.filter(file => 
                            file.name.toLowerCase().includes(pattern)
                        ).map(file => {
                            const ext = file.name.split('.').pop()?.toLowerCase() || '';
                            let icon = '📄';
                            if (['js', 'jsx'].includes(ext)) icon = '🟨';
                            else if (['ts', 'tsx'].includes(ext)) icon = '🔷';
                            else if (ext === 'py') icon = '🐍';
                            else if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext)) icon = '🖼️';
                            return `${icon} ${file.name}`;
                        })
                    ];
                    
                    if (matches.length === 0) {
                        return {
                            type: 'output',
                            content: `No files or directories found matching '${args[0]}'`,
                        };
                    }
                    
                    return {
                        type: 'output',
                        content: `Found ${matches.length} matches for '${args[0]}':\n\n${matches.join('\n')}`,
                    };
                } catch (error) {
                    return {
                        type: 'error',
                        content: `find: ${error.message || error}`,
                    };
                }

            case 'which': {
                if (args.length === 0) {
                    return {
                        type: 'error',
                        content: 'which: missing command name',
                    };
                }
                
                const builtinCommands = ['help', 'clear', 'history', 'ls', 'dir', 'pwd', 'cd', 'mkdir', 'touch', 'cat', 'tree', 'echo', 'whoami', 'date', 'find', 'which', 'ping', 'exit'];
                const rawCommand = args[0];
                const searchCommand = rawCommand.toLowerCase();
                
                if (builtinCommands.includes(searchCommand)) {
                    return {
                        type: 'output',
                        content: `${searchCommand}: built-in terminal command`,
                    };
                }

                if (!/^[a-zA-Z0-9._-]+$/.test(rawCommand)) {
                    return {
                        type: 'error',
                        content: `which: invalid command name '${rawCommand}'`,
                    };
                }

                try {
                    const isWindows = navigator.userAgent?.toLowerCase().includes('win') || /^[A-Za-z]:/.test(currentPath || '');
                    const lookupCmd = isWindows
                        ? `Get-Command ${rawCommand} -ErrorAction Stop | Select-Object -ExpandProperty Source`
                        : `command -v ${rawCommand}`;
                    const testResult = await invoke('execute_command_improved', { 
                        command: lookupCmd, 
                        workingDirectory: isLocalDirectory(currentPath) ? currentPath : null 
                    });
                    const parsed = typeof testResult === 'string' ? JSON.parse(testResult) : testResult;
                    if (parsed && parsed.status === 0) {
                        const resolvedPath = (parsed.stdout || '').trim();
                        return {
                            type: 'output',
                            content: resolvedPath ? `${rawCommand}: ${resolvedPath}` : `${rawCommand}: system command (use system PATH)`,
                        };
                    }
                    return {
                        type: 'output',
                        content: `${rawCommand}: command not found`,
                    };
                } catch {
                    return {
                        type: 'output',
                        content: `${rawCommand}: command not found`,
                    };
                }
            }

            case 'exit':
                onToggle();
                return {
                    type: 'system',
                    content: 'Terminal closed.',
                };

            default:
                return null; // Not a built-in command
        }
    };

    /**
     * Handles form submission for the terminal input
     * Processes the command and displays the result
     *
     * @param {React.FormEvent} e - Form submit event
     * @async
     */
    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!currentCommand.trim() || isExecuting) return;

        const command = currentCommand.trim();
        const [cmd = '', ...args] = parseCommandArgs(command);

        const commandTabId = activeTab.id;
        // Add command to history
        const commandEntry = {
            type: 'command',
            prompt: getPrompt(),
            content: command,
            timestamp: new Date().toLocaleTimeString(),
        };

        setCommandHistory(prev => [...prev, commandEntry], commandTabId);

        // Save command to persistent history (avoid duplicates)
        setPersistentHistory(prev => {
            const filtered = prev.filter(cmd => cmd !== command);
            return [...filtered, command].slice(-50); // Keep last 50 commands
        });

        // Process command
        let response = null;
        const lowerCmd = cmd.toLowerCase();

        // When SSH/PTY is active, only local UI commands (clear/exit/help) are handled as built-ins;
        // ls, cd, pwd, cat, etc. must execute on the remote SSH server.
        const isRemoteMode = Boolean(activeSshConnection || ptySessionIdRef.current);
        if (!isRemoteMode || ['clear', 'exit', 'help'].includes(lowerCmd)) {
            response = await handleBuiltinCommand(lowerCmd, args);
        }

        // If not a built-in command, execute as system / SSH command
        if (response === null && lowerCmd !== 'clear') {
            response = await executeCommand(command);
        }

        // Add response to history if there's content or it's a system message
        if (response && (response.content.trim() || response.type === 'system')) {
            setCommandHistory(prev => [...prev, {
                ...response,
                originalCommand: response.type === 'output' ? command : undefined,
                timestamp: new Date().toLocaleTimeString(),
            }], commandTabId);
        }

        // Reset command input
        setCurrentCommand('');
        setHistoryIndex(-1);
    };

    /**
     * Handles input changes for the terminal command
     * @param {React.ChangeEvent<HTMLInputElement>} e - Input change event
     */
    const handleChange = (e) => {
        const value = e.target.value;
        
        if (isSearchMode) {
            setSearchQuery(value);
            handleHistorySearch(value);
        } else {
            setCurrentCommand(value);
        }
    };

    /**
     * Formats terminal output with basic syntax highlighting and structure
     * @param {string} content - Raw output content
     * @param {string} command - The original command that generated the output
     * @returns {string} Formatted content with HTML-like structure
     */
    const formatOutput = (content, command = '') => {
        if (!content || typeof content !== 'string') return escapeHtml(content);

        // Format ls/dir output to highlight directories and files differently
        if (command.startsWith('ls') || command.startsWith('dir')) {
            return content.split(/\s+/).map(item => {
                const safeItem = escapeHtml(item);
                if (item.endsWith('/')) {
                    return `<span class="terminal-directory">${safeItem}</span>`;
                } else if (item.includes('.')) {
                    const ext = item.split('.').pop().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                    return `<span class="terminal-file terminal-file-${ext}">${safeItem}</span>`;
                } else {
                    return `<span class="terminal-file">${safeItem}</span>`;
                }
            }).join('  ');
        }

        const escaped = escapeHtml(content);

        // For simple outputs like version numbers and paths, don't apply complex formatting
        const trimmed = content.trim();
        const isSimpleOutput = trimmed.match(/^[\d.]+$/) || 
                              trimmed.match(/^v?[\d.]+(-[\w.]+)?$/) ||
                              trimmed.match(/^\/[\w\-./]+$/) || // Unix absolute paths
                              trimmed.match(/^[A-Za-z]:[\\\w\-.\\]+$/); // Windows paths
        
        if (isSimpleOutput) {
            return escaped;
        }

        // Apply URL, path, and quoted-string highlighting in a single pass so added <span> tags are never matched
        return escaped.replace(
            /(https?:\/\/[^\s<]+)|(&quot;[^&\n]*?&quot;)|(\b[\/\\][\w\-./\\]{3,}\b)/g,
            (match, url, quoted, pathMatch) => {
                if (url) return `<span class="terminal-url">${url}</span>`;
                if (quoted) return `<span class="terminal-string">${quoted}</span>`;
                if (pathMatch) return `<span class="terminal-path">${pathMatch}</span>`;
                return match;
            }
        );
    };

    /**
     * Handles tab completion for commands and file paths
     * Provides intelligent completion based on context
     * @async
     */
    const handleTabCompletion = async () => {
        if (!currentCommand.trim()) return;

        const parts = currentCommand.split(' ');
        const lastPart = parts[parts.length - 1];
        const isFirstWord = parts.length === 1;

        if (isFirstWord) {
            // Complete command names
            const commonCommands = ['help', 'clear', 'history', 'ls', 'dir', 'pwd', 'cd', 'mkdir', 'touch', 'cat', 'tree', 'find', 'which', 'echo', 'whoami', 'date', 'exit'];
            const matches = commonCommands.filter(cmd => cmd.startsWith(lastPart.toLowerCase()));

            if (matches.length === 1) {
                setCurrentCommand(matches[0] + ' ');
            } else if (matches.length > 1) {
                // Show available options in terminal
                const optionsMessage = {
                    type: 'system',
                    content: `Available commands: ${matches.join(', ')}`,
                    timestamp: new Date().toLocaleTimeString(),
                };
                setCommandHistory(prev => [...prev, optionsMessage]);
            }
        } else {
            if (!isLocalDirectory(currentPath)) return;
            // Complete file/directory paths
            try {
                const dirContent = await invoke('open_directory', { path: currentPath });
                const data = JSON.parse(dirContent);
                
                const allItems = [
                    ...data.directories.map(dir => dir.name + '/'),
                    ...data.files.map(file => file.name)
                ];

                const matches = allItems.filter(item => item.toLowerCase().startsWith(lastPart.toLowerCase()));

                if (matches.length === 1) {
                    const completedParts = parts.slice(0, -1);
                    completedParts.push(matches[0]);
                    setCurrentCommand(completedParts.join(' '));
                } else if (matches.length > 1) {
                    // Show available files/directories
                    const optionsMessage = {
                        type: 'system',
                        content: `Available items: ${matches.join(', ')}`,
                        timestamp: new Date().toLocaleTimeString(),
                    };
                    setCommandHistory(prev => [...prev, optionsMessage]);
                }
            } catch (error) {
                // Silently ignore errors in tab completion
            }
        }
    };

    /**
     * Searches through command history based on query
     * @param {string} query - Search query
     * @returns {string[]} Filtered commands
     */
    const searchHistory = (query) => {
        if (!query.trim()) return [];
        return persistentHistory.filter(cmd => 
            cmd.toLowerCase().includes(query.toLowerCase())
        ).slice(-10); // Show last 10 matches
    };

    /**
     * Handles search mode toggle and functionality
     * @param {string} query - Current search query
     */
    const handleHistorySearch = (query) => {
        const results = searchHistory(query);
        setSearchResults(results);
        setSelectedSearchIndex(results.length > 0 ? 0 : -1);
    };

    /**
     * Exits search mode and resets search state
     */
    const exitSearchMode = () => {
        setIsSearchMode(false);
        setSearchQuery('');
        setSearchResults([]);
        setSelectedSearchIndex(-1);
    };

    const handleTerminalKeyDown = (e) => {
        if (ptySessionIdRef.current) {
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            const selectedText = window.getSelection?.()?.toString() || '';
            if (selectedText) {
                e.stopPropagation();
                navigator.clipboard?.writeText?.(selectedText).catch(() => {});
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            if (isExecuting && abortController) {
                abortController.abort();
                setIsExecuting(false);
                setAbortController(null);

                setCommandHistory(prev => [...prev, {
                    type: 'error',
                    content: '❌ Command interrupted by user (Ctrl+C)',
                    timestamp: new Date().toLocaleTimeString(),
                }]);

                setCurrentCommand('');
                setHistoryIndex(-1);
                return;
            }

            if (currentCommand.trim()) {
                const commandEntry = {
                    type: 'command',
                    prompt: getPrompt(),
                    content: currentCommand + ' ^C',
                    timestamp: new Date().toLocaleTimeString(),
                };
                setCommandHistory(prev => [...prev, commandEntry]);
                setCurrentCommand('');
                setHistoryIndex(-1);
            }
        }
    };

    /**
     * Handles keyboard navigation through command history and tab completion
     * Supports arrow up/down for history navigation and tab for command completion
     * Also handles Ctrl+R for search
     *
     * @param {React.KeyboardEvent} e - Keyboard event
     */
    const handleKeyDown = async (e) => {
        // Handle Ctrl+R for reverse search (case-insensitive)
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
            e.preventDefault();
            if (!isSearchMode) {
                setIsSearchMode(true);
                setSearchQuery('');
                setCurrentCommand('');
            }
            return;
        }

        // Handle search mode
        if (isSearchMode) {
            if (e.key === 'Escape') {
                e.preventDefault();
                exitSearchMode();
                return;
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                if (selectedSearchIndex >= 0 && searchResults[selectedSearchIndex]) {
                    setCurrentCommand(searchResults[selectedSearchIndex]);
                    exitSearchMode();
                }
                return;
            }

            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                if (searchResults.length > 0) {
                    let newIndex;
                    if (e.key === 'ArrowUp') {
                        newIndex = selectedSearchIndex > 0 ? selectedSearchIndex - 1 : searchResults.length - 1;
                    } else {
                        newIndex = selectedSearchIndex < searchResults.length - 1 ? selectedSearchIndex + 1 : 0;
                    }
                    setSelectedSearchIndex(newIndex);
                }
                return;
            }

            return; // Let other keys be handled normally in search mode
        }

        if (isExecuting) return;

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            
            if (persistentHistory.length > 0) {
                const newIndex = historyIndex < persistentHistory.length - 1
                    ? historyIndex + 1
                    : historyIndex;

                if (newIndex >= 0 && newIndex < persistentHistory.length) {
                    setCurrentCommand(persistentHistory[persistentHistory.length - 1 - newIndex]);
                    setHistoryIndex(newIndex);
                }
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();

            if (historyIndex > 0) {
                const newIndex = historyIndex - 1;
                setCurrentCommand(persistentHistory[persistentHistory.length - 1 - newIndex]);
                setHistoryIndex(newIndex);
            } else if (historyIndex === 0) {
                setCurrentCommand('');
                setHistoryIndex(-1);
            }
        } else if (e.key === 'Tab') {
            e.preventDefault();
            await handleTabCompletion();
        }
    };

    /**
     * Handles clearing the terminal display
     */
    const [copiedFeedback, setCopiedFeedback] = useState(false);

    const handleClearTerminal = () => {
        if (ptySessionId && xtermControllersRef.current[ptySessionId]) {
            xtermControllersRef.current[ptySessionId].clear();
        }
        setCommandHistory([]);
    };

    const handleCopyTerminal = async () => {
        const xtermText = ptySessionId && xtermControllersRef.current[ptySessionId]
            ? xtermControllersRef.current[ptySessionId].getBufferText()
            : '';
        const formatted = xtermText || commandHistory
            .map((entry) => {
                if (entry.type === 'command') {
                    return `${entry.prompt || '$'} ${entry.content || ''}`;
                }
                return entry.content || '';
            })
            .filter(Boolean)
            .join('\n');
        try {
            await navigator.clipboard.writeText(formatted);
            setCopiedFeedback(true);
            setTimeout(() => setCopiedFeedback(false), 1500);
        } catch {
            // Fallback for older webviews
            const ta = document.createElement('textarea');
            ta.value = formatted;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            setCopiedFeedback(true);
            setTimeout(() => setCopiedFeedback(false), 1500);
        }
    };

    return (
        <div
            className={`enhanced-terminal${isFullscreen ? ' terminal-fullscreen' : ''}`}
            style={!isOpen ? { display: 'none' } : isFullscreen ? undefined : { height: `${terminalHeight}px` }}
            onKeyDown={handleTerminalKeyDown}
        >
            <div className="terminal-header">
                <div className="terminal-title">
                    {terminalTabs.map((tab) => {
                        const isTabActive = tab.id === activeTab?.id;
                        return (
                            <div
                                key={tab.id}
                                onClick={() => selectTerminalTab(tab.id)}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '3px 9px',
                                    borderRadius: '5px',
                                    fontSize: '12px',
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                    background: isTabActive ? 'var(--accent, #0672ef)' : 'rgba(255,255,255,0.06)',
                                    color: isTabActive ? '#fff' : 'inherit',
                                    fontWeight: isTabActive ? 600 : 400,
                                }}
                                title={tab.sshConnection ? `${tab.sshConnection.username || 'guest'}@${tab.sshConnection.host}:${tab.sshWorkingDir}` : 'Local shell'}
                            >
                                <span>{tab.label}</span>
                                {terminalTabs.length > 1 && (
                                    <span
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            closeTabPty(tab.id);
                                            if (tab.sshFollowsExplorer) {
                                                explorerSshTabsRef.current.delete(getExplorerSshKey(tab.sshExplorerTabId, tab.sshConnection));
                                            }
                                            sshHomeDirRef.current.delete(tab.id);
                                            lastFailedSyncDirRef.current.delete(tab.id);
                                            forceSyncNextOscRef.current.delete(tab.id);
                                            const remaining = terminalTabsRef.current.filter((t) => t.id !== tab.id);
                                            if (activeTabIdRef.current === tab.id && remaining.length > 0) {
                                                selectTerminalTab(remaining[0].id);
                                            }
                                            setTerminalTabs((prev) => prev.filter((t) => t.id !== tab.id));
                                        }}
                                        style={{ opacity: 0.75, fontSize: '13px', lineHeight: 1 }}
                                        title="Close terminal tab"
                                    >
                                        ×
                                    </span>
                                )}
                            </div>
                        );
                    })}
                    <button
                        type="button"
                        className="terminal-control"
                        onClick={() => {
                            const newId = `local-${Date.now()}`;
                            const num = terminalTabs.filter((t) => !t.sshConnection).length + 1;
                            const label = `Local #${num}`;
                            setTerminalTabs((prev) => [
                                ...prev,
                                {
                                    id: newId,
                                    label,
                                    history: [buildWelcomeEntry(label, currentPath || '/')],
                                    sshConnection: null,
                                    sshWorkingDir: '.',
                                    ptySessionId: null,
                                },
                            ]);
                            selectTerminalTab(newId);
                        }}
                        title="New local terminal tab"
                        style={{ padding: '2px 7px', fontSize: '13px', lineHeight: 1 }}
                    >
                        +
                    </button>
                </div>
                <div className="terminal-controls">
                    {activeSshConnection && (
                        <button
                            type="button"
                            className="terminal-control"
                            onClick={() => openIndependentSshTab(activeSshConnection, activeTab.sshConfirmedDir || sshWorkingDir)}
                            title="Duplicate SSH session (new shell at last known directory)"
                        >
                            Duplicate SSH
                        </button>
                    )}
                    {activeSshConnection && (
                        <button
                            className="terminal-control"
                            disabled={!ptyListenersReady || ['connecting', 'finishing'].includes(activeTab.ptyStatus)}
                            onClick={() => {
                                if (ptySessionId) {
                                    closeTabPty(activeTab.id);
                                    updateTab(activeTab.id, { ptySessionId: null, ptyStatus: 'stopped', ptyDisabledManually: true });
                                } else {
                                    startTabPty(activeTab);
                                }
                            }}
                            title={ptySessionId ? 'Stop interactive SSH PTY' : 'Start interactive SSH PTY'}
                        >
                            {activeTab.ptyStatus === 'finishing' ? 'Finishing…' : ptySessionId ? 'Stop PTY' : activeTab.ptyStatus === 'connecting' ? 'Connecting…' :
                                ['disconnected', 'error'].includes(activeTab.ptyStatus) ? 'Reconnect' : 'PTY'}
                        </button>
                    )}
                    {activeSshConnection && explorerTabs && (
                        <button
                            type="button"
                            className="terminal-control"
                            disabled={!activeTab.sshFollowsExplorer && !canAttachToExplorer(activeTab)}
                            onClick={() => changeBinding(activeTab, !activeTab.sshFollowsExplorer)}
                            title={activeTab.sshFollowsExplorer
                                ? 'Unlink from Explorer without closing the shell'
                                : 'Attach to active Explorer tab (same SSH profile); preserve both shells'}
                        >
                            {activeTab.sshFollowsExplorer ? 'Unlink' : 'Attach'}
                        </button>
                    )}
                    {activeSshConnection && ptySessionId && (
                        <button
                            type="button"
                            className="terminal-control"
                            onClick={() => {
                                if (activeTab.sshFollowsExplorer) {
                                    lastFailedSyncDirRef.current.delete(activeTab.id);
                                    forceSyncNextOscRef.current.add(activeTab.id);
                                }
                                injectShellIntegration(ptySessionId);
                            }}
                            title={activeTab.sshFollowsExplorer
                                ? 'Re-enable directory sync hook in current shell (useful after sudo/su)'
                                : 'Refresh working directory hook in this independent shell'}
                        >
                            {activeTab.sshFollowsExplorer ? 'Sync' : 'Refresh CWD'}
                        </button>
                    )}
                    {activeSshConnection && (
                        <button
                            type="button"
                            className="terminal-control"
                            onClick={() => {
                                invoke('open_external_ssh_terminal', {
                                    host: activeSshConnection.host,
                                    port: Number(activeSshConnection.port || 22),
                                    username: activeSshConnection.username || '',
                                    privateKeyPath: activeSshConnection.privateKeyPath || null,
                                }).catch((e) => {
                                    setCommandHistory(prev => [
                                        ...prev,
                                        { type: 'error', content: `Failed to open external SSH terminal: ${e}`, timestamp: new Date().toLocaleTimeString() },
                                    ], activeTab.id);
                                });
                            }}
                            title="Open in native OS terminal (best for mc / btop / htop)"
                        >
                            Ext SSH
                        </button>
                    )}
                    {activeSshConnection && (
                        <button
                            className="terminal-control"
                            onClick={() => selectTerminalTab('local')}
                            title="Switch to Local terminal tab"
                        >
                            Local
                        </button>
                    )}
                    <button
                        type="button"
                        className="terminal-control"
                        onClick={handleCopyTerminal}
                        title="Copy entire terminal output (formatted)"
                    >
                        {copiedFeedback ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                        type="button"
                        className="terminal-control"
                        onClick={() => {
                            setIsFullscreen((prev) => {
                                const next = !prev;
                                window.dispatchEvent(new CustomEvent('terminal-fullscreen-change', { detail: { isFullscreen: next } }));
                                return next;
                            });
                        }}
                        title={isFullscreen ? 'Restore terminal size' : 'Expand terminal to fullscreen'}
                    >
                        {isFullscreen ? 'Restore' : '⛶'}
                    </button>
                    <button 
                        className="terminal-control terminal-clear"
                        onClick={handleClearTerminal}
                        title="Clear terminal"
                    >
                        <Icon name="trash" size="small" className="terminal-icon" />
                    </button>
                    <button 
                        className="terminal-control terminal-close"
                        onClick={onToggle}
                        title="Close terminal"
                    >
                        <Icon name="x" size="small" className="terminal-icon" />
                    </button>
                </div>
            </div>
            {ptySessionId && activeTab.ptyWriteError && (
                <div role="alert" className="terminal-input-error">
                    <span>SSH input paused: {activeTab.ptyWriteError}. Check the remote shell before resuming; unsent input was discarded. Input already submitted may still execute.</span>
                    <button type="button" className="terminal-control" onClick={() => {
                        failedPtyWritesRef.current.delete(ptySessionId);
                        updateTab(activeTab.id, { ptyWriteError: null });
                    }}>Resume input</button>
                </div>
            )}
            {terminalTabs
                .filter((tab) => Boolean(tab.ptySessionId))
                .map((tab) => (
                    <XtermSshView
                        key={tab.ptySessionId}
                        sessionId={tab.ptySessionId}
                        isVisible={isOpen && tab.id === activeTab?.id}
                        isFullscreen={isFullscreen}
                        onData={(data) => {
                            return writePty(tab.ptySessionId, data, true);
                        }}
                        onResize={(cols, rows) => {
                            if (ptyOwnersRef.current.get(tab.ptySessionId) === tab.id) {
                                invoke('ssh_resize_pty', { sessionId: tab.ptySessionId, cols, rows }).catch(() => {});
                            }
                        }}
                        registerController={(sid, ctrl) => {
                            if (ctrl) {
                                xtermControllersRef.current[sid] = ctrl;
                                const buffered = pendingPtyOutputRef.current.get(sid);
                                if (buffered?.text) {
                                    ctrl.write((buffered.truncated ? PTY_STARTUP_TRUNCATED + '\r\n' : '') + buffered.text);
                                }
                                // Keep only the truncation flag after replay.
                                if (buffered?.truncated) pendingPtyOutputRef.current.set(sid, { text: '', truncated: true });
                                else pendingPtyOutputRef.current.delete(sid);
                            } else {
                                delete xtermControllersRef.current[sid];
                            }
                        }}
                    />
                ))}
            {!ptySessionId && (
            <div className="terminal-content" ref={terminalRef}>
                {commandHistory.map((entry, index) => (
                    <div
                        key={index}
                        className={`terminal-line terminal-${entry.type}`}
                    >
                        <div className="terminal-entry">
                            {entry.type === 'command' && (() => {
                                const promptParts = parsePrompt(entry.prompt);
                                return (
                                    <div className="terminal-command-line">
                                        <span className="terminal-prompt-user">{promptParts.user}</span>
                                        <span className="terminal-prompt-at">@</span>
                                        <span className="terminal-prompt-host">{promptParts.host}</span>
                                        <span className="terminal-prompt-colon">:</span>
                                        <span className="terminal-prompt-path">{promptParts.path}</span>
                                        <span className="terminal-prompt-dollar">$ </span>
                                        <span className="terminal-command-text">{entry.content}</span>
                                    </div>
                                );
                            })()}
                            {entry.type !== 'command' && (
                                <pre 
                                    className="terminal-text"
                                    dangerouslySetInnerHTML={{ 
                                        __html: entry.type === 'output' && entry.originalCommand 
                                            ? formatOutput(entry.content, entry.originalCommand) 
                                            : escapeHtml(entry.content)
                                    }}
                                ></pre>
                            )}
                        </div>
                    </div>
                ))}
                <form onSubmit={handleSubmit} className="terminal-input-line">
                    {isSearchMode ? (
                        <span className="terminal-prompt-search">(reverse-i-search) </span>
                    ) : (() => {
                        const promptParts = parsePrompt(getPrompt());
                        return (
                            <div className="terminal-current-prompt">
                                <span className="terminal-prompt-user">{promptParts.user}</span>
                                <span className="terminal-prompt-at">@</span>
                                <span className="terminal-prompt-host">{promptParts.host}</span>
                                <span className="terminal-prompt-colon">:</span>
                                <span className="terminal-prompt-path">{promptParts.path}</span>
                                <span className="terminal-prompt-dollar">$ </span>
                            </div>
                        );
                    })()}
                    <input
                        ref={inputRef}
                        type="text"
                        className="terminal-input"
                        value={isSearchMode ? searchQuery : currentCommand}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        readOnly={isExecuting}
                        autoFocus
                        spellCheck="false"
                        autoComplete="off"
                        autoCapitalize="off"
                        placeholder={isSearchMode ? "Start typing to search history..." : ""}
                    />
                    {!isSearchMode && isExecuting && (
                        <span className="terminal-executing">
                            <span className="spinner-small"></span>
                            <span className="terminal-interrupt-hint">⏱️ Running... Press Ctrl+C to interrupt</span>
                        </span>
                    )}
                </form>
                {isSearchMode && searchResults.length > 0 && (
                    <div className="terminal-search-results" role="listbox" aria-label="Command history search results">
                        {searchResults.map((result, idx) => (
                            <div
                                key={`${result}-${idx}`}
                                role="option"
                                aria-selected={idx === selectedSearchIndex}
                                className={`terminal-search-result-item ${idx === selectedSearchIndex ? 'selected' : ''}`}
                                onClick={() => {
                                    setCurrentCommand(result);
                                    exitSearchMode();
                                    inputRef.current?.focus();
                                }}
                            >
                                {result}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            )}
        </div>
    );
};

export default Terminal;

