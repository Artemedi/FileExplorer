import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { mockInvoke, mockApply, mockFlush } = vi.hoisted(() => ({
    mockInvoke: vi.fn(), mockApply: vi.fn(), mockFlush: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('../src/components/terminal/XtermSshView', () => ({
    default: ({ registerController, onData, inputEnabled }) => {
        React.useEffect(() => {
            registerController('view', { applyFrame: mockApply, flushBufferText: mockFlush });
            return () => registerController('view', null);
        }, []);
        return <button type="button" disabled={!inputEnabled} onClick={() => onData('native-input')}>Type into PTY</button>;
    },
}));
import DetachedTerminal from '../src/components/terminal/DetachedTerminal';

describe('R4 detached terminal', () => {
    afterEach(() => { cleanup(); vi.clearAllMocks(); });

    test('does not enable input until replay is parsed and backend commits ownership', async () => {
        let resolveFlush;
        let phase = 'detaching';
        const frame = { seq: 1, data: 'history' };
        mockFlush.mockReturnValueOnce(new Promise(resolve => { resolveFlush = resolve; })).mockResolvedValue('');
        mockInvoke.mockImplementation(async (command, args) => {
            if (command === 'ssh_detached_read') return {
                session_id: 'pty-1', status: { epoch: phase === 'detaching' ? 1 : 2, phase },
                frames: args.cursor === 0 ? [frame] : [], latest: 1,
            };
            if (command === 'ssh_detached_ready') {
                phase = 'detached';
                return { epoch: 2, phase };
            }
            return null;
        });
        render(<DetachedTerminal />);
        const input = screen.getByRole('button', { name: 'Type into PTY' });
        await waitFor(() => expect(mockApply).toHaveBeenCalledWith(frame));
        expect(input).toBeDisabled();
        expect(mockInvoke).not.toHaveBeenCalledWith('ssh_detached_ready', expect.anything());
        await act(async () => resolveFlush(''));
        await waitFor(() => expect(input).toBeEnabled());
        expect(mockInvoke).toHaveBeenCalledWith('ssh_detached_ready', { ownerEpoch: 1, cursor: 1 });
        fireEvent.click(input);
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ssh_write_pty', {
            sessionId: 'pty-1', data: 'native-input', ownerEpoch: 2,
        }));
        fireEvent.click(screen.getByRole('button', { name: 'Attach to Main' }));
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ssh_attach_pty', { ownerEpoch: 2 }));
        expect(input).toBeDisabled();
        expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'ssh_start_pty')).toBe(false);
    });

    test('stops replay and never commits when a frame is missing', async () => {
        mockInvoke.mockImplementation(async (command) => {
            if (command === 'ssh_detached_read') return {
                session_id: 'pty-1', status: { epoch: 1, phase: 'detaching' },
                frames: [{ seq: 2, data: 'gap' }], latest: 2,
            };
            return null;
        });
        render(<DetachedTerminal />);
        expect(await screen.findByRole('alert')).toHaveTextContent('VT output sequence gap');
        expect(screen.getByRole('button', { name: 'Type into PTY' })).toBeDisabled();
        expect(mockInvoke).not.toHaveBeenCalledWith('ssh_detached_ready', expect.anything());
    });
});
