import React from 'react';
import { useHistory } from '../../providers/HistoryProvider';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { showSuccess, showError } from '../../utils/NotificationSystem';
import './navigationButtons.css';

/**
 * NavigationButtons component - Provides back, forward, and refresh navigation controls
 * @returns {React.ReactElement} NavigationButtons component
 */
const NavigationButtons = () => {
    const { canGoBack, canGoForward, goBack, goForward, currentPath } = useHistory();
    const { loadDirectory, loadVolumes } = useFileSystem();

    /**
     * Handles directory refresh action
     * Reloads the current directory and displays notification feedback
     * @async
     */
    const handleRefresh = async () => {
        if (currentPath) {
            try {
                // Refresh volumes (disks, space, etc.)
                await loadVolumes();
                await loadDirectory(currentPath);
                showSuccess('Directory and disks refreshed');
            } catch (error) {
                console.error('Failed to refresh directory or disks:', error);
                showError('Failed to refresh directory or disks');
            }
        } else {
            try {
                // Refresh volumes (disks, space, etc.)
                await loadVolumes();
                showSuccess('Volumes refreshed');
            } catch (error) {
                console.error('Failed to refresh volumes:', error);
                showError('Failed to refresh volumes');
            }
        }
    };

    return (
        <div className="navigation-buttons">
            <button
                className="nav-button"
                onClick={goBack}
                disabled={!canGoBack}
                aria-label="Go back"
                title="Go back"
            >
                <span className="icon icon-arrow-left"></span>
            </button>

            <button
                className="nav-button"
                onClick={goForward}
                disabled={!canGoForward}
                aria-label="Go forward"
                title="Go forward"
            >
                <span className="icon icon-arrow-right"></span>
            </button>

            <button
                className="nav-button"
                onClick={handleRefresh}
                aria-label="Refresh"
                title="Refresh current directory"
            >
                <span className="icon icon-refresh"></span>
            </button>
        </div>
    );
};

export default NavigationButtons;