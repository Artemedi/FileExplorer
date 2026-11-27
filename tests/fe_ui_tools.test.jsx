import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockInvoke = vi.fn();
const mockLoadDirectory = vi.fn();
const mockNavigateTo = vi.fn();
const mockPerformSearch = vi.fn();
const mockUpdateQuery = vi.fn();

let mockCurrentPath = 'C:\\TabA';
let mockVolumes = [{ mount_point: 'C:\\' }];

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args) => mockInvoke(...args),
}));

vi.mock('../src/providers/HistoryProvider', () => ({
    useHistory: () => ({
        currentPath: mockCurrentPath,
        navigateTo: mockNavigateTo,
    }),
}));

vi.mock('../src/providers/FileSystemProvider', () => ({
    useFileSystem: () => ({
        loadDirectory: mockLoadDirectory,
        volumes: mockVolumes,
    }),
}));

vi.mock('../src/providers/SftpProvider', () => ({
    useSftp: () => ({
        isSftpPath: (p) => typeof p === 'string' && p.startsWith('sftp:'),
        parseSftpPath: () => null,
    }),
}));

vi.mock('../src/providers/SettingsProvider', () => ({
    useSettings: () => ({
        settings: { terminal_height: 240 },
    }),
}));

vi.mock('../src/i18n', () => ({
    useTranslation: () => ({
        t: (key) => key,
    }),
}));

vi.mock('../src/hooks/useSearch', () => ({
    default: () => ({
        results: null,
        isSearching: false,
        error: null,
        updateQuery: mockUpdateQuery,
        performSearch: mockPerformSearch,
        options: { searchIn: 'current location' },
    }),
}));

import TabManager from '../src/components/tabs/TabManager.jsx';
import Terminal from '../src/components/terminal/Terminal.jsx';
import GlobalSearch from '../src/components/search/GlobalSearch.jsx';
import SearchResults from '../src/components/search/SearchResults.jsx';

describe('Wave 4 UI & Tools Regression Tests (TP-FE-UI-09..12)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        mockCurrentPath = 'C:\\TabA';
        mockLoadDirectory.mockResolvedValue(true);
        mockNavigateTo.mockImplementation(() => {});
        mockInvoke.mockResolvedValue(JSON.stringify({ stdout: '', stderr: '', status: 0 }));
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    describe('TP-FE-UI-09 & TP-FE-UI-10: TabManager (BUG-032, BUG-067)', () => {
        test('TP-FE-UI-09: switching to a slow/failing tab does not overwrite its path with previous tab path', async () => {
            const savedTabs = [
                { id: 'tab-1', title: 'TabA', path: 'C:\\TabA', isActive: true },
                { id: 'tab-2', title: 'TabB', path: 'D:\\TabB', isActive: false },
            ];
            localStorage.setItem('explr_saved_tabs', JSON.stringify(savedTabs));
            localStorage.setItem('explr_active_tab_id', 'tab-1');

            let resolveLoad;
            mockLoadDirectory.mockImplementation(
                () => new Promise((resolve) => { resolveLoad = resolve; })
            );

            render(
                <TabManager>
                    <div>content</div>
                </TabManager>
            );

            fireEvent.click(screen.getByText('TabB'));
            expect(mockLoadDirectory).toHaveBeenCalledWith('D:\\TabB', expect.objectContaining({ isCurrent: expect.any(Function) }));
            const guard = mockLoadDirectory.mock.calls[0][1].isCurrent;
            expect(guard()).toBe(true);

            // Before loadDirectory resolves, saved tabs must still retain D:\TabB
            const storedBefore = JSON.parse(localStorage.getItem('explr_saved_tabs'));
            expect(storedBefore.find(t => t.id === 'tab-2').path).toBe('D:\\TabB');

            // Even if loadDirectory fails (resolves false), tab-2 path must not be overwritten
            await act(async () => {
                resolveLoad(false);
            });
            expect(guard()).toBe(false);
            expect(localStorage.getItem('explr_active_tab_id')).toBe('tab-1');
            const storedAfter = JSON.parse(localStorage.getItem('explr_saved_tabs'));
            expect(storedAfter.find(t => t.id === 'tab-2').path).toBe('D:\\TabB');
        });

        test('TP-FE-UI-09: handles This PC tab (path: null) and dispatches force-explorer-view on tab switch', async () => {
            const savedTabs = [
                { id: 'tab-1', title: 'TabA', path: 'C:\\TabA', isActive: true },
                { id: 'tab-pc', title: 'Home', path: null, isActive: false },
            ];
            localStorage.setItem('explr_saved_tabs', JSON.stringify(savedTabs));
            localStorage.setItem('explr_active_tab_id', 'tab-1');

            const openThisPcListener = vi.fn();
            const forceExplorerListener = vi.fn();
            document.addEventListener('open-this-pc', openThisPcListener);
            document.addEventListener('force-explorer-view', forceExplorerListener);

            render(
                <TabManager>
                    <div>content</div>
                </TabManager>
            );

            expect(forceExplorerListener).not.toHaveBeenCalled();
            fireEvent.click(screen.getByText('Home'));
            expect(openThisPcListener).toHaveBeenCalledTimes(1);
            expect(mockLoadDirectory).not.toHaveBeenCalledWith(null);

            // Clicking TabA (even though tab.path === mockCurrentPath) dispatches force-explorer-view
            fireEvent.click(screen.getByText('TabA'));
            expect(forceExplorerListener).toHaveBeenCalledTimes(1);

            document.removeEventListener('open-this-pc', openThisPcListener);
            document.removeEventListener('force-explorer-view', forceExplorerListener);
        });

        test('AUDIT: restoring a saved Home owner must retain null path despite prior global History', () => {
            localStorage.setItem('explr_saved_tabs', JSON.stringify([
                { id: 'tab-1', title: 'TabA', path: 'C:\\TabA', isActive: false },
                { id: 'tab-pc', title: 'Home', path: null, isActive: true },
            ]));
            localStorage.setItem('explr_active_tab_id', 'tab-pc');
            render(<TabManager><div>content</div></TabManager>);
            const stored = JSON.parse(localStorage.getItem('explr_saved_tabs'));
            expect(stored.find(t => t.id === 'tab-pc').path).toBeNull();
        });

        test('TP-FE-UI-10: drag-and-drop reorders tabs, dragEnd resets ref, no onSelectStart React warning, new-tab has aria-label', () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const savedTabs = [
                { id: 'tab-1', title: 'One', path: 'C:\\One', isActive: true },
                { id: 'tab-2', title: 'Two', path: 'C:\\Two', isActive: false },
                { id: 'tab-3', title: 'Three', path: 'C:\\Three', isActive: false },
            ];
            localStorage.setItem('explr_saved_tabs', JSON.stringify(savedTabs));
            localStorage.setItem('explr_active_tab_id', 'tab-1');

            const { container } = render(
                <TabManager>
                    <div>content</div>
                </TabManager>
            );

            // Accessible label on new-tab button
            expect(screen.getByRole('button', { name: 'New tab' })).toBeInTheDocument();

            // No React unknown prop warning for onSelectStart
            const reactWarnings = consoleErrorSpy.mock.calls.flat().join(' ');
            expect(reactWarnings).not.toContain('onSelectStart');
            consoleErrorSpy.mockRestore();

            const tabElements = container.querySelectorAll('.tab');
            const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };

            // Drag tab 0 onto tab 2
            fireEvent.dragStart(tabElements[0], { dataTransfer });
            fireEvent.dragOver(tabElements[2], { dataTransfer });
            fireEvent.drop(tabElements[2], { dataTransfer });

            const reordered = JSON.parse(localStorage.getItem('explr_saved_tabs')).map(t => t.title);
            expect(reordered).toEqual(['Two', 'Three', 'One']);

            // Cancelled drag (dragStart then dragEnd without drop) should not reorder on a stray drop
            const updatedTabs = container.querySelectorAll('.tab');
            fireEvent.dragStart(updatedTabs[0], { dataTransfer });
            fireEvent.dragEnd(updatedTabs[0]);
            fireEvent.drop(updatedTabs[2], { dataTransfer });

            const afterCancel = JSON.parse(localStorage.getItem('explr_saved_tabs')).map(t => t.title);
            expect(afterCancel).toEqual(['Two', 'Three', 'One']);
        });
    });

    describe('TP-FE-UI-11: Terminal (BUG-033)', () => {
        test('Ctrl+C (case-insensitive) interrupts running command via readOnly input without leaking to parent', async () => {
            let resolveExec;
            mockInvoke.mockImplementation((cmd) => {
                if (cmd === 'execute_command_with_timeout') {
                    return new Promise((resolve) => { resolveExec = resolve; });
                }
                return Promise.resolve(JSON.stringify({ stdout: '', stderr: '', status: 0 }));
            });

            const parentKeyDown = vi.fn();
            const { container } = render(
                <div onKeyDown={parentKeyDown}>
                    <Terminal isOpen={true} onToggle={vi.fn()} />
                </div>
            );

            const input = container.querySelector('.terminal-input');
            fireEvent.change(input, { target: { value: 'ping 127.0.0.1' } });
            fireEvent.submit(input.closest('form'));

            await waitFor(() => {
                expect(input).toHaveAttribute('readonly');
            });
            expect(input).not.toBeDisabled();

            // Uppercase Ctrl+C (simulating CapsLock)
            fireEvent.keyDown(input, { key: 'C', ctrlKey: true });

            await waitFor(() => {
                expect(screen.getByText(/Command interrupted by user/i)).toBeInTheDocument();
            });
            expect(parentKeyDown).not.toHaveBeenCalled();

            if (resolveExec) resolveExec(JSON.stringify({ stdout: '', stderr: '', status: 0 }));
        });

        test('Ctrl+C copies selected text in terminal without leaking to MainLayout', () => {
            const writeText = vi.fn().mockResolvedValue(undefined);
            Object.assign(navigator, { clipboard: { writeText } });
            vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'copied output' });

            const parentKeyDown = vi.fn();
            const { container } = render(
                <div onKeyDown={parentKeyDown}>
                    <Terminal isOpen={true} onToggle={vi.fn()} />
                </div>
            );

            const terminalRoot = container.querySelector('.enhanced-terminal');
            fireEvent.keyDown(terminalRoot, { key: 'c', ctrlKey: true });

            expect(writeText).toHaveBeenCalledWith('copied output');
            expect(parentKeyDown).not.toHaveBeenCalled();
            vi.restoreAllMocks();
        });

        test('Ctrl+R renders searchResults UI and selects command on click/Enter', async () => {
            localStorage.setItem('terminal-command-history', JSON.stringify(['ls -la', 'git status', 'git diff']));

            const { container } = render(<Terminal isOpen={true} onToggle={vi.fn()} />);
            const input = container.querySelector('.terminal-input');

            fireEvent.keyDown(input, { key: 'R', ctrlKey: true });
            fireEvent.change(input, { target: { value: 'git' } });

            await waitFor(() => {
                expect(screen.getByRole('listbox')).toBeInTheDocument();
            });
            expect(screen.getByText('git status')).toBeInTheDocument();
            expect(screen.getByText('git diff')).toBeInTheDocument();

            fireEvent.keyDown(input, { key: 'Enter' });
            expect(input.value).toBe('git status');
        });

        test('cd validates target via open_directory, supports quoted paths and ~/subdir', async () => {
            mockInvoke.mockImplementation((cmd, args) => {
                if (cmd === 'execute_command_improved' && args?.command === 'echo $HOME') {
                    return Promise.resolve(JSON.stringify({ stdout: 'C:\\Users\\Alice\n', stderr: '', status: 0 }));
                }
                if (cmd === 'open_directory') {
                    if (args?.path?.includes('nonexistent')) {
                        return Promise.reject(new Error('Not found'));
                    }
                    return Promise.resolve(JSON.stringify({ directories: [], files: [] }));
                }
                return Promise.resolve(JSON.stringify({ stdout: '', stderr: '', status: 0 }));
            });

            const { container } = render(<Terminal isOpen={true} onToggle={vi.fn()} />);
            const input = container.querySelector('.terminal-input');

            // cd nonexistent -> error, no navigateTo
            fireEvent.change(input, { target: { value: 'cd nonexistent' } });
            fireEvent.submit(input.closest('form'));
            await waitFor(() => {
                expect(screen.getByText(/No such file or directory/i)).toBeInTheDocument();
            });
            expect(mockNavigateTo).not.toHaveBeenCalled();

            // cd "My Folder" -> parsed as single argument
            fireEvent.change(input, { target: { value: 'cd "My Folder"' } });
            fireEvent.submit(input.closest('form'));
            await waitFor(() => {
                expect(mockNavigateTo).toHaveBeenCalledWith('C:\\TabA\\My Folder');
            });

            // cd ~/Documents -> resolves home + subpath
            fireEvent.change(input, { target: { value: 'cd ~/Documents' } });
            fireEvent.submit(input.closest('form'));
            await waitFor(() => {
                expect(mockNavigateTo).toHaveBeenCalledWith('C:\\Users\\Alice\\Documents');
            });
        });

        test('which rejects unsafe shell metacharacters and checks status === 0', async () => {
            mockInvoke.mockResolvedValue(JSON.stringify({ stdout: '', stderr: 'not found', status: 1 }));

            const { container } = render(<Terminal isOpen={true} onToggle={vi.fn()} />);
            const input = container.querySelector('.terminal-input');

            fireEvent.change(input, { target: { value: 'which foo;whoami' } });
            fireEvent.submit(input.closest('form'));
            await waitFor(() => {
                expect(screen.getByText(/invalid command name/i)).toBeInTheDocument();
            });
            expect(mockInvoke).not.toHaveBeenCalled();

            fireEvent.change(input, { target: { value: 'which fake_cmd_123' } });
            fireEvent.submit(input.closest('form'));
            await waitFor(() => {
                expect(screen.getByText(/fake_cmd_123: command not found/i)).toBeInTheDocument();
            });
        });

        test('guards built-in commands on null/SFTP paths and displays stderr on non-zero exit', async () => {
            mockCurrentPath = null;
            const { container, rerender } = render(<Terminal isOpen={true} onToggle={vi.fn()} />);
            const input = container.querySelector('.terminal-input');

            fireEvent.change(input, { target: { value: 'ls' } });
            fireEvent.submit(input.closest('form'));
            await waitFor(() => {
                expect(screen.getByText(/This PC view/i)).toBeInTheDocument();
            });

            mockCurrentPath = 'C:\\TabA';
            mockInvoke.mockResolvedValueOnce(JSON.stringify({ stdout: '', stderr: 'permission denied', status: 2 }));
            rerender(<Terminal isOpen={true} onToggle={vi.fn()} />);

            fireEvent.change(input, { target: { value: 'customcmd' } });
            fireEvent.submit(input.closest('form'));
            await waitFor(() => {
                expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
            });
        });
    });

    describe('TP-FE-UI-12: GlobalSearch & SearchResults (BUG-035)', () => {
        test('closing GlobalSearch stops keydown interception, stops 100ms polling, and avoids focus() null crash', async () => {
            vi.useFakeTimers();
            mockInvoke.mockImplementation((cmd) => {
                if (cmd === 'get_search_engine_info') {
                    return Promise.resolve({
                        status: 'Indexing',
                        stats: { trie_size: 10 },
                        progress: { files_indexed: 1, files_discovered: 5, percentage_complete: 20, current_path: 'C:\\Users\\Alice\\file.txt' },
                    });
                }
                if (cmd === 'get_system_info') {
                    return Promise.resolve({ user_home_dir: 'C:\\Users\\Alice' });
                }
                if (cmd === 'get_search_suggestions') {
                    return Promise.resolve(['readme', 'report']);
                }
                return Promise.resolve([]);
            });

            const { rerender } = render(<GlobalSearch isOpen={true} onClose={vi.fn()} />);

            // Advance timers so polling starts and focus timeout runs
            await act(async () => {
                vi.advanceTimersByTime(250);
            });

            const callsWhileOpen = mockInvoke.mock.calls.filter(([c]) => c === 'get_search_engine_info').length;
            expect(callsWhileOpen).toBeGreaterThanOrEqual(1);

            // Close modal
            rerender(<GlobalSearch isOpen={false} onClose={vi.fn()} />);

            await act(async () => {
                vi.advanceTimersByTime(500);
            });

            const callsAfterClose = mockInvoke.mock.calls.filter(([c]) => c === 'get_search_engine_info').length;
            expect(callsAfterClose).toBe(callsWhileOpen);

            // Keydown events when closed must NOT be preventDefault()'d
            const arrowEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
            document.dispatchEvent(arrowEvent);
            expect(arrowEvent.defaultPrevented).toBe(false);

            const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
            document.dispatchEvent(tabEvent);
            expect(tabEvent.defaultPrevented).toBe(false);
        });

        test('does not classify README as (Directory), re-filters raw results on filter toggle, and highlights Windows current directory', async () => {
            mockCurrentPath = 'C:\\Users\\Alice';
            mockInvoke.mockImplementation((cmd) => {
                if (cmd === 'get_search_engine_info') {
                    return Promise.resolve({ status: 'Ready', stats: { trie_size: 10 } });
                }
                if (cmd === 'get_system_info') {
                    return Promise.resolve({ user_home_dir: 'C:\\Users\\Alice' });
                }
                if (cmd === 'search') {
                    return Promise.resolve([
                        ['c:\\users\\alice\\README', 0.9],
                        ['C:\\Users\\Alice\\docs\\', 0.8],
                        ['C:\\Users\\Alice\\.env', 0.7],
                    ]);
                }
                return Promise.resolve([]);
            });

            const { container } = render(<GlobalSearch isOpen={true} onClose={vi.fn()} />);

            await waitFor(() => {
                expect(mockInvoke).toHaveBeenCalledWith('get_search_engine_info');
            });

            const input = document.querySelector('.search-input-field');
            fireEvent.change(input, { target: { value: 'read' } });
            fireEvent.submit(input.closest('form'));

            await waitFor(() => {
                expect(screen.getByText('README')).toBeInTheDocument();
            });

            // README should NOT have (Directory), docs/ SHOULD have (Directory)
            const readmeRow = screen.getByText('README').closest('.result-item-container');
            expect(readmeRow).not.toHaveTextContent('(Directory)');
            expect(readmeRow).toHaveTextContent('In current directory');

            const docsRow = screen.getByText('docs').closest('.result-item-container');
            expect(docsRow).toHaveTextContent('(Directory)');

            // Open Filters dropdown and toggle Show directories only
            fireEvent.click(screen.getByTitle('Search filters and options'));
            const dirCheckbox = screen.getByLabelText(/Show directories only/i);
            fireEvent.click(dirCheckbox);

            expect(screen.queryByText('README')).not.toBeInTheDocument();
            expect(screen.getByText('docs')).toBeInTheDocument();

            // Unchecking restores README from rawResults
            fireEvent.click(dirCheckbox);
            expect(screen.getByText('README')).toBeInTheDocument();
        });

        test('SearchResults passes query directly to performSearch(query)', () => {
            render(<SearchResults query="invoice" viewMode="list" onClearSearch={vi.fn()} />);
            expect(mockUpdateQuery).toHaveBeenCalledWith('invoice');
            expect(mockPerformSearch).toHaveBeenCalledWith('invoice');
        });
    });
});
