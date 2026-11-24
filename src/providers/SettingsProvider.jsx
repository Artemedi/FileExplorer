import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatErrorMessage } from '../utils/formatters';

// Default settings - using exact backend keys and supported values
const defaultSettings = {
    // Core UI settings
    darkmode: false,
    custom_themes: [],
    default_theme: "",
    default_themes_path: "",
    default_folder_path_on_opening: "",
    default_view: "grid", // Grid, List, Details
    font_size: "Medium", // Small, Medium, Large
    show_hidden_files_and_folders: false,
    show_details_panel: false,
    accent_color: "#0672ef",

    // Behavior settings
    confirm_delete: true,
    auto_refresh_dir: true,
    sort_direction: "Ascending", // Ascending, Descending
    sort_by: "Name", // Name, Size, Modified, Type
    double_click: "OpenFilesAndFolders", // OpenFilesAndFolders, SelectFilesAndFolders
    show_file_extensions: true,

    // Interface settings
    terminal_height: 240,
    terminal_sync_explorer_to_terminal: false,
    enable_animations_and_transitions: true,
    enable_virtual_scroll_for_large_directories: false,

    // Search settings
    enable_suggestions: true,
    highlight_matches: true,

    // Backend settings that are nested but we'll manage them
    search_engine_enabled: true,
    case_sensitive_search: false,
    index_hidden_files: false,
    fuzzy_search_enabled: true,
    default_checksum_hash: "SHA256",
};

// Helper to normalize nested backend settings into the flat UI settings shape
const normalizeSettingsPayload = (rawSettings) => {
    if (!rawSettings || typeof rawSettings !== 'object') {
        return { ...defaultSettings };
    }
    const flattened = {
        ...rawSettings,
        ...(rawSettings.backend_settings?.search_engine_config && {
            search_engine_enabled: rawSettings.backend_settings.search_engine_config.search_engine_enabled,
            case_sensitive_search: rawSettings.backend_settings.search_engine_config.case_sensitive_search,
            index_hidden_files: rawSettings.backend_settings.search_engine_config.index_hidden_files,
            fuzzy_search_enabled: rawSettings.backend_settings.search_engine_config.fuzzy_search_enabled,
        }),
        ...(rawSettings.backend_settings && {
            default_checksum_hash: rawSettings.backend_settings.default_checksum_hash,
        }),
    };
    return {
        ...defaultSettings,
        ...flattened,
    };
};

// Create context
export const SettingsContext = createContext({
    settings: defaultSettings,
    isLoading: true,
    error: null,
    updateSetting: () => {},
    updateMultipleSettings: () => {},
    resetSettings: () => {},
    reloadSettings: () => {},
});

// Provider component
export default function SettingsProvider({ children }) {
    const [settings, setSettings] = useState(defaultSettings);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const hasLoadedRef = useRef(false);
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    // Keep settings.darkmode synchronized when ThemeProvider changes theme
    useEffect(() => {
        const handleThemeProviderChanged = (e) => {
            if (typeof e?.detail?.isDark === 'boolean') {
                const isDark = e.detail.isDark;
                setSettings(prev => (prev.darkmode === isDark ? prev : { ...prev, darkmode: isDark }));
            }
        };
        window.addEventListener('theme-provider-changed', handleThemeProviderChanged);
        return () => window.removeEventListener('theme-provider-changed', handleThemeProviderChanged);
    }, []);

    // Load settings from backend
    const loadSettings = useCallback(async () => {
        if (!hasLoadedRef.current) {
            setIsLoading(true);
        }
        setError(null);

        try {
            console.log('Loading settings from backend...');
            const settingsJson = await invoke('get_settings_as_json');
            const loadedSettings = JSON.parse(settingsJson);

            if (!loadedSettings || typeof loadedSettings !== 'object' || ('code' in loadedSettings && 'custom_message' in loadedSettings)) {
                throw new Error(loadedSettings?.custom_message || loadedSettings?.message_from_code || 'Failed to load settings from backend');
            }

            console.log('Loaded settings:', loadedSettings);

            if (!isMountedRef.current) return;
            setSettings(normalizeSettingsPayload(loadedSettings));
            console.log('Settings loaded successfully');
        } catch (err) {
            console.error('Failed to load settings:', err);
            if (!isMountedRef.current) return;
            setError(formatErrorMessage(err));

            // Use default settings if loading fails
            setSettings(defaultSettings);

            // Try to save default settings to backend
            try {
                console.log('Saving default settings to backend...');
                await invoke('update_multiple_settings_command', {
                    updates: defaultSettings,
                });
                console.log('Default settings saved successfully');
            } catch (saveError) {
                console.error('Failed to save default settings:', saveError);
                if (isMountedRef.current) {
                    setError(formatErrorMessage(saveError));
                }
            }
        } finally {
            if (isMountedRef.current) {
                hasLoadedRef.current = true;
                setIsLoading(false);
            }
        }
    }, []);

    // Load settings on mount
    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    // Update a single setting
    const updateSetting = async (key, value) => {
        console.log(`Updating setting: ${key} = ${value}`);

        try {
            // Update in backend
            const updatedSettingsJson = await invoke('update_settings_field', {
                key,
                value
            });

            // Parse the response to get the updated settings
            if (updatedSettingsJson) {
                const parsed = JSON.parse(updatedSettingsJson);
                if (parsed && typeof parsed === 'object' && 'code' in parsed && 'custom_message' in parsed) {
                    throw new Error(parsed.custom_message || parsed.message_from_code || `Failed to update ${key}`);
                }
                const updatedSettings = normalizeSettingsPayload(parsed);
                if (isMountedRef.current) {
                    setSettings(updatedSettings);
                }
            } else if (isMountedRef.current) {
                // Fallback: just update the local state
                setSettings(prev => ({
                    ...prev,
                    [key]: value,
                }));
            }

            if (key === 'darkmode') {
                window.dispatchEvent(new CustomEvent('theme-setting-changed', {
                    detail: { isDark: Boolean(value) }
                }));
            }

            console.log(`Setting ${key} updated successfully`);
        } catch (err) {
            console.error(`Failed to update setting ${key}:`, err);
            if (isMountedRef.current) {
                setError(`Failed to update ${key}: ${formatErrorMessage(err)}`);
                setTimeout(() => {
                    if (isMountedRef.current) setError(null);
                }, 5000);
            }
        }
    };

    // Update multiple settings at once
    const updateMultipleSettings = async (updates) => {
        console.log('Updating multiple settings:', updates);

        try {
            // Update in backend
            const updatedSettingsJson = await invoke('update_multiple_settings_command', {
                updates
            });

            // Parse the response to get the updated settings
            if (updatedSettingsJson) {
                const parsed = JSON.parse(updatedSettingsJson);
                if (parsed && typeof parsed === 'object' && 'code' in parsed && 'custom_message' in parsed) {
                    throw new Error(parsed.custom_message || parsed.message_from_code || 'Failed to update settings');
                }
                const updatedSettings = normalizeSettingsPayload(parsed);
                if (isMountedRef.current) {
                    setSettings(updatedSettings);
                }
            } else if (isMountedRef.current) {
                // Fallback: just update the local state
                setSettings(prev => ({
                    ...prev,
                    ...updates,
                }));
            }

            if (Object.prototype.hasOwnProperty.call(updates, 'darkmode')) {
                window.dispatchEvent(new CustomEvent('theme-setting-changed', {
                    detail: { isDark: Boolean(updates.darkmode) }
                }));
            }

            console.log('Multiple settings updated successfully');
        } catch (err) {
            console.error('Failed to update multiple settings:', err);
            if (isMountedRef.current) {
                setError(`Failed to update settings: ${formatErrorMessage(err)}`);
                setTimeout(() => {
                    if (isMountedRef.current) setError(null);
                }, 5000);
            }
        }
    };

    // Reset settings to defaults
    const resetSettings = async () => {
        console.log('Resetting settings to defaults');

        try {
            // Reset in backend
            await invoke('reset_settings_command');

            // Update local state
            if (isMountedRef.current) {
                setSettings(defaultSettings);
            }
            window.dispatchEvent(new CustomEvent('theme-setting-changed', {
                detail: { isDark: Boolean(defaultSettings.darkmode) }
            }));

            console.log('Settings reset successfully');
        } catch (err) {
            console.error('Failed to reset settings:', err);
            if (isMountedRef.current) {
                setError(`Failed to reset settings: ${formatErrorMessage(err)}`);
                setTimeout(() => {
                    if (isMountedRef.current) setError(null);
                }, 5000);
            }
        }
    };

    // Reload settings from backend
    const reloadSettings = useCallback(() => {
        return loadSettings();
    }, [loadSettings]);

    const contextValue = {
        settings,
        isLoading,
        error,
        updateSetting,
        updateMultipleSettings,
        resetSettings,
        reloadSettings,
    };

    // Show loading state ONLY on initial load, never on reloadSettings()
    if (isLoading && !hasLoadedRef.current) {
        return (
            <div style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100vh',
                flexDirection: 'column',
                gap: '16px'
            }}>
                <div style={{
                    width: '40px',
                    height: '40px',
                    border: '3px solid #f3f4f6',
                    borderTopColor: '#3b82f6',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite'
                }} />
                <div style={{
                    color: '#6b7280',
                    fontSize: '14px'
                }}>
                    Loading settings...
                </div>
                <style>{`
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                `}</style>
            </div>
        );
    }

    return (
        <SettingsContext.Provider value={contextValue}>
            {children}
        </SettingsContext.Provider>
    );
}

// Custom hook for using the settings context
export const useSettings = () => useContext(SettingsContext);