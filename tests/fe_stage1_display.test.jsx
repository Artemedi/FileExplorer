import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

import { middleEllipsis } from '../src/utils/middleEllipsis';
import FileItem from '../src/components/explorer/FileItem';
import StatusBar from '../src/components/explorer/StatusBar';
import { FileSystemContext } from '../src/providers/FileSystemProvider';
import { HistoryContext } from '../src/providers/HistoryProvider';
import { ContextMenuContext } from '../src/providers/ContextMenuProvider';
import { SettingsContext } from '../src/providers/SettingsProvider';

afterEach(() => {
    cleanup();
});

describe('middleEllipsis utility', () => {
    test('returns short names unchanged', () => {
        expect(middleEllipsis('short.txt', 26)).toBe('short.txt');
        expect(middleEllipsis('pg_audit.sh', 26)).toBe('pg_audit.sh');
        expect(middleEllipsis('', 26)).toBe('');
    });

    test('preserves extension and trailing base chars for long filenames', () => {
        const name = 'alloy-1.16.1-1.el9.x86_64.rpm';
        const out = middleEllipsis(name, 26);
        expect(out.length).toBeLessThanOrEqual(26);
        expect(out).toContain('…');
        expect(out.endsWith('x86_64.rpm')).toBe(true);
        expect(out.startsWith('alloy-1.16')).toBe(true);
    });

    test('handles directories and dotfiles without treating whole name as extension', () => {
        const dirName = 'my-very-long-directory-name-for-backups';
        const dirOut = middleEllipsis(dirName, 26, { isDirectory: true });
        expect(dirOut.length).toBeLessThanOrEqual(26);
        expect(dirOut).toContain('…');
        expect(dirOut.endsWith('ackups')).toBe(true);

        const dotfile = '.very-long-hidden-configuration-file';
        const dotOut = middleEllipsis(dotfile, 26);
        expect(dotOut.length).toBeLessThanOrEqual(26);
        expect(dotOut.startsWith('.very-long')).toBe(true);
        expect(dotOut.endsWith('n-file')).toBe(true);
    });

    test('handles extremely long extensions safely within budget', () => {
        const name = 'file.abcdefghijklmnopqrstuvwxyz1234567890';
        const out = middleEllipsis(name, 20);
        expect(out.length).toBeLessThanOrEqual(20);
        expect(out).toContain('…');
    });
});

function renderFileItem(props) {
    return render(
        <SettingsContext.Provider value={{ settings: { show_file_extensions: true } }}>
            <HistoryContext.Provider value={{ currentPath: '/home/user' }}>
                <FileSystemContext.Provider value={{ loadDirectory: vi.fn() }}>
                    <ContextMenuContext.Provider value={{ clipboard: { items: [], operation: null } }}>
                        <FileItem {...props} />
                    </ContextMenuContext.Provider>
                </FileSystemContext.Provider>
            </HistoryContext.Provider>
        </SettingsContext.Provider>
    );
}

describe('FileItem grid name visibility', () => {
    const longItem = {
        name: 'alloy-1.16.1-1.el9.x86_64.rpm',
        path: 'sftp://user@host:22/home/alloy-1.16.1-1.el9.x86_64.rpm',
        isDirectory: false,
        size_in_bytes: 1024,
    };

    test('shows middle-truncated name keeping extension when unselected in grid view', () => {
        renderFileItem({ item: longItem, viewMode: 'grid', isSelected: false, isFocused: false });
        const nameEl = screen.getByTitle('alloy-1.16.1-1.el9.x86_64.rpm');
        expect(nameEl.textContent).toContain('…');
        expect(nameEl.textContent.endsWith('x86_64.rpm')).toBe(true);
        expect(nameEl).not.toHaveClass('truncate');
    });

    test('expands full filename when selected or focused in grid view', () => {
        renderFileItem({ item: longItem, viewMode: 'grid', isSelected: true, isFocused: false });
        const nameEl = screen.getByTitle('alloy-1.16.1-1.el9.x86_64.rpm');
        expect(nameEl.textContent).toBe('alloy-1.16.1-1.el9.x86_64.rpm');
    });
});

describe('StatusBar', () => {
    const dirData = {
        directories: [{ name: 'Desktop', path: '/home/Desktop', isDirectory: true, sub_file_count: 3 }],
        files: [
            {
                name: 'alloy-1.16.1-1.el9.x86_64.rpm',
                path: 'sftp://user@host:22/home/alloy-1.16.1-1.el9.x86_64.rpm',
                isDirectory: false,
                size_in_bytes: 2048,
                last_modified: '2026-11-20T10:00:00Z',
            },
            {
                name: 'pg_audit.sh',
                path: 'sftp://user@host:22/home/pg_audit.sh',
                isDirectory: false,
                size_in_bytes: 512,
                last_modified: '2026-11-20T10:00:00Z',
            },
        ],
    };

    test('shows item count when nothing is selected', () => {
        render(<StatusBar data={dirData} selectedItems={[]} />);
        expect(screen.getByRole('status')).toHaveTextContent('3');
    });

    test('shows full filename, file type + extension, size, and date for single selected item', () => {
        render(<StatusBar data={dirData} selectedItems={[dirData.files[0]]} />);
        const bar = screen.getByRole('status');
        expect(bar).toHaveTextContent('alloy-1.16.1-1.el9.x86_64.rpm');
        expect(bar).toHaveTextContent('Red Hat Package (.rpm)');
        expect(bar).toHaveTextContent('2 KB');
    });

    test('shows selection count and total file size for multiple selected items', () => {
        render(<StatusBar data={dirData} selectedItems={[dirData.files[0], dirData.files[1]]} />);
        const bar = screen.getByRole('status');
        expect(bar).toHaveTextContent('2');
        expect(bar).toHaveTextContent('2.5 KB');
    });
});
