const MAX_OSC_BUFFER_BYTES = 4096;

export function normalizeRemotePosixPath(remotePath) {
    if (!remotePath || typeof remotePath !== 'string') return '/';
    const collapsed = remotePath.trim().replace(/\/+/g, '/');
    if (!collapsed.startsWith('/')) return `/${collapsed}`.replace(/\/+$/, '') || '/';
    return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : '/';
}

export function resolveOscTildePath(rawDir, homeDir = null) {
    if (!rawDir || typeof rawDir !== 'string') return null;
    const trimmed = rawDir.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('/')) {
        return normalizeRemotePosixPath(trimmed);
    }

    if (!homeDir || typeof homeDir !== 'string' || !homeDir.startsWith('/')) {
        return null;
    }

    const normalizedHome = normalizeRemotePosixPath(homeDir);
    if (trimmed === '~') {
        return normalizedHome;
    }
    if (trimmed.startsWith('~/')) {
        const sub = trimmed.slice(2);
        return normalizedHome === '/'
            ? normalizeRemotePosixPath(`/${sub}`)
            : normalizeRemotePosixPath(`${normalizedHome}/${sub}`);
    }
    return null;
}

/**
 * Extracts the latest working directory reported via OSC 7 or OSC 0/2 window title.
 * Handles spaces after ':' (Ubuntu/Debian), '~'/'~/...' (RHEL/CentOS/Ubuntu),
 * Midnight Commander titles, and URL-encoded OSC 7 URIs.
 */
export function extractOscDirectory(chunk, homeDir = null) {
    if (!chunk || typeof chunk !== 'string') return null;

    let latestMatch = null;
    const recordCandidate = (index, dir) => {
        if (!dir) return;
        if (!latestMatch || index >= latestMatch.index) {
            latestMatch = { index, dir };
        }
    };

    // OSC 7: \x1b]7;file://host/path\x07 or ST (\x1b\\)
    const osc7Regex = /\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
    let match;
    while ((match = osc7Regex.exec(chunk)) !== null) {
        let rawPath = match[1];
        try {
            rawPath = decodeURIComponent(rawPath);
        } catch {
            // Keep raw path if percent-encoding is malformed
        }
        const resolved = resolveOscTildePath(rawPath, homeDir);
        if (resolved) {
            recordCandidate(match.index, resolved);
        }
    }

    // OSC 0 / 2 title: \x1b]0;user@host: /path\x07, \x1b]0;mc [user@host]:/path\x07, etc.
    const oscTitleRegex = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    while ((match = oscTitleRegex.exec(chunk)) !== null) {
        const title = match[1].trimEnd();
        const userHostMatch = title.match(
            /(?:^|\s|\[)[^:\s\]]+@[^:\s\]]+\]?:\s*(~(?:\/[^\x07\x1b]*)?|\/[^\x07\x1b]*)$/
        );
        const mcMatch = !userHostMatch
            ? title.match(/^mc\s+-\s+(~(?:\/[^\x07\x1b]*)?|\/[^\x07\x1b]*)$/)
            : null;
        const rawDir = userHostMatch?.[1] || mcMatch?.[1] || null;
        if (rawDir) {
            const resolved = resolveOscTildePath(rawDir, homeDir);
            if (resolved) {
                recordCandidate(match.index, resolved);
            }
        }
    }

    return latestMatch ? latestMatch.dir : null;
}

/**
 * Extracts the latest shell prompt lifecycle marker emitted by OSC 133 integration:
 * 'idle' on OSC 133;A (at shell prompt), 'busy' on OSC 133;C (command running), or null.
 */
export function extractOscPromptState(chunk) {
    if (!chunk || typeof chunk !== 'string') return null;
    const regex = /\x1b\]133;([AC])(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;
    let match;
    let state = null;
    while ((match = regex.exec(chunk)) !== null) {
        state = match[1] === 'A' ? 'idle' : 'busy';
    }
    return state;
}

/**
 * Buffers incomplete trailing ESC / OSC sequences across PTY output chunks up to 4 KB.
 */
export function consumeOscChunk(prevBuffer = '', chunk = '') {
    const combined = `${prevBuffer || ''}${chunk || ''}`;
    if (!combined) {
        return { completed: '', remainingBuffer: '' };
    }

    const lastOscStart = combined.lastIndexOf('\x1b]');
    if (lastOscStart !== -1) {
        const afterPrefix = lastOscStart + 2;
        const belIdx = combined.indexOf('\x07', afterPrefix);
        const stIdx = combined.indexOf('\x1b\\', afterPrefix);
        if (belIdx === -1 && stIdx === -1) {
            const tail = combined.slice(lastOscStart);
            if (tail.length <= MAX_OSC_BUFFER_BYTES) {
                return {
                    completed: combined.slice(0, lastOscStart),
                    remainingBuffer: tail,
                };
            }
            return { completed: combined, remainingBuffer: '' };
        }
    }

    // Also hold a lone trailing ESC in case the next chunk starts with ']'
    if (combined.endsWith('\x1b')) {
        return {
            completed: combined.slice(0, -1),
            remainingBuffer: '\x1b',
        };
    }

    return { completed: combined, remainingBuffer: '' };
}

/**
 * Builds a single-line POSIX/bash/zsh shell integration command (leading space avoids
 * ignorespace history) emitting OSC 7 cwd + OSC 133;A/C prompt markers.
 */
export function buildShellIntegrationCommand() {
    return (
        ' __explr_osc7(){ printf \'\\033]7;file://%s%s\\007\\033]133;A\\007\' "${HOSTNAME:-}" "$PWD"; }; ' +
        '__explr_osc133_c(){ printf \'\\033]133;C\\007\'; }; ' +
        'if [ -n "${ZSH_VERSION:-}" ]; then ' +
        'autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __explr_osc7 2>/dev/null && add-zsh-hook preexec __explr_osc133_c 2>/dev/null || ' +
        'eval \'precmd_functions+=(__explr_osc7); preexec_functions+=(__explr_osc133_c)\'; ' +
        'else ' +
        'case ":${PROMPT_COMMAND:-}:" in *":__explr_osc7:"*|*";__explr_osc7;"*|*"__explr_osc7"*) ;; *) PROMPT_COMMAND="__explr_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; ' +
        'case "${BASH_VERSION:-}" in [5-9].*|4.[4-9]*|4.[1-9][0-9]*) PS0="${PS0:-}"\'\\e]133;C\\a\';; esac; ' +
        'fi; clear\n'
    );
}

/**
 * Detects interactive shell elevation commands where the child shell loses prior hooks.
 */
export function isElevationCommand(line) {
    if (!line || typeof line !== 'string') return false;
    return /^\s*(?:sudo\s+(?:-[A-Za-z]*[is][A-Za-z]*\b|su\b)|su(?:\s|$))/.test(line);
}

/**
 * Returns up to maxLevels parent directory paths above remotePath, stopping at '/'.
 */
export function getParentRemoteDirs(remotePath, maxLevels = 3) {
    const normalized = normalizeRemotePosixPath(remotePath);
    if (normalized === '/') return [];

    const parents = [];
    let current = normalized;
    for (let i = 0; i < maxLevels; i++) {
        const lastSlash = current.lastIndexOf('/');
        const parent = lastSlash <= 0 ? '/' : current.slice(0, lastSlash);
        parents.push(parent);
        if (parent === '/') break;
        current = parent;
    }
    return parents;
}

/**
 * POSIX single-quote escaping for safely writing paths into an interactive remote PTY.
 */
export function escapePosixSingleQuote(value) {
    return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}
