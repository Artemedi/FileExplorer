import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args) => mockInvoke(...args),
}));

const mockShowError = vi.fn();
const mockShowSuccess = vi.fn();

vi.mock('../src/utils/NotificationSystem', () => ({
    showNotification: vi.fn(),
    showError: (...args) => mockShowError(...args),
    showSuccess: (...args) => mockShowSuccess(...args),
    showConfirm: vi.fn().mockResolvedValue(true),
}));

import ContextMenuProvider, { useContextMenu } from '../src/providers/ContextMenuProvider';
import { FileSystemContext } from '../src/providers/FileSystemProvider';
import { HistoryContext } from '../src/providers/HistoryProvider';
import SftpProvider from '../src/providers/SftpProvider';
import { SettingsContext } from '../src/providers/SettingsProvider';

function Harness({ currentPath, onReady }) {
    const ctx = useContextMenu();
    React.useEffect(() => {
        onReady(ctx);
    }, [ctx, onReady]);
    return null;
}

function renderClipboardHarness({ currentPath = 'C:\\Dest', loadDirectory = vi.fn() } = {}) {
    let latestCtx = null;
    const fsValue = {
        selectedItems: [],
        loadDirectory,
        clearSelection: vi.fn(),
        moveToTrash: vi.fn(),
        currentDirData: { directories: [], files: [] },
    };
    const result = render(
        <SettingsContext.Provider value={{ settings: { confirm_delete: false } }}>
            <SftpProvider>
                <HistoryContext.Provider value={{ currentPath }}>
                    <FileSystemContext.Provider value={fsValue}>
                        <ContextMenuProvider>
                            <Harness currentPath={currentPath} onReady={(c) => { latestCtx = c; }} />
                        </ContextMenuProvider>
                    </FileSystemContext.Provider>
                </HistoryContext.Provider>
            </SftpProvider>
        </SettingsContext.Provider>
    );
    return { ...result, getCtx: () => latestCtx };
}

describe('ContextMenuProvider Windows CF_HDROP clipboard integration', () => {
    let writeTextSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        writeTextSpy = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: writeTextSpy },
        });
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'clipboard_sequence_number') return 1;
            if (cmd === 'clipboard_get_files') return null;
            return null;
        });
    });

    afterEach(() => {
        cleanup();
    });

    test('copies local items via clipboard_set_files with cut=false and cuts with cut=true', async () => {
        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'clipboard_set_files') return 42;
            if (cmd === 'clipboard_sequence_number') return 42;
            if (cmd === 'clipboard_get_files') return null;
            return null;
        });

        const { getCtx } = renderClipboardHarness();
        const items = [
            { name: 'a.txt', path: 'C:\\Src\\a.txt' },
            { name: 'b.txt', path: 'C:\\Src\\b.txt' },
        ];

        await act(async () => {
            await getCtx().copyToClipboard(items);
        });

        expect(mockInvoke).toHaveBeenCalledWith('clipboard_set_files', {
            paths: ['C:\\Src\\a.txt', 'C:\\Src\\b.txt'],
            cut: false,
        });
        expect(writeTextSpy).not.toHaveBeenCalled();

        await act(async () => {
            await getCtx().cutToClipboard([items[0]]);
        });

        expect(mockInvoke).toHaveBeenCalledWith('clipboard_set_files', {
            paths: ['C:\\Src\\a.txt'],
            cut: true,
        });
    });

    test('falls back to navigator.clipboard.writeText for SFTP items', async () => {
        const { getCtx } = renderClipboardHarness();
        const sftpItems = [{ name: 'pg.conf', path: 'sftp://u@host:22/etc/pg.conf' }];

        await act(async () => {
            await getCtx().copyToClipboard(sftpItems);
        });

        expect(mockInvoke).not.toHaveBeenCalledWith('clipboard_set_files', expect.anything());
        expect(writeTextSpy).toHaveBeenCalledWith('sftp://u@host:22/etc/pg.conf');
    });

    test('pastes files from system clipboard when clipboard sequence changed externally', async () => {
        let seq = 10;
        const loadDirectory = vi.fn().mockResolvedValue(true);

        mockInvoke.mockImplementation(async (cmd) => {
            if (cmd === 'clipboard_set_files') {
                seq = 10;
                return seq;
            }
            if (cmd === 'clipboard_sequence_number') return seq;
            if (cmd === 'clipboard_get_files') {
                return seq === 99
                    ? { paths: ['C:\\RemoteDrop\\rdp_file.txt'], cut: false }
                    : null;
            }
            if (cmd === 'open_directory') {
                return JSON.stringify({ directories: [], files: [] });
            }
            if (cmd === 'copy_file_or_dir') return null;
            return null;
        });

        const { getCtx } = renderClipboardHarness({ currentPath: 'C:\\Dest', loadDirectory });

        await act(async () => {
            await getCtx().copyToClipboard([{ name: 'old.txt', path: 'C:\\Old\\old.txt' }]);
        });

        // Simulate external Windows Explorer / RDP copy changing clipboard sequence
        seq = 99;

        await act(async () => {
            await getCtx().pasteFromClipboard();
        });

        expect(mockInvoke).toHaveBeenCalledWith('copy_file_or_dir', {
            sourcePath: 'C:\\RemoteDrop\\rdp_file.txt',
            destinationPath: 'C:\\Dest\\rdp_file.txt',
        });
        expect(loadDirectory).toHaveBeenCalledWith('C:\\Dest');
    });
});
