import React, { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useHistory } from '../../providers/HistoryProvider';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useSettings } from '../../providers/SettingsProvider';
import { useSftp } from '../../providers/SftpProvider';
import Icon from '../common/Icon';
import XtermSshView from './XtermSshView';
import { joinPath } from '../../utils/pathUtils';
import './terminal.css';

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

const getSshTabId = (conn) =>
    `ssh:${conn.username || 'guest'}@${conn.host}:${conn.port || 22}`;

const extractOscDirectory = (chunk) => {
    if (!chunk || typeof chunk !== 'string') return null;
    // OSC 7: \x1b]7;file://host/path\x07 or ST
    const osc7 = chunk.match(/\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]+)(?:\x07|\x1b\\)/g);
    if (osc7 && osc7.length > 0) {
        const last = osc7[osc7.length - 1];
        const m = last.match(/\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]+)/);
        if (m?.[1]) {
            try {
                return decodeURIComponent(m[1]);
            } catch {
                return m[1];
            }
        }
    }
    // OSC 0 / 2 title: \x1b]0;user@host:/path\x07 (common on RHEL/CentOS/Ubuntu bashrc)
    const oscTitle = chunk.match(/\x1b\][02];[^:\x07\x1b]+:(\/[^\x07\x1b]*|~[^\x07\x1b]*)(?:\x07|\x1b\\)/g);
    if (oscTitle && oscTitle.length > 0) {
        const last = oscTitle[oscTitle.length - 1];
        const m = last.match(/\x1b\][02];[^:\x07\x1b]+:(\/[^\x07\x1b]*|~[^\x07\x1b]*)/);
        if (m?.[1] && m[1].startsWith('/')) {
            return m[1];
        }
    }
    return null;
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
const Terminal = ({ isOpen, onToggle }) => {
    const { currentPath, navigateTo } = useHistory();
    const { loadDirectory } = useFileSystem();
    const { settings } = useSettings();
    const { isSftpPath, parseSftpPath, createSftpUrl, executeSshCommand, startSshPty } = useSftp();
    const parsedSftp = isSftpPath(currentPath) ? parseSftpPath(currentPath) : null;
    const currentPathRef = useRef(currentPath);
    currentPathRef.current = currentPath;

    const [isFullscreen, setIsFullscreen] = useState(false);
    const xtermControllersRef = useRef({});
    const autoPtyAttemptedRef = useRef(new Set());
    const syncingFromTerminalRef = useRef(false);

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
    activeTabIdRef.current = activeTabId;
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

    const setCommandHistory = (updater) => {
        const targetId = activeTabIdRef.current;
        updateTab(targetId, (tab) => ({
            ...tab,
            history: typeof updater === 'function' ? updater(tab.history) : updater,
        }));
    };

    const setSshWorkingDir = (nextDir) => {
        updateTab(activeTabIdRef.current, { sshWorkingDir: nextDir });
    };

    const setPtySessionId = (nextSid, targetTabId = activeTabIdRef.current) => {
        updateTab(targetTabId, { ptySessionId: nextSid });
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

    useEffect(() => {
        let unlistenOut = null;
        let unlistenExit = null;
        let active = true;

        (async () => {
            try {
                unlistenOut = await listen('ssh-pty-output', (event) => {
                    const payload = event?.payload;
                    if (!active || !payload?.session_id) return;

                    // Feed raw VT100 stream directly to xterm.js controller
                    const ctrl = xtermControllersRef.current[payload.session_id];
                    if (ctrl) {
                        ctrl.write(payload.data);
                    } else {
                        const cleaned = stripAnsiCodes(payload.data);
                        if (cleaned) {
                            setTerminalTabs((prev) =>
                                prev.map((tab) =>
                                    tab.ptySessionId === payload.session_id
                                        ? {
                                            ...tab,
                                            history: [
                                                ...tab.history,
                                                { type: 'output', content: cleaned, timestamp: new Date().toLocaleTimeString() },
                                            ],
                                        }
                                        : tab
                                )
                            );
                        }
                    }

                    // Follow directory changes emitted by remote shell (OSC 7 / OSC 0/2)
                    const detectedDir = extractOscDirectory(payload.data);
                    if (detectedDir && detectedDir.startsWith('/')) {
                        const ownerTab = terminalTabsRef.current.find((t) => t.ptySessionId === payload.session_id);
                        if (ownerTab && ownerTab.sshConnection && ownerTab.sshWorkingDir !== detectedDir) {
                            updateTab(ownerTab.id, { sshWorkingDir: detectedDir });
                            const cur = currentPathRef.current;
                            if (isSftpPath(cur)) {
                                const parsedCur = parseSftpPath(cur);
                                if (parsedCur && getSshTabId(parsedCur.connection) === ownerTab.id) {
                                    const nextSftpUrl = createSftpUrl(ownerTab.sshConnection, detectedDir);
                                    if (nextSftpUrl !== cur) {
                                        syncingFromTerminalRef.current = true;
                                        loadDirectory(nextSftpUrl)
                                            .then((ok) => {
                                                if (ok) navigateTo(nextSftpUrl);
                                            })
                                            .catch(() => {})
                                            .finally(() => {
                                                setTimeout(() => { syncingFromTerminalRef.current = false; }, 100);
                                            });
                                    }
                                }
                            }
                        }
                    }
                });
                unlistenExit = await listen('ssh-pty-exit', (event) => {
                    const payload = event?.payload;
                    if (!active || !payload?.session_id) return;
                    setTerminalTabs((prev) =>
                        prev.map((tab) =>
                            tab.ptySessionId === payload.session_id
                                ? {
                                    ...tab,
                                    ptySessionId: null,
                                    history: [
                                        ...tab.history,
                                        { type: 'system', content: `[SSH PTY exited: ${payload.reason}]`, timestamp: new Date().toLocaleTimeString() },
                                    ],
                                }
                                : tab
                        )
                    );
                });
            } catch {
                // Non-Tauri test environments may not mock event listeners
            }
        })();

        return () => {
            active = false;
            if (typeof unlistenOut === 'function') unlistenOut();
            if (typeof unlistenExit === 'function') unlistenExit();
            for (const tab of terminalTabsRef.current) {
                if (tab.ptySessionId) {
                    invoke('ssh_close_pty', { sessionId: tab.ptySessionId }).catch(() => {});
                }
            }
        };
    }, []);

    const ensureAndSelectSshTab = (conn, remoteDir = '.') => {
        const tabId = getSshTabId(conn);
        const label = `SSH: ${conn.name || conn.host}`;
        setTerminalTabs((prev) => {
            const exists = prev.some((t) => t.id === tabId);
            if (exists) {
                return prev.map((t) =>
                    t.id === tabId
                        ? { ...t, sshConnection: conn, sshWorkingDir: remoteDir || t.sshWorkingDir }
                        : t
                );
            }
            return [
                ...prev,
                {
                    id: tabId,
                    label,
                    history: [
                        buildWelcomeEntry(label, remoteDir || '.'),
                        {
                            type: 'system',
                            content: `[SSH] Terminal session ready for ${conn.username || 'guest'}@${conn.host}:${conn.port || 22}`,
                            timestamp: new Date().toLocaleTimeString(),
                        },
                    ],
                    sshConnection: conn,
                    sshWorkingDir: remoteDir || '.',
                    ptySessionId: null,
                    ptyDisabledManually: false,
                },
            ];
        });
        setActiveTabId(tabId);
    };

    useEffect(() => {
        const handleOpenSsh = (e) => {
            const conn = e?.detail?.connection;
            if (!conn?.host) return;
            ensureAndSelectSshTab(conn, '.');
        };
        window.addEventListener('open-ssh-terminal', handleOpenSsh);
        return () => window.removeEventListener('open-ssh-terminal', handleOpenSsh);
    }, []);

    // Automatically switch terminal tab when user switches active explorer window/path
    useEffect(() => {
        if (syncingFromTerminalRef.current) return;
        if (parsedSftp?.connection) {
            ensureAndSelectSshTab(parsedSftp.connection, parsedSftp.remotePath || '.');
        } else if (activeTabIdRef.current.startsWith('ssh:')) {
            setActiveTabId('local');
        }
    }, [currentPath, parsedSftp?.connection?.host, parsedSftp?.connection?.username, parsedSftp?.connection?.port, parsedSftp?.remotePath]);

    // Auto-start full interactive PTY by default whenever an SSH tab is active and terminal is open
    useEffect(() => {
        if (!isOpen || !activeTab?.sshConnection || activeTab?.ptySessionId || activeTab?.ptyDisabledManually) {
            return;
        }
        if (autoPtyAttemptedRef.current.has(activeTab.id)) {
            return;
        }
        autoPtyAttemptedRef.current.add(activeTab.id);

        const targetTabId = activeTab.id;
        const conn = activeTab.sshConnection;
        const dir = activeTab.sshWorkingDir || '.';

        startSshPty(conn, dir, 100, 30)
            .then((sid) => {
                if (sid) {
                    setPtySessionId(sid, targetTabId);
                }
            })
            .catch((e) => {
                updateTab(targetTabId, (tab) => ({
                    ...tab,
                    history: [
                        ...tab.history,
                        { type: 'error', content: `Failed to auto-start SSH PTY: ${e}`, timestamp: new Date().toLocaleTimeString() },
                    ],
                }));
            });
    }, [isOpen, activeTab?.id, activeTab?.ptySessionId, activeTab?.ptyDisabledManually]);

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
            if (ptySessionIdRef.current) {
                await invoke('ssh_write_pty', {
                    sessionId: ptySessionIdRef.current,
                    data: `${command}\n`,
                });
                return null;
            }
            if (activeSshConnection) {
                const trimmedCmd = command.trim();
                if (trimmedCmd === 'cd' || trimmedCmd.startsWith('cd ')) {
                    const targetDir = trimmedCmd === 'cd' ? '~' : trimmedCmd.slice(3).trim();
                    const quoted = `'${targetDir.replace(/'/g, `'\\''`)}'`;
                    const cdCmd = targetDir === '~' ? 'cd ~ && pwd' : `cd ${quoted} && pwd`;
                    const res = await executeSshCommand(activeSshConnection, cdCmd, sshWorkingDir);
                    if (res.exit_code === 0 && res.stdout?.trim()) {
                        const newRemoteDir = res.stdout.trim().split('\n').pop().trim();
                        setSshWorkingDir(newRemoteDir);
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

        // Add command to history
        const commandEntry = {
            type: 'command',
            prompt: getPrompt(),
            content: command,
            timestamp: new Date().toLocaleTimeString(),
        };

        setCommandHistory(prev => [...prev, commandEntry]);

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
            }]);
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

    if (!isOpen) return null;

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
            style={isFullscreen ? undefined : { height: `${terminalHeight}px` }}
            onKeyDown={handleTerminalKeyDown}
        >
            <div className="terminal-header">
                <div className="terminal-title">
                    {terminalTabs.map((tab) => {
                        const isTabActive = tab.id === activeTab?.id;
                        return (
                            <div
                                key={tab.id}
                                onClick={() => setActiveTabId(tab.id)}
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
                                            if (tab.ptySessionId) {
                                                invoke('ssh_close_pty', { sessionId: tab.ptySessionId }).catch(() => {});
                                            }
                                            setTerminalTabs((prev) => {
                                                const remaining = prev.filter((t) => t.id !== tab.id);
                                                if (activeTabIdRef.current === tab.id && remaining.length > 0) {
                                                    setActiveTabId(remaining[0].id);
                                                }
                                                return remaining;
                                            });
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
                            setActiveTabId(newId);
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
                            className="terminal-control"
                            onClick={async () => {
                                const tabId = activeTab.id;
                                if (ptySessionId) {
                                    await invoke('ssh_close_pty', { sessionId: ptySessionId }).catch(() => {});
                                    updateTab(tabId, { ptySessionId: null, ptyDisabledManually: true });
                                } else {
                                    try {
                                        updateTab(tabId, { ptyDisabledManually: false });
                                        const sid = await startSshPty(activeSshConnection, sshWorkingDir, 100, 30);
                                        setPtySessionId(sid, tabId);
                                    } catch (e) {
                                        setCommandHistory(prev => [
                                            ...prev,
                                            { type: 'error', content: `Failed to start SSH PTY: ${e}`, timestamp: new Date().toLocaleTimeString() },
                                        ]);
                                    }
                                }
                            }}
                            title={ptySessionId ? 'Stop interactive SSH PTY' : 'Start interactive SSH PTY'}
                        >
                            {ptySessionId ? 'Stop PTY' : 'PTY'}
                        </button>
                    )}
                    {activeSshConnection && (
                        <button
                            className="terminal-control"
                            onClick={() => setActiveTabId('local')}
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
                        onClick={() => setIsFullscreen((prev) => !prev)}
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
            {terminalTabs
                .filter((tab) => Boolean(tab.ptySessionId))
                .map((tab) => (
                    <XtermSshView
                        key={tab.ptySessionId}
                        sessionId={tab.ptySessionId}
                        isVisible={isOpen && tab.id === activeTab?.id}
                        isFullscreen={isFullscreen}
                        onData={(data) => {
                            invoke('ssh_write_pty', { sessionId: tab.ptySessionId, data }).catch(() => {});
                        }}
                        onResize={(cols, rows) => {
                            invoke('ssh_resize_pty', { sessionId: tab.ptySessionId, cols, rows }).catch(() => {});
                        }}
                        registerController={(sid, ctrl) => {
                            if (ctrl) {
                                xtermControllersRef.current[sid] = ctrl;
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

