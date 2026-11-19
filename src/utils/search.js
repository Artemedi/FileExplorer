import { invoke } from '@tauri-apps/api/core';
import { getFileName, joinPath, normalizePath } from './pathUtils.ts';

/**
 * Search options for configuring search behavior.
 * @typedef {Object} SearchOptions
 * @property {boolean} caseSensitive - Whether the search should be case-sensitive.
 * @property {boolean} matchWholeWord - Whether to match whole words only.
 * @property {boolean} useRegex - Whether to interpret the query as a regular expression.
 * @property {boolean} includeHidden - Whether to include hidden files in the search.
 * @property {Array<string>} fileTypes - File types to include in the search.
 * @property {string} searchIn - Directory to search in.
 */

/**
 * Default search options.
 * @type {SearchOptions}
 */
export const DEFAULT_SEARCH_OPTIONS = {
    caseSensitive: false,
    matchWholeWord: false,
    useRegex: false,
    includeHidden: false,
    fileTypes: [],
    searchIn: '/',
};

/**
 * Search for files and directories based on a query string.
 * @param {string} query - The search query.
 * @param {SearchOptions} options - Search options.
 * @returns {Promise<Object>} - Search results with files and directories.
 */
export const searchFiles = async (query, options = DEFAULT_SEARCH_OPTIONS) => {
    if (!query || query.trim() === '') {
        return { files: [], directories: [] };
    }

    try {
        const parsed = parseSearchQuery(query);
        const effectiveQuery = parsed.query || query.trim();
        const extensions = Array.isArray(options?.fileTypes) && options.fileTypes.length > 0
            ? options.fileTypes
            : parsed.options.fileTypes;

        const rawResults = extensions.length > 0
            ? await invoke('search_with_extension', { query: effectiveQuery, extensions })
            : await invoke('search', { query: effectiveQuery });

        const entries = Array.isArray(rawResults) ? rawResults : [];
        const includeHidden = Boolean(options?.includeHidden ?? parsed.options.includeHidden);

        const files = [];
        for (const item of entries) {
            const rawPath = Array.isArray(item) ? item[0] : item?.path;
            const score = Array.isArray(item) ? item[1] : (item?.score ?? 0);
            if (!rawPath || typeof rawPath !== 'string') continue;

            const normalizedItemPath = rawPath.includes('/') || rawPath.includes('\\')
                ? normalizePath(rawPath)
                : (options?.searchIn ? joinPath(options.searchIn, rawPath) : rawPath);
            const name = getFileName(normalizedItemPath) || normalizedItemPath;

            if (!includeHidden && name.startsWith('.')) {
                continue;
            }

            files.push({
                name,
                path: normalizedItemPath,
                score,
                is_symlink: false,
                size_in_bytes: 0,
                isDirectory: false,
            });
        }

        return { files, directories: [] };
    } catch (error) {
        console.error('Search error:', error);
        throw new Error(`Search failed: ${error?.message || error}`);
    }
};

/**
 * Parse a search query to extract special tokens.
 * @param {string} query - The raw search query.
 * @returns {Object} - Parsed query and extracted options.
 */
export const parseSearchQuery = (query) => {
    const options = { ...DEFAULT_SEARCH_OPTIONS };
    let cleanQuery = query.trim();

    // Extract file type filter
    const typeMatch = cleanQuery.match(/type:(\w+)/i);
    if (typeMatch) {
        options.fileTypes = [typeMatch[1].toLowerCase()];
        cleanQuery = cleanQuery.replace(typeMatch[0], '').trim();
    }

    // Extract case sensitivity
    if (cleanQuery.includes('case:sensitive')) {
        options.caseSensitive = true;
        cleanQuery = cleanQuery.replace('case:sensitive', '').trim();
    } else if (cleanQuery.includes('case:insensitive')) {
        options.caseSensitive = false;
        cleanQuery = cleanQuery.replace('case:insensitive', '').trim();
    }

    // Extract whole word matching
    if (cleanQuery.includes('word:whole')) {
        options.matchWholeWord = true;
        cleanQuery = cleanQuery.replace('word:whole', '').trim();
    }

    // Extract regex flag
    if (cleanQuery.includes('regex:true')) {
        options.useRegex = true;
        cleanQuery = cleanQuery.replace('regex:true', '').trim();
    }

    // Extract hidden files inclusion
    if (cleanQuery.includes('hidden:true')) {
        options.includeHidden = true;
        cleanQuery = cleanQuery.replace('hidden:true', '').trim();
    }

    return {
        query: cleanQuery,
        options,
    };
};

/**
 * Format a search query with given options.
 * @param {string} query - The raw search query.
 * @param {SearchOptions} options - Search options.
 * @returns {string} - Formatted search query with option tokens.
 */
export const formatSearchQuery = (query, options = DEFAULT_SEARCH_OPTIONS) => {
    const {
        caseSensitive,
        matchWholeWord,
        useRegex,
        includeHidden,
        fileTypes,
    } = options;

    let formattedQuery = query.trim();

    // Add options as tokens
    if (caseSensitive) {
        formattedQuery += ' case:sensitive';
    }

    if (matchWholeWord) {
        formattedQuery += ' word:whole';
    }

    if (useRegex) {
        formattedQuery += ' regex:true';
    }

    if (includeHidden) {
        formattedQuery += ' hidden:true';
    }

    if (fileTypes.length > 0) {
        formattedQuery += ` type:${fileTypes[0]}`;
    }

    return formattedQuery;
};