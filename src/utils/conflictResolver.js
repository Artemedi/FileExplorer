let activeHandler = null;

/**
 * Registers the UI modal handler for resolving copy/paste name conflicts.
 * @param {Function|null} handler
 */
export function registerConflictHandler(handler) {
    activeHandler = handler;
}

/**
 * Generates a default copy/backup name preserving file extension.
 * @param {string} name
 * @param {string} [suffix=' (copy)']
 * @returns {string}
 */
export function buildSuggestedName(name, suffix = ' (copy)') {
    const str = String(name || '');
    const dotIdx = str.lastIndexOf('.');
    if (dotIdx > 0) {
        return `${str.slice(0, dotIdx)}${suffix}${str.slice(dotIdx)}`;
    }
    return `${str}${suffix}`;
}

/**
 * Prompts the user to resolve a file/folder name conflict.
 * Falls back to 'rename_new' in headless/test environments without a mounted modal.
 * @param {{ itemName: string, sourcePath: string, destPath: string, isSameLocation?: boolean }} params
 * @returns {Promise<{ action: 'replace'|'rename_new'|'rename_original'|'skip', customName?: string }>}
 */
export function requestConflictResolution(params) {
    if (typeof activeHandler === 'function') {
        return activeHandler(params);
    }
    return Promise.resolve({
        action: 'rename_new',
        customName: buildSuggestedName(params.itemName, ' (copy)'),
    });
}
