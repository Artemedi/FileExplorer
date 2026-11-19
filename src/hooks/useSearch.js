import { useState, useCallback, useEffect, useRef } from 'react';
import { searchFiles, parseSearchQuery, DEFAULT_SEARCH_OPTIONS } from '../utils/search';
import { useHistory } from '../providers/HistoryProvider';

const areFileTypesEqual = (a = [], b = []) => {
    if (a.length !== b.length) return false;
    return a.every((item, idx) => item === b[idx]);
};

const areOptionsEqual = (a, b) => (
    a.caseSensitive === b.caseSensitive &&
    a.matchWholeWord === b.matchWholeWord &&
    a.useRegex === b.useRegex &&
    a.includeHidden === b.includeHidden &&
    a.searchIn === b.searchIn &&
    areFileTypesEqual(a.fileTypes, b.fileTypes)
);

/**
 * Hook for handling file search functionality.
 * @param {Object} initialOptions - Initial search options.
 * @returns {Object} Search state and functions.
 */
const useSearch = (initialOptions = DEFAULT_SEARCH_OPTIONS) => {
    const [query, setQuery] = useState('');
    const [options, setOptions] = useState(() => ({ ...initialOptions }));
    const [results, setResults] = useState(null);
    const [isSearching, setIsSearching] = useState(false);
    const [error, setError] = useState(null);
    const { currentPath } = useHistory();

    const queryRef = useRef(query);
    const optionsRef = useRef(options);
    queryRef.current = query;
    optionsRef.current = options;

    // Update searchIn option when current path changes
    useEffect(() => {
        if (currentPath) {
            setOptions(prev => {
                if (prev.searchIn === currentPath) return prev;
                const next = { ...prev, searchIn: currentPath };
                optionsRef.current = next;
                return next;
            });
        }
    }, [currentPath]);

    // Parse search query and update options without wiping user flags or creating redundant objects
    const updateQuery = useCallback((newQuery) => {
        const nextQuery = newQuery ?? '';
        queryRef.current = nextQuery;
        setQuery(nextQuery);

        if (!nextQuery.trim()) {
            setResults(null);
            return;
        }

        // Parse the query to extract only tokens explicitly present in the string
        const parsed = parseSearchQuery(nextQuery);

        setOptions(prev => {
            const next = { ...prev };
            if (/\btype:\w+/i.test(nextQuery)) {
                next.fileTypes = parsed.options.fileTypes;
            }
            if (nextQuery.includes('case:sensitive') || nextQuery.includes('case:insensitive')) {
                next.caseSensitive = parsed.options.caseSensitive;
            }
            if (nextQuery.includes('word:whole')) {
                next.matchWholeWord = parsed.options.matchWholeWord;
            }
            if (nextQuery.includes('regex:true')) {
                next.useRegex = parsed.options.useRegex;
            }
            if (nextQuery.includes('hidden:true')) {
                next.includeHidden = parsed.options.includeHidden;
            }
            if (areOptionsEqual(prev, next)) {
                return prev;
            }
            optionsRef.current = next;
            return next;
        });
    }, []);

    // Perform search with current (or overridden) query and options
    const performSearch = useCallback(async (overrideQuery, overrideOptions) => {
        const activeQuery = overrideQuery !== undefined ? overrideQuery : queryRef.current;
        const activeOptions = overrideOptions !== undefined ? overrideOptions : optionsRef.current;

        if (!activeQuery || !activeQuery.trim()) {
            setResults(null);
            return;
        }

        setIsSearching(true);
        setError(null);

        try {
            const searchResults = await searchFiles(activeQuery, activeOptions);
            setResults(searchResults);
        } catch (err) {
            console.error('Search failed:', err);
            setError(err.message || 'Search failed');
            setResults(null);
        } finally {
            setIsSearching(false);
        }
    }, []);

    // Clear search results
    const clearSearch = useCallback(() => {
        queryRef.current = '';
        setQuery('');
        setResults(null);
        setError(null);
    }, []);

    // Update a single search option
    const updateOption = useCallback((key, value) => {
        setOptions(prev => {
            if (prev[key] === value) return prev;
            const next = {
                ...prev,
                [key]: value,
            };
            optionsRef.current = next;
            return next;
        });
    }, []);

    return {
        query,
        options,
        results,
        isSearching,
        error,
        updateQuery,
        performSearch,
        clearSearch,
        updateOption,
    };
};

export default useSearch;