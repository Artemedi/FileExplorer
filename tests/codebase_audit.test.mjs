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

test('every frontend invoke() references a registered Tauri command with camelCase params', () => {
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

    // Parse #[tauri::command] functions in src-tauri/src/commands/*.rs
    const commandParams = new Map();
    const rustCommandFiles = collectFiles(path.join(RUST_SRC_DIR, 'commands'), ['.rs']);
    for (const file of rustCommandFiles) {
        const content = fs.readFileSync(file, 'utf8');
        const fnRegex = /#\[tauri::command[^\]]*\]\s*pub\s+(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g;
        let match;
        while ((match = fnRegex.exec(content)) !== null) {
            const cmdName = match[1];
            const rawParams = match[2];
            const params = new Set();
            for (const part of rawParams.split(',')) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const pMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*:/);
                if (!pMatch) continue;
                const paramName = pMatch[1];
                if (paramName === 'state' || paramName === 'app' || paramName === 'window') continue;
                if (trimmed.includes('State<') || trimmed.includes('AppHandle') || trimmed.includes('Window')) continue;
                params.add(snakeToCamel(paramName));
            }
            commandParams.set(cmdName, params);
        }
    }

    // Scan all frontend files for invoke('command_name', { ... })
    const frontendFiles = collectFiles(SRC_DIR, ['.js', '.jsx', '.ts', '.tsx']);
    const failures = [];

    for (const file of frontendFiles) {
        const rawContent = fs.readFileSync(file, 'utf8');
        const content = rawContent
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/([^:])\/\/.*$/gm, '$1');
        const relPath = path.relative(ROOT_DIR, file);
        const invokeRegex = /invoke\(\s*['"]([a-zA-Z0-9_]+)['"]\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/g;
        let match;
        while ((match = invokeRegex.exec(content)) !== null) {
            const cmd = match[1];
            const argBlock = match[2];
            if (!registeredCommands.has(cmd)) {
                failures.push(`${relPath}: invokes unregistered command '${cmd}'`);
                continue;
            }
            if (argBlock && commandParams.has(cmd)) {
                const expectedParams = commandParams.get(cmd);
                // Extract top-level keys inside { key: val, shorthandKey, ... }
                const cleaned = argBlock
                    .replace(/\/\/.*$/gm, '')
                    .replace(/\/\*[\s\S]*?\*\//g, '');
                let depth = 0;
                let current = '';
                const entries = [];
                for (const ch of cleaned) {
                    if (ch === '{' || ch === '[' || ch === '(') depth++;
                    else if (ch === '}' || ch === ']' || ch === ')') depth--;
                    if (ch === ',' && depth === 0) {
                        entries.push(current.trim());
                        current = '';
                    } else {
                        current += ch;
                    }
                }
                if (current.trim()) entries.push(current.trim());

                for (const entry of entries) {
                    const keyMatch = entry.match(/^([a-zA-Z0-9_]+)(?:\s*:|$)/);
                    if (!keyMatch) continue;
                    const key = keyMatch[1];
                    if (key.includes('_')) {
                        failures.push(`${relPath}: invoke('${cmd}') passes snake_case param '${key}'`);
                    } else if (!expectedParams.has(key)) {
                        failures.push(`${relPath}: invoke('${cmd}') passes unexpected param '${key}' (expected: ${[...expectedParams].join(', ')})`);
                    }
                }
            }
        }
    }

    assert.deepEqual(failures, [], `IPC contract errors:\n${failures.join('\n')}`);
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
    assert.ok(!loadTemplatesBlock.includes('.unwrap()'), 'load_templates must not call .unwrap()');
});

test('i18n translation bundles define matching leaf keys', () => {
    const enText = fs.readFileSync(path.join(SRC_DIR, 'i18n', 'index.jsx'), 'utf8');
    assert.ok(enText.length > 0);
    const i18nFiles = fs.readdirSync(path.join(SRC_DIR, 'i18n')).filter(f => f.endsWith('.json'));
    if (i18nFiles.length >= 2) {
        const base = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'i18n', i18nFiles[0]), 'utf8'));
        const flattenKeys = (obj, prefix = '') =>
            Object.entries(obj).flatMap(([k, v]) =>
                v && typeof v === 'object' ? flattenKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
            );
        const expectedKeys = new Set(flattenKeys(base));
        for (const file of i18nFiles.slice(1)) {
            const curr = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'i18n', file), 'utf8'));
            const actualKeys = new Set(flattenKeys(curr));
            for (const key of expectedKeys) {
                assert.ok(actualKeys.has(key), `Translation file ${file} is missing key '${key}'`);
            }
        }
    }
});

test('package metadata versions are synchronized across manifests', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    const cargoToml = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml'), 'utf8');
    const constantsRs = fs.readFileSync(path.join(RUST_SRC_DIR, 'constants.rs'), 'utf8');

    const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const constVersion = constantsRs.match(/VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1];

    assert.equal(tauriConf.version, pkg.version, 'tauri.conf.json version must match package.json');
    assert.equal(cargoVersion, pkg.version, 'Cargo.toml version must match package.json');
    assert.equal(constVersion, pkg.version, 'constants.rs VERSION must match package.json');
});
