import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const { mockTerm } = vi.hoisted(() => ({ mockTerm: { instance: null } }));

vi.mock('@xterm/xterm', () => ({
    Terminal: class {
        constructor() {
            mockTerm.instance = this;
            this.dataListener = null;
            this._core = { coreService: {
                triggerDataEvent: (data) => this.dataListener?.(data),
            } };
            this.queue = [];
            this.text = '';
            this.write = vi.fn((data, done) => this.queue.push({ data, done }));
            this.buffer = { active: { length: 1, getLine: () => ({ translateToString: () => this.text }) } };
        }
        loadAddon() {}
        open() {}
        onData(listener) { this.dataListener = listener; return { dispose: () => { this.dataListener = null; } }; }
        attachCustomKeyEventHandler() {}
        dispose() {}
        drain() {
            for (const { data, done } of this.queue.splice(0)) {
                this.text += data;
                done?.();
            }
        }
    },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} } }));
import XtermSshView from '../src/components/terminal/XtermSshView';

describe('UR-FINAL-005 xterm write barrier', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => { cleanup(); vi.useRealTimers(); });

    const mount = () => {
        let controller;
        const view = render(<XtermSshView sessionId="pty-test" isVisible={false}
            registerController={(_, value) => { controller = value; }} />);
        return { ...view, controller };
    };

    test('snapshot waits for the xterm parse callback, including queued output', async () => {
        const { controller } = mount();
        controller.write('last line');
        const result = controller.flushBufferText();
        expect(controller.getBufferText()).toBe('');
        expect(mockTerm.instance.write).toHaveBeenLastCalledWith('', expect.any(Function));
        mockTerm.instance.drain();
        await expect(result).resolves.toBe('last line');
    });

    test('stalled parser is bounded and late callback cannot change the result', async () => {
        const { controller } = mount();
        const result = controller.flushBufferText();
        const rejected = expect(result).rejects.toThrow('Terminal flush timed out');
        await vi.advanceTimersByTimeAsync(5000);
        await rejected;
        mockTerm.instance.drain();
    });

    test('UR-FINAL-010 main parser replies survive ownership freeze; user input stays gated', () => {
        const onData = vi.fn();
        const onProtocolResponse = vi.fn();
        const { rerender } = render(<XtermSshView sessionId="pty-main" isVisible={false}
            controlledGeometry inputEnabled={false} onData={onData} onProtocolResponse={onProtocolResponse} />);
        const core = mockTerm.instance._core.coreService;
        core.triggerDataEvent('\x1b[3;4R');
        core.triggerDataEvent('\x1b[?1;2c', false);
        core.triggerDataEvent('typed', true);
        core.triggerDataEvent('\x1b[I', false);
        expect(onProtocolResponse.mock.calls).toEqual([['\x1b[3;4R'], ['\x1b[?1;2c']]);
        expect(onData).not.toHaveBeenCalled();
        rerender(<XtermSshView sessionId="pty-main" isVisible={false}
            controlledGeometry inputEnabled onData={onData} onProtocolResponse={onProtocolResponse} />);
        core.triggerDataEvent('typed', true);
        core.triggerDataEvent('\x1b[O', false);
        expect(onData.mock.calls).toEqual([['typed'], ['\x1b[O']]);
    });

    test('UR-FINAL-010 detached replay never replies even after becoming interactive', () => {
        const onData = vi.fn();
        render(<XtermSshView sessionId="pty-detached" isVisible={false}
            controlledGeometry inputEnabled onData={onData} />);
        const core = mockTerm.instance._core.coreService;
        core.triggerDataEvent('\x1b[7;8R', false);
        core.triggerDataEvent('\x1b[?1;2c', false);
        core.triggerDataEvent('\x1b[?1049;1$y', false);
        core.triggerDataEvent('user', true);
        expect(onData.mock.calls).toEqual([['user']]);
    });

    test('disposing the view cancels an outstanding flush', async () => {
        const { controller, unmount } = mount();
        const result = controller.flushBufferText();
        const rejected = expect(result).rejects.toThrow('Terminal view disposed');
        unmount();
        await rejected;
        mockTerm.instance.drain();
    });
});
