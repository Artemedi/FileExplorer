import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    detectPathSeparator,
    getDirectoryPath,
    getFileName,
    replaceFileName,
    joinPath,
    normalizePath,
    isRootPath,
} from '../src/utils/pathUtils.ts';

import {
    formatFileSize,
    formatDate,
    getFileType,
    formatErrorMessage,
} from '../src/utils/formatters.ts';

import {
    getFileIconType,
    getFolderIconType,
} from '../src/utils/icons.js';

import {
    isMultiSelectKey,
    isRangeSelectKey,
    formatShortcut,
    handleNavigation,
} from '../src/utils/keyboard.js';

import {
    parseSearchQuery,
    formatSearchQuery,
} from '../src/utils/search.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const RUST_SRC_DIR = path.join(ROOT_DIR, 'src-tauri', 'src');

function collectFiles(dir, extensions) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectFiles(fullPath, extensions));
        } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
            results.push(fullPath);
        }
    }
    return results;
}

function snakeToCamel(snake) {
    return snake.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

function splitRustParams(str) {
    const parts = [];
    let depthAngle = 0;
    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;
    let current = '';

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '<') depthAngle++;
        else if (ch === '>' && depthAngle > 0) depthAngle--;
        else if (ch === '(') depthParen++;
        else if (ch === ')' && depthParen > 0) depthParen--;
        else if (ch === '[') depthBracket++;
        else if (ch === ']' && depthBracket > 0) depthBracket--;
        else if (ch === '{') depthBrace++;
        else if (ch === '}' && depthBrace > 0) depthBrace--;

        if (ch === ',' && depthAngle === 0 && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
            if (current.trim()) parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function stripJsComments(src) {
    let out = '';
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];

        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
                out += ch;
            }
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (!inSingle && !inDouble && !inTemplate) {
            if (ch === '/' && next === '/') {
                inLineComment = true;
                i++;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i++;
                continue;
            }
        }
        if (ch === '\\' && (inSingle || inDouble || inTemplate)) {
            out += ch + (src[i + 1] || '');
            i++;
            continue;
        }
        if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
        else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
        else if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate;
        out += ch;
    }
    return out;
}

function stripRustComments(src) {
    let out = '';
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];

        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
                out += ch;
            }
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (!inDouble) {
            if (ch === '/' && next === '/') {
                inLineComment = true;
                i++;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i++;
                continue;
            }
        }
        if (ch === '\\' && inDouble) {
            out += ch + (src[i + 1] || '');
            i++;
            continue;
        }
        if (ch === '"') inDouble = !inDouble;
        out += ch;
    }
    return out;
}

function splitJsTopLevel(str) {
    const parts = [];
    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let current = '';

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '\\' && (inSingle || inDouble || inTemplate)) {
            current += ch + (str[i + 1] || '');
            i++;
            continue;
        }
        if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
        else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
        else if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate;
        else if (!inSingle && !inDouble && !inTemplate) {
            if (ch === '(') depthParen++;
            else if (ch === ')' && depthParen > 0) depthParen--;
            else if (ch === '[') depthBracket++;
            else if (ch === ']' && depthBracket > 0) depthBracket--;
            else if (ch === '{') depthBrace++;
            else if (ch === '}' && depthBrace > 0) depthBrace--;
        }

        if (!inSingle && !inDouble && !inTemplate && ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
            if (current.trim()) parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function findCallArgumentBlocks(content, fnNameRegex) {
    const calls = [];
    let match;
    while ((match = fnNameRegex.exec(content)) !== null) {
        let idx = match.index + match[0].length;
        // Skip whitespace
        while (idx < content.length && /\s/.test(content[idx])) idx++;
        // Skip optional TypeScript generic type parameters <...>
        if (content[idx] === '<') {
            let angleDepth = 1;
            let inS = false;
            let inD = false;
            let inT = false;
            idx++;
            while (idx < content.length && angleDepth > 0) {
                const ch = content[idx];
                if (ch === '\\' && (inS || inD || inT)) {
                    idx += 2;
                    continue;
                }
                if (ch === "'" && !inD && !inT) inS = !inS;
                else if (ch === '"' && !inS && !inT) inD = !inD;
                else if (ch === '`' && !inS && !inD) inT = !inT;
                else if (!inS && !inD && !inT) {
                    if (ch === '<') angleDepth++;
                    else if (ch === '>' && content[idx - 1] !== '=') angleDepth--;
                }
                idx++;
            }
            if (angleDepth !== 0) continue;
            while (idx < content.length && /\s/.test(content[idx])) idx++;
        }
        if (content[idx] !== '(') continue;
        idx++; // step past '('

        let depth = 1;
        let inS = false;
        let inD = false;
        let inT = false;
        let argsStr = '';
        for (; idx < content.length && depth > 0; idx++) {
            const ch = content[idx];
            if (ch === '\\' && (inS || inD || inT)) {
                argsStr += ch + (content[idx + 1] || '');
                idx++;
                continue;
            }
            if (ch === "'" && !inD && !inT) inS = !inS;
            else if (ch === '"' && !inS && !inT) inD = !inD;
            else if (ch === '`' && !inS && !inD) inT = !inT;
            else if (!inS && !inD && !inT) {
                if (ch === '(') depth++;
                else if (ch === ')') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            argsStr += ch;
        }
        if (depth === 0) {
            calls.push(splitJsTopLevel(argsStr));
        }
    }
    return calls;
}

// ============================================================================
// 1. Utility Unit Tests
// ============================================================================

test('pathUtils handles Windows, Unix, mixed, and root paths accurately', () => {
    assert.equal(detectPathSeparator('C:\\Users\\Artem'), '\\');
    assert.equal(detectPathSeparator('/home/user'), '/');
    assert.equal(detectPathSeparator(null), '/');

    assert.equal(getDirectoryPath('/home/user/doc.txt'), '/home/user');
    assert.equal(getDirectoryPath('/doc.txt'), '/');
    assert.equal(getDirectoryPath('C:\\Users\\Artem\\doc.txt'), 'C:\\Users\\Artem');
    assert.equal(getDirectoryPath('C:\\doc.txt'), 'C:\\');
    assert.equal(getDirectoryPath('C:\\Users\\Artem/doc.txt'), 'C:\\Users\\Artem');
    assert.equal(getDirectoryPath(''), '');

    assert.equal(getFileName('/home/user/doc.txt'), 'doc.txt');
    assert.equal(getFileName('C:\\Users\\Artem\\doc.txt'), 'doc.txt');
    assert.equal(getFileName('C:\\Users\\Artem\\'), 'Artem');
    assert.equal(getFileName('single.txt'), 'single.txt');
    assert.equal(getFileName(undefined), '');

    assert.equal(replaceFileName('/home/user/a.txt', 'b.txt'), '/home/user/b.txt');
    assert.equal(replaceFileName('C:\\a.txt', 'b.txt'), 'C:\\b.txt');

    assert.equal(joinPath('/home', 'user', 'docs'), '/home/user/docs');
    assert.equal(joinPath('C:\\Users', 'Artem', 'file.txt'), 'C:\\Users\\Artem\\file.txt');
    assert.equal(joinPath('/'), '/');
    assert.equal(joinPath('C:\\'), 'C:\\');
    assert.equal(joinPath('foo', 'bar\\baz'), 'foo\\bar\\baz');

    assert.equal(normalizePath('/home//user///docs/'), '/home/user/docs');
    assert.equal(normalizePath('\\\\server\\share\\\\folder'), '\\\\server\\share\\folder');
    assert.equal(normalizePath('C:\\'), 'C:\\');

    assert.equal(isRootPath('/'), true);
    assert.equal(isRootPath('C:\\'), true);
    assert.equal(isRootPath('D:/'), true);
    assert.equal(isRootPath('C:\\Users'), false);
});

test('formatters handle edge cases, errors, sizes, and types cleanly', () => {
    assert.equal(formatFileSize(0), '0 Bytes');
    assert.equal(formatFileSize(-10), '0 Bytes');
    assert.equal(formatFileSize(Number.NaN), '0 Bytes');
    assert.equal(formatFileSize(0.5), '0.5 Bytes');
    assert.equal(formatFileSize(1024), '1 KB');
    assert.equal(formatFileSize(1536, 1), '1.5 KB');

    assert.equal(formatDate(null), 'Unknown');
    assert.equal(formatDate('not-a-date'), 'Invalid date');
    assert.ok(formatDate('2026-01-15T12:00:00Z').includes('2026'));

    assert.equal(getFileType('report.pdf'), 'PDF Document');
    assert.equal(getFileType('main.rs'), 'Rust File');
    assert.equal(getFileType('README'), 'File');

    assert.equal(formatErrorMessage(null), 'An unknown error occurred');
    assert.equal(formatErrorMessage('{"custom_message":"Access denied"}'), 'Access denied');
    assert.equal(formatErrorMessage('Prefix: {"message":"Inner error"}'), 'Prefix: Inner error');
    assert.equal(formatErrorMessage(new Error('Boom')), 'Boom');
});

test('icons handle extensions and cross-platform folder names', () => {
    assert.equal(getFileIconType('photo.PNG'), 'image');
    assert.equal(getFileIconType('app.tsx'), 'code');
    assert.equal(getFileIconType('archive.zip'), 'archive');
    assert.equal(getFileIconType('doc.pdf'), 'pdf');
    assert.equal(getFileIconType('noext'), 'default');

    assert.equal(getFolderIconType('/home/artem/Downloads'), 'downloads');
    assert.equal(getFolderIconType('C:\\Users\\Artem\\Documents\\'), 'documents');
    assert.equal(getFolderIconType('C:\\Projects\\node_modules'), 'node');
    assert.equal(getFolderIconType('custom_folder'), 'folder');
});

test('keyboard and search utilities work cleanly', () => {
    assert.equal(isMultiSelectKey({ ctrlKey: true, metaKey: false }), true);
    assert.equal(isMultiSelectKey({ ctrlKey: false, metaKey: true }), true);
    assert.equal(isRangeSelectKey({ shiftKey: true }), true);
    assert.equal(formatShortcut('Control+Shift+ArrowUp'), 'Ctrl+Shift+↑');

    const items = [0, 1, 2, 3, 4, 5];
    assert.equal(handleNavigation({ key: 'ArrowDown' }, items, 1, { isGrid: true, columnsPerRow: 4 }), 5);
    assert.equal(handleNavigation({ key: 'ArrowDown' }, items, 5, { isGrid: true, columnsPerRow: 4, wraparound: false }), 5);
    assert.equal(handleNavigation({ key: 'Home' }, items, 4), 0);
    assert.equal(handleNavigation({ key: 'End' }, items, 0), 5);

    const parsed = parseSearchQuery('report type:pdf case:sensitive word:whole');
    assert.equal(parsed.query, 'report');
    assert.deepEqual(parsed.options.fileTypes, ['pdf']);
    assert.equal(parsed.options.caseSensitive, true);
    assert.equal(parsed.options.matchWholeWord, true);

    const formatted = formatSearchQuery('report', parsed.options);
    assert.ok(formatted.includes('case:sensitive'));
    assert.ok(formatted.includes('word:whole'));
    assert.ok(formatted.includes('type:pdf'));
});

// ============================================================================
// 2. Frontend-Backend Tauri IPC Contract Verification
// ============================================================================

test('Tauri commands, invoke() signatures/required params, and emit()/listen() contracts are consistent', () => {
    const mainRs = fs.readFileSync(path.join(RUST_SRC_DIR, 'main.rs'), 'utf8');
    const registeredCommands = new Set();
    const handlerMatch = mainRs.match(/generate_handler!\[([\s\S]*?)\]/);
    assert.ok(handlerMatch, 'Could not locate generate_handler![] in main.rs');

    for (const rawLine of handlerMatch[1].split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//')) continue;
        const cmdMatch = line.match(/([a-zA-Z0-9_]+)\s*,?\s*$/);
        if (cmdMatch) {
            registeredCommands.add(cmdMatch[1]);
        }
    }
    assert.ok(registeredCommands.has('open_file'), 'open_file must be registered in main.rs');

    const UNREGISTERED_COMMAND_ALLOWLIST = new Set([]);

    // Parse #[tauri::command] functions across src-tauri/src/**/*.rs
    const definedCommands = new Set();
    const commandSpecs = new Map();
    const rustSrcFiles = collectFiles(RUST_SRC_DIR, ['.rs']);

    for (const file of rustSrcFiles) {
        const content = stripRustComments(fs.readFileSync(file, 'utf8'));
        const fnRegex = /#\[tauri::command[^\]]*\]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g;
        let match;
        while ((match = fnRegex.exec(content)) !== null) {
            const cmdName = match[1];
            const rawParams = match[2];
            definedCommands.add(cmdName);

            const allParams = new Set();
            const requiredParams = new Set();
            for (const part of splitRustParams(rawParams)) {
                const colonIdx = part.indexOf(':');
                if (colonIdx === -1) continue;
                const paramName = part.slice(0, colonIdx).trim();
                const paramType = part.slice(colonIdx + 1).trim();
                if (paramName === 'state' || paramName === 'app' || paramName === 'window') continue;
                if (/^(?:tauri::)?(?:State|AppHandle|Window|WebviewWindow)\b/.test(paramType) || paramType.includes('State<')) {
                    continue;
                }
                const camelName = snakeToCamel(paramName);
                allParams.add(camelName);
                if (!/^Option\s*</.test(paramType)) {
                    requiredParams.add(camelName);
                }
            }
            commandSpecs.set(cmdName, { allParams, requiredParams });
        }
    }

    const contractFailures = [];

    // Bidirectional check: generate_handler![] <-> #[tauri::command]
    for (const regCmd of registeredCommands) {
        if (!definedCommands.has(regCmd)) {
            contractFailures.push(`main.rs: generate_handler![] registers '${regCmd}' which has no #[tauri::command] definition`);
        }
    }
    for (const defCmd of definedCommands) {
        if (!registeredCommands.has(defCmd) && !UNREGISTERED_COMMAND_ALLOWLIST.has(defCmd)) {
            contractFailures.push(`Rust commands: #[tauri::command] '${defCmd}' is not registered in main.rs generate_handler![]`);
        }
    }

    // Scan all frontend files for invoke(...) / invoke<T>(...)
    const frontendFiles = collectFiles(SRC_DIR, ['.js', '.jsx', '.ts', '.tsx']);
    for (const file of frontendFiles) {
        const content = stripJsComments(fs.readFileSync(file, 'utf8'));
        const relPath = path.relative(ROOT_DIR, file);
        const invokeCalls = findCallArgumentBlocks(content, /\binvoke\b/g);

        for (const args of invokeCalls) {
            if (args.length === 0) continue;
            const cmdMatch = args[0].match(/^['"]([a-zA-Z0-9_]+)['"]$/);
            if (!cmdMatch) continue;
            const cmd = cmdMatch[1];

            if (!registeredCommands.has(cmd)) {
                contractFailures.push(`${relPath}: invokes unregistered command '${cmd}'`);
                continue;
            }
            if (!commandSpecs.has(cmd)) continue;

            const { allParams, requiredParams } = commandSpecs.get(cmd);
            const providedParams = new Set();
            let hasDynamicOrSpread = false;

            if (args.length >= 2) {
                const payload = args[1].trim();
                if (payload.startsWith('{') && payload.endsWith('}')) {
                    const inner = payload.slice(1, -1);
                    for (const entry of splitJsTopLevel(inner)) {
                        if (entry.startsWith('...')) {
                            hasDynamicOrSpread = true;
                            continue;
                        }
                        const keyMatch = entry.match(/^([a-zA-Z0-9_]+)(?:\s*:|$)/);
                        if (!keyMatch) continue;
                        const key = keyMatch[1];
                        providedParams.add(key);
                        if (key.includes('_')) {
                            contractFailures.push(`${relPath}: invoke('${cmd}') passes snake_case param '${key}'`);
                        } else if (!allParams.has(key)) {
                            contractFailures.push(`${relPath}: invoke('${cmd}') passes unexpected param '${key}' (expected: ${[...allParams].join(', ')})`);
                        }
                    }
                } else {
                    hasDynamicOrSpread = true;
                }
            }

            if (!hasDynamicOrSpread) {
                for (const reqParam of requiredParams) {
                    if (!providedParams.has(reqParam)) {
                        contractFailures.push(`${relPath}: invoke('${cmd}') is missing required param '${reqParam}'`);
                    }
                }
            }
        }
    }

    // Event contracts: Rust emit(...) <-> Frontend listen(...)
    const emittedEvents = new Set();
    for (const file of rustSrcFiles) {
        const content = stripRustComments(fs.readFileSync(file, 'utf8'));
        const emitRegex = /(?:\.|::)(emit|emit_all|emit_to)\s*\(/g;
        let match;
        while ((match = emitRegex.exec(content)) !== null) {
            const method = match[1];
            let idx = match.index + match[0].length;
            let depth = 1;
            let inD = false;
            let argsStr = '';
            for (; idx < content.length && depth > 0; idx++) {
                const ch = content[idx];
                if (ch === '\\' && inD) {
                    argsStr += ch + (content[idx + 1] || '');
                    idx++;
                    continue;
                }
                if (ch === '"') inD = !inD;
                else if (!inD) {
                    if (ch === '(') depth++;
                    else if (ch === ')') {
                        depth--;
                        if (depth === 0) break;
                    }
                }
                argsStr += ch;
            }
            const args = splitRustParams(argsStr);
            const eventArg = method === 'emit_to' ? args[1] : args[0];
            const eventMatch = eventArg?.match(/^"([^"]+)"$/);
            if (eventMatch) {
                emittedEvents.add(eventMatch[1]);
            }
        }
    }

    const listenedEvents = new Set();
    for (const file of frontendFiles) {
        const content = stripJsComments(fs.readFileSync(file, 'utf8'));
        const listenCalls = findCallArgumentBlocks(content, /\b(?:listen|once)\b/g);
        for (const args of listenCalls) {
            if (args.length === 0) continue;
            const eventMatch = args[0].match(/^['"]([^'"]+)['"]$/);
            if (eventMatch) {
                listenedEvents.add(eventMatch[1]);
            }
        }
    }

    assert.ok(emittedEvents.size > 0, 'Expected at least one backend emit() event');
    for (const ev of emittedEvents) {
        if (!listenedEvents.has(ev)) {
            contractFailures.push(`Backend emits event '${ev}' which has no frontend listen() subscriber`);
        }
    }
    for (const ev of listenedEvents) {
        if (ev.startsWith('tauri://')) continue;
        if (!emittedEvents.has(ev)) {
            contractFailures.push(`Frontend listens for event '${ev}' which is never emitted by the Rust backend`);
        }
    }

    assert.deepEqual(contractFailures, [], `IPC / Event contract errors:\n${contractFailures.join('\n')}`);
});

// ============================================================================
// 3. Static React, Browser Compatibility & Audit Regression Assertions
// ============================================================================

test('frontend sources contain no Node globals, <style jsx>, or broken hook context imports', () => {
    const frontendFiles = collectFiles(SRC_DIR, ['.js', '.jsx', '.ts', '.tsx']);
    const errors = [];

    for (const file of frontendFiles) {
        const rawContent = fs.readFileSync(file, 'utf8');
        const content = rawContent
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/([^:])\/\/.*$/gm, '$1');
        const relPath = path.relative(ROOT_DIR, file);
        if (/\bprocess\.(platform|env|argv|cwd)\b/.test(content)) {
            errors.push(`${relPath}: contains Node global 'process.*'`);
        }
        if (/<style\s+jsx\b/.test(content)) {
            errors.push(`${relPath}: contains unsupported '<style jsx>'`);
        }
    }

    // Hook provider exports
    const hookFiles = ['FileSystemProvider.jsx', 'ContextMenuProvider.jsx', 'SettingsProvider.jsx', 'HistoryProvider.jsx', 'ThemeProvider.jsx'];
    for (const provider of hookFiles) {
        const text = fs.readFileSync(path.join(SRC_DIR, 'providers', provider), 'utf8');
        if (!/export\s+const\s+\w+Context\s*=/.test(text)) {
            errors.push(`providers/${provider}: must export Context object for src/hooks/`);
        }
    }

    const useViewModeText = fs.readFileSync(path.join(SRC_DIR, 'hooks', 'useViewMode.js'), 'utf8');
    if (useViewModeText.includes('defaultView')) {
        errors.push('hooks/useViewMode.js: still uses wrong key defaultView instead of default_view');
    }

    const useSettingsText = fs.readFileSync(path.join(SRC_DIR, 'hooks', 'useSettings.js'), 'utf8');
    if (!/export\s*\{[^}]*useSettings[^}]*\}/.test(useSettingsText)) {
        errors.push('hooks/useSettings.js: must provide named export useSettings');
    }

    assert.deepEqual(errors, [], `Static frontend checks failed:\n${errors.join('\n')}`);
});

test('targeted audit fixes remain intact across frontend and Rust backend', () => {
    // Frontend regression guards
    const mainLayout = fs.readFileSync(path.join(SRC_DIR, 'layouts', 'MainLayout.jsx'), 'utf8');
    assert.match(mainLayout, /\buseMemo\b/, 'MainLayout.jsx must import useMemo');

    const fileItem = fs.readFileSync(path.join(SRC_DIR, 'components', 'explorer', 'FileItem.jsx'), 'utf8');
    assert.match(fileItem, /\bshowSuccess\b/, 'FileItem.jsx must import showSuccess');
    assert.match(fileItem, /show_file_extensions/, 'FileItem.jsx must honor show_file_extensions');

    const sidebar = fs.readFileSync(path.join(SRC_DIR, 'components', 'sidebar', 'Sidebar.jsx'), 'utf8');
    assert.ok(!sidebar.includes('COnnection'), 'Sidebar.jsx must not have COnnection typo');
    assert.ok(!sidebar.includes("'${name}'"), 'Sidebar.jsx must use template string for SFTP removal');
    assert.ok(!sidebar.includes("'fileExplorerHistory'"), 'Sidebar.jsx must use fileExplorerRecentPaths instead of clobbering HistoryProvider');

    const contextMenuProvider = fs.readFileSync(path.join(SRC_DIR, 'providers', 'ContextMenuProvider.jsx'), 'utf8');
    assert.ok(!contextMenuProvider.includes("'fileExplorerHistory'"), 'ContextMenuProvider.jsx must not clobber HistoryProvider storage key');
    assert.match(contextMenuProvider, /overrideSelectedItems/, 'ContextMenuProvider must support overrideSelectedItems');
    assert.match(contextMenuProvider, /confirm_delete/, 'ContextMenuProvider must respect settings.confirm_delete');

    const settingsProvider = fs.readFileSync(path.join(SRC_DIR, 'providers', 'SettingsProvider.jsx'), 'utf8');
    assert.match(settingsProvider, /reset_settings_command/, 'SettingsProvider must call reset_settings_command');

    const hashModal = fs.readFileSync(path.join(SRC_DIR, 'components', 'common', 'HashFileModal.jsx'), 'utf8');
    assert.ok(!/\[isOpen,\s*item,\s*fileName\]/.test(hashModal), 'HashFileModal effect must not depend on fileName');

    // Backend regression guards
    const settingsDataRs = fs.readFileSync(path.join(RUST_SRC_DIR, 'state', 'settings_data.rs'), 'utf8');
    assert.ok(settingsDataRs.includes('Ascending,'), 'settings_data.rs must define SortDirection::Ascending');
    assert.ok(settingsDataRs.includes('#[serde(alias = "Acscending")]'), 'settings_data.rs must keep serde alias for legacy Acscending');
    assert.ok(settingsDataRs.includes('#[serde(alias = "Modified")]'), 'settings_data.rs must support Modified alias on SortBy::Date');
    assert.ok(settingsDataRs.includes('resolve_setting_key'), 'settings_data.rs must resolve flat nested keys');

    const previewRs = fs.readFileSync(path.join(RUST_SRC_DIR, 'commands', 'preview_commands.rs'), 'utf8');
    const sftpRs = fs.readFileSync(path.join(RUST_SRC_DIR, 'commands', 'sftp_file_system_operation_commands.rs'), 'utf8');
    assert.ok(previewRs.includes('is_char_boundary'), 'preview_commands.rs must use UTF-8 char-boundary safe truncation');
    assert.ok(sftpRs.includes('is_char_boundary'), 'sftp_file_system_operation_commands.rs must use UTF-8 char-boundary safe truncation');

    const fsOpsRs = fs.readFileSync(path.join(RUST_SRC_DIR, 'commands', 'file_system_operation_commands.rs'), 'utf8');
    assert.ok(fsOpsRs.includes('create_new(true)'), 'create_file must use create_new(true) to avoid truncating existing files');

    const metaDataRs = fs.readFileSync(path.join(RUST_SRC_DIR, 'state', 'meta_data.rs'), 'utf8');
    const loadTemplatesBlock = metaDataRs.match(/fn load_templates[\s\S]*?\n\}/)?.[0] || '';
    assert.ok(loadTemplatesBlock.length > 0, 'Could not locate load_templates in meta_data.rs');
    assert.ok(!loadTemplatesBlock.includes('.unwrap()'), 'load_templates must not call .unwrap()');
});

test('i18n translation bundles define symmetric leaf keys', () => {
    const i18nDir = path.join(SRC_DIR, 'i18n');
    const enText = fs.readFileSync(path.join(i18nDir, 'index.jsx'), 'utf8');
    assert.ok(enText.length > 0);
    const i18nFiles = fs.readdirSync(i18nDir).filter((f) => f.endsWith('.json'));
    assert.ok(i18nFiles.includes('en.json'), 'src/i18n/en.json must exist');
    assert.ok(i18nFiles.includes('ru.json'), 'src/i18n/ru.json must exist');

    const flattenKeys = (obj, prefix = '') =>
        Object.entries(obj).flatMap(([k, v]) =>
            v && typeof v === 'object' && !Array.isArray(v) ? flattenKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
        );

    const keySets = new Map();
    for (const file of i18nFiles) {
        const parsed = JSON.parse(fs.readFileSync(path.join(i18nDir, file), 'utf8'));
        const keys = new Set(flattenKeys(parsed));
        assert.ok(keys.size > 0, `Translation file ${file} must not be empty`);
        keySets.set(file, keys);
    }

    const baseFile = 'en.json';
    const baseKeys = keySets.get(baseFile);
    for (const [file, keys] of keySets.entries()) {
        if (file === baseFile) continue;
        for (const key of baseKeys) {
            assert.ok(keys.has(key), `Translation file ${file} is missing key '${key}' present in ${baseFile}`);
        }
        for (const key of keys) {
            assert.ok(baseKeys.has(key), `Translation file ${file} has extra key '${key}' missing from ${baseFile}`);
        }
    }
});

test('package metadata versions, lockfile, and packaging scripts are synchronized', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    const pkgLock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package-lock.json'), 'utf8'));
    const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    const cargoToml = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml'), 'utf8');
    const constantsRs = fs.readFileSync(path.join(RUST_SRC_DIR, 'constants.rs'), 'utf8');
    const postBuildSh = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'scripts', 'post-build.sh'), 'utf8');
    const buildUniversalSh = fs.readFileSync(path.join(ROOT_DIR, 'build-universal.sh'), 'utf8');

    const cargoPkgSection = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] || cargoToml;
    const cargoBinName = cargoPkgSection.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const cargoVersion = cargoPkgSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const constVersion = constantsRs.match(/VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1];

    assert.equal(cargoBinName, 'explr', 'Cargo.toml package name must be explr');
    assert.equal(tauriConf.version, pkg.version, 'tauri.conf.json version must match package.json');
    assert.equal(cargoVersion, pkg.version, 'Cargo.toml version must match package.json');
    assert.equal(constVersion, pkg.version, 'constants.rs VERSION must match package.json');

    // package-lock.json sync checks
    assert.equal(pkgLock.version, pkg.version, 'package-lock.json top-level version must match package.json');
    assert.equal(pkgLock.packages?.['']?.version, pkg.version, 'package-lock.json root package version must match package.json');
    assert.deepEqual(
        Object.keys(pkgLock.packages?.['']?.dependencies || {}).sort(),
        Object.keys(pkg.dependencies || {}).sort(),
        'package-lock.json dependencies must match package.json'
    );
    assert.deepEqual(
        Object.keys(pkgLock.packages?.['']?.devDependencies || {}).sort(),
        Object.keys(pkg.devDependencies || {}).sort(),
        'package-lock.json devDependencies must match package.json'
    );

    // Packaging script checks (BUG-038)
    assert.ok(!postBuildSh.includes('src-tauri-real'), 'post-build.sh must not reference old src-tauri-real binary');
    assert.ok(!postBuildSh.includes('$MACOS_DIR/src-tauri'), 'post-build.sh must not wrap $MACOS_DIR/src-tauri');
    assert.ok(!postBuildSh.includes('0.2.3'), 'post-build.sh must not hardcode version 0.2.3');
    assert.ok(postBuildSh.includes('Cargo.toml') && postBuildSh.includes('tauri.conf.json'), 'post-build.sh must read binary/version dynamically from Cargo.toml and tauri.conf.json');
    assert.ok(postBuildSh.includes('BIN_NAME') && postBuildSh.includes('APP_VERSION'), 'post-build.sh must use dynamic BIN_NAME and APP_VERSION');

    assert.ok(!buildUniversalSh.includes('VERSION="0.2.3"'), 'build-universal.sh must not hardcode VERSION="0.2.3"');
    assert.ok(!buildUniversalSh.includes('file-explorer.app'), 'build-universal.sh must not reference file-explorer.app');
    assert.ok(buildUniversalSh.includes('tauri.conf.json') && buildUniversalSh.includes('Cargo.toml'), 'build-universal.sh must read app metadata dynamically');

    assert.match(
        pkg.scripts?.['tauri:build:intel'] || '',
        /CARGO_CFG_TARGET_ARCH=x86_64/,
        'package.json tauri:build:intel must pass CARGO_CFG_TARGET_ARCH=x86_64'
    );
});
