import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

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
});

export default function HistoryProvider({ children }) {
    // Atomic state for navigation history to avoid index/array desync
    const [navState, setNavState] = useState({ entries: [], index: -1 });
    const { entries: history, index: currentIndex } = navState;

    // Derived state
    const currentPath = history[currentIndex] || null;
    const canGoBack = currentIndex > 0;
    const canGoForward = currentIndex < history.length - 1;

    // Load history from session storage on mount
    useEffect(() => {
        try {
            const savedHistory = JSON.parse(sessionStorage.getItem('fileExplorerHistory') || '[]');
            const savedIndex = parseInt(sessionStorage.getItem('fileExplorerHistoryIndex') || '-1', 10);

            if (Array.isArray(savedHistory) && savedHistory.length > 0) {
                const clampedIndex = (Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < savedHistory.length)
                    ? savedIndex
                    : savedHistory.length - 1;
                setNavState({ entries: savedHistory, index: clampedIndex });
            }
        } catch (error) {
            console.error('Failed to load navigation history:', error);
        }
    }, []);

    // Save history to session storage when it changes
    useEffect(() => {
        if (history.length > 0) {
            sessionStorage.setItem('fileExplorerHistory', JSON.stringify(history));
            sessionStorage.setItem('fileExplorerHistoryIndex', currentIndex.toString());
        }
    }, [history, currentIndex]);

    // Navigate to a specific path
    const navigateTo = useCallback((path) => {
        if (!path) return;

        setNavState(prev => {
            const activePath = prev.entries[prev.index] || null;
            if (path === activePath) return prev;

            const trimmed = prev.index >= 0 ? prev.entries.slice(0, prev.index + 1) : [];
            const nextEntries = [...trimmed, path];
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

    const contextValue = {
        history,
        currentIndex,
        currentPath,
        canGoBack,
        canGoForward,
        navigateTo,
        goBack,
        goForward,
    };

    return (
        <HistoryContext.Provider value={contextValue}>
            {children}
        </HistoryContext.Provider>
    );
}

// Custom hook for using the history context
export const useHistory = () => useContext(HistoryContext);