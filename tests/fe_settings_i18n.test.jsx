import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args) => mockInvoke(...args),
}));

vi.mock('../src/providers/HistoryProvider', () => ({
    useHistory: () => ({ currentPath: 'C:\\Users\\Test' }),
}));

import SettingsProvider, { useSettings } from '../src/providers/SettingsProvider';
import ThemeProvider, { useTheme } from '../src/providers/ThemeProvider';
import { I18nProvider, useTranslation } from '../src/i18n/index.jsx';
import useSearch from '../src/hooks/useSearch';
import { searchFiles } from '../src/utils/search';
import { showConfirm, showNotification } from '../src/utils/NotificationSystem';
import { formatDate, calculateTimeElapsed, formatErrorMessage } from '../src/utils/formatters';
import { registerShortcuts, handleNavigation, SHORTCUTS } from '../src/utils/keyboard';
import SettingsApplier from '../src/utils/SettingsApplier';

beforeEach(() => {
    mockInvoke.mockReset();
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.lang = 'en';
    document.documentElement.style.cssText = '';
    document.body.innerHTML = '';

    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    });
});

afterEach(() => {
    cleanup();
});

describe('TP-FE-STATE-02: useSearch & search.js IPC integration without render loops', () => {
    test('SearchResults-style effect runs searchFiles once without infinite loop', async () => {
        mockInvoke.mockResolvedValue([['C:\\Users\\Test\\report.pdf', 0.95]]);
        let renderCount = 0;

        function SearchHarness({ query }) {
            renderCount += 1;
            const { results, updateQuery, performSearch } = useSearch();

            useEffect(() => {
                if (query) {
                    updateQuery(query);
                    performSearch();
                }
            }, [query, updateQuery, performSearch]);

            return (
                <div data-testid="count">{results ? results.files.length : 0}</div>
            );
        }

        render(<SearchHarness query="report" />);

        await waitFor(() => {
            expect(screen.getByTestId('count')).toHaveTextContent('1');
        });

        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockInvoke).toHaveBeenCalledWith('search', { query: 'report' });
        expect(renderCount).toBeLessThan(6);
    });

    test('searchFiles invokes search_with_extension for type: filters and returns real entries', async () => {
        mockInvoke.mockResolvedValue([['C:\\Docs\\spec.pdf', 1.0]]);

        const res = await searchFiles('spec type:pdf');

        expect(mockInvoke).toHaveBeenCalledWith('search_with_extension', {
            query: 'spec',
            extensions: ['pdf'],
        });
        expect(res.files).toHaveLength(1);
        expect(res.files[0].name).toBe('spec.pdf');
        expect(res.files[0].path).toBe('C:\\Docs\\spec.pdf');
    });
});

describe('TP-FE-STATE-09 & TP-IPC-01: SettingsProvider, ThemeProvider & NotificationSystem', () => {
    test('toggleTheme syncs SettingsProvider.settings.darkmode and reloadSettings does not unmount children', async () => {
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'get_settings_as_json') {
                return JSON.stringify({ darkmode: false, accent_color: '#0672ef' });
            }
            if (cmd === 'get_setting_field') {
                return false;
            }
            if (cmd === 'update_settings_field') {
                return JSON.stringify({ darkmode: true, accent_color: '#0672ef' });
            }
            return null;
        });

        let mountCount = 0;
        function Probe() {
            useEffect(() => {
                mountCount += 1;
            }, []);
            const { settings, reloadSettings } = useSettings();
            const { theme, toggleTheme } = useTheme();
            return (
                <div>
                    <span data-testid="theme">{theme}</span>
                    <span data-testid="darkmode">{String(settings.darkmode)}</span>
                    <button type="button" onClick={toggleTheme}>Toggle</button>
                    <button type="button" onClick={reloadSettings}>Reload</button>
                </div>
            );
        }

        render(
            <SettingsProvider>
                <ThemeProvider>
                    <Probe />
                </ThemeProvider>
            </SettingsProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('theme')).toHaveTextContent('light');
        });
        expect(screen.getByTestId('darkmode')).toHaveTextContent('false');
        expect(mountCount).toBe(1);

        fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));

        await waitFor(() => {
            expect(screen.getByTestId('theme')).toHaveTextContent('dark');
            expect(screen.getByTestId('darkmode')).toHaveTextContent('true');
        });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
        });

        expect(mountCount).toBe(1);
    });

    test('TP-IPC-01: loadSettings rejects Rust Error JSON and updateSetting does not commit NaN', async () => {
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'get_settings_as_json') {
                return JSON.stringify({
                    code: 500,
                    message_from_code: 'InternalError',
                    custom_message: 'Settings lock poisoned',
                });
            }
            if (cmd === 'update_multiple_settings_command') {
                return JSON.stringify(args.updates);
            }
            if (cmd === 'update_settings_field') {
                throw new Error(JSON.stringify({
                    code: 400,
                    custom_message: 'Invalid terminal_height value',
                }));
            }
            return null;
        });

        function ErrorProbe() {
            const { settings, error, updateSetting } = useSettings();
            return (
                <div>
                    <span data-testid="height">{String(settings.terminal_height)}</span>
                    <span data-testid="has-code">{String('code' in settings)}</span>
                    <span data-testid="error">{error || ''}</span>
                    <button type="button" onClick={() => updateSetting('terminal_height', NaN)}>
                        Break
                    </button>
                </div>
            );
        }

        render(
            <SettingsProvider>
                <ErrorProbe />
            </SettingsProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('height')).toHaveTextContent('240');
        });
        expect(screen.getByTestId('has-code')).toHaveTextContent('false');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Break' }));
        });

        expect(screen.getByTestId('height')).toHaveTextContent('240');
        expect(screen.getByTestId('error')).toHaveTextContent('Invalid terminal_height value');
    });

    test('showConfirm uses valid theme tokens, stops Escape propagation, and reattaches detached container', async () => {
        const parentKeyHandler = vi.fn();
        document.addEventListener('keydown', parentKeyHandler);

        const promise = showConfirm('Delete file?', 'Confirm Delete');

        const dialog = document.body.querySelector('h3')?.parentElement;
        expect(dialog).toBeTruthy();
        const styleAttr = dialog.getAttribute('style') || '';
        expect(styleAttr).toContain('var(--surface');
        expect(styleAttr).toContain('var(--border');
        expect(styleAttr).not.toContain('--bg-primary');
        expect(styleAttr).not.toContain('--border-color');

        const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.dispatchEvent(escEvent);

        const confirmed = await promise;
        expect(confirmed).toBe(false);
        expect(parentKeyHandler).not.toHaveBeenCalled();
        document.removeEventListener('keydown', parentKeyHandler);

        const firstNote = showNotification('Hello');
        expect(document.getElementById('notification-container')).toContainElement(firstNote);

        // Simulate DOM wipe / detachment
        document.body.innerHTML = '';
        const secondNote = showNotification('After detach');
        expect(document.getElementById('notification-container')).toContainElement(secondNote);
    });
});

describe('TP-FE-STATE-10: i18n, formatters, keyboard & SettingsApplier', () => {
    test('I18nProvider syncs html[lang], interpolates params, and pluralizes Russian forms', () => {
        localStorage.setItem('explr_language', 'ru');

        function I18nProbe() {
            const { t, setLanguage } = useTranslation();
            return (
                <div>
                    <span data-testid="p1">{t('common.itemsPlural', { count: 1 })}</span>
                    <span data-testid="p2">{t('common.itemsPlural', { count: 2 })}</span>
                    <span data-testid="p5">{t('common.itemsPlural', { count: 5 })}</span>
                    <button type="button" onClick={() => setLanguage('invalid')}>BadLang</button>
                </div>
            );
        }

        render(
            <I18nProvider>
                <I18nProbe />
            </I18nProvider>
        );

        expect(document.documentElement.lang).toBe('ru');
        expect(screen.getByTestId('p1')).toHaveTextContent('1 элемент');
        expect(screen.getByTestId('p2')).toHaveTextContent('2 элемента');
        expect(screen.getByTestId('p5')).toHaveTextContent('5 элементов');

        fireEvent.click(screen.getByRole('button', { name: 'BadLang' }));
        expect(document.documentElement.lang).toBe('ru');
    });

    test('formatDate parses Rust UTC strings as UTC in active locale and formatErrorMessage unwraps Error JSON', () => {
        document.documentElement.lang = 'ru';
        const formatted = formatDate('2026-11-19 13:15:00', true);
        expect(formatted).toContain('2026');
        expect(calculateTimeElapsed('2026-11-19 13:15:00')).not.toBe('Invalid date');

        const err = new Error('{"code":500,"custom_message":"Disk full"}');
        expect(formatErrorMessage(err)).toBe('Disk full');
    });

    test('keyboard.js normalizes Control+Shift+N and returns 0 from -1 in handleNavigation', () => {
        const onNewFolder = vi.fn();
        const cleanupShortcuts = registerShortcuts({
            [SHORTCUTS.NEW_FOLDER]: onNewFolder,
        });

        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'N',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
        }));
        expect(onNewFolder).toHaveBeenCalledTimes(1);
        cleanupShortcuts();

        const items = ['a', 'b', 'c', 'd', 'e'];
        expect(handleNavigation({ key: 'ArrowDown' }, items, -1, { isGrid: true, columnsPerRow: 4 })).toBe(0);
    });

    test('SettingsApplier parses 3-digit hex and syncs --accent-rgb to #3b82f6 in dark theme for dark accents', () => {
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'get_settings_as_json') {
                return JSON.stringify({ darkmode: true, accent_color: '#111' });
            }
            return null;
        });

        document.documentElement.classList.add('theme-dark');

        render(
            <SettingsProvider>
                <SettingsApplier />
            </SettingsProvider>
        );

        return waitFor(() => {
            expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#3b82f6');
            expect(document.documentElement.style.getPropertyValue('--accent-rgb')).toBe('59, 130, 246');
        });
    });
});

describe('TP-IPC-06: main.jsx and App.jsx CSP & branding compliance', () => {
    test('main.jsx does not inject Google Fonts or window.__TAURI_INVOKE__, and App.jsx uses Explr', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const mainSrc = fs.readFileSync(path.resolve('src/main.jsx'), 'utf8');
        const appSrc = fs.readFileSync(path.resolve('src/App.jsx'), 'utf8');

        expect(mainSrc).not.toContain('fonts.googleapis.com');
        expect(mainSrc).not.toContain('__TAURI_INVOKE__');
        expect(appSrc).not.toContain('Fast File Explorer');
        expect(appSrc).toContain('Explr');
    });
});
