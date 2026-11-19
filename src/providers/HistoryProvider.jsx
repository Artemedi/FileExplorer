import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const MAX_HISTORY_ENTRIES = 100;

const loadInitialNavState = () => {
    try {
        const rawHistory = sessionStorage.getItem('fileExplorerHistory');
        const parsed = JSON.parse(rawHistory || '[]');
        if (!Array.isArray(parsed) || parsed.length === 0) {
            return { entries: [], index: -1 };
        }

        const validEntries = parsed.filter(item => typeof item === 'string' && item.length > 0);
        if (validEntries.length === 0) {
            return { entries: [], index: -1 };
        }

        const savedIndex = parseInt(sessionStorage.getItem('fileExplorerHistoryIndex') || '-1', 10);
        let entries = validEntries;
        let index = (Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < entries.length)
            ? savedIndex
            : entries.length - 1;

        if (entries.length > MAX_HISTORY_ENTRIES) {
            const overflow = entries.length - MAX_HISTORY_ENTRIES;
            entries = entries.slice(overflow);
            index = Math.max(0, index - overflow);
        }

        return { entries, index };
    } catch (error) {
        console.error('Failed to load navigation history:', error);
        return { entries: [], index: -1 };
    }
};

// Create history context
export const HistoryContext = createContext({
    history: [],
    currentIndex: -1,
    currentPath: null,
    canGoBack: false,
    canGoForward: false,
    navigateTo: () => {},
    goBack: () => {},
    goForward: () => {},
    revertToPath: () => {},
});

export default function HistoryProvider({ children }) {
    // Synchronous lazy initialization to avoid race with child providers on mount
    const [navState, setNavState] = useState(loadInitialNavState);
    const { entries: history, index: currentIndex } = navState;

    // Derived state
    const currentPath = history[currentIndex] || null;
    const canGoBack = currentIndex > 0;
    const canGoForward = currentIndex < history.length - 1;

    // Save history to session storage when it changes
    useEffect(() => {
        if (history.length > 0) {
            try {
                sessionStorage.setItem('fileExplorerHistory', JSON.stringify(history));
                sessionStorage.setItem('fileExplorerHistoryIndex', currentIndex.toString());
            } catch (error) {
                console.warn('Failed to persist navigation history:', error);
            }
        }
    }, [history, currentIndex]);

    // Navigate to a specific path
    const navigateTo = useCallback((path) => {
        if (!path) return;

        setNavState(prev => {
            const activePath = prev.entries[prev.index] || null;
            if (path === activePath) return prev;

            const trimmed = prev.index >= 0 ? prev.entries.slice(0, prev.index + 1) : [];
            let nextEntries = [...trimmed, path];
            if (nextEntries.length > MAX_HISTORY_ENTRIES) {
                nextEntries = nextEntries.slice(nextEntries.length - MAX_HISTORY_ENTRIES);
            }
            return {
                entries: nextEntries,
                index: nextEntries.length - 1,
            };
        });
    }, []);

    // Navigate back in history
    const goBack = useCallback(() => {
        setNavState(prev => (prev.index > 0 ? { ...prev, index: prev.index - 1 } : prev));
    }, []);

    // Navigate forward in history
    const goForward = useCallback(() => {
        setNavState(prev => (prev.index < prev.entries.length - 1 ? { ...prev, index: prev.index + 1 } : prev));
    }, []);

    // Revert index to a known-good path if a Back/Forward navigation target fails to load
    const revertToPath = useCallback((targetPath) => {
        if (!targetPath) return;
        setNavState(prev => {
            if (prev.entries[prev.index] === targetPath) return prev;
            const targetIndex = prev.entries.lastIndexOf(targetPath);
            if (targetIndex === -1) return prev;
            return { ...prev, index: targetIndex };
        });
    }, []);

    const contextValue = {
        history,
        currentIndex,
        currentPath,
        canGoBack,
        canGoForward,
        navigateTo,
        goBack,
        goForward,
        revertToPath,
    };

    return (
        <HistoryContext.Provider value={contextValue}>
            {children}
        </HistoryContext.Provider>
    );
}

// Custom hook for using the history context
export const useHistory = () => useContext(HistoryContext);
