import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const { mockTerm } = vi.hoisted(() => ({ mockTerm: { instance: null } }));

vi.mock('@xterm/xterm', () => ({
    Terminal: class {
        constructor() {
            mockTerm.instance = this;
            this.queue = [];
            this.text = '';
            this.write = vi.fn((data, done) => this.queue.push({ data, done }));
            this.buffer = { active: { length: 1, getLine: () => ({ translateToString: () => this.text }) } };
        }
        loadAddon() {}
        open() {}
        onData() { return { dispose() {} }; }
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

    test('disposing the view cancels an outstanding flush', async () => {
        const { controller, unmount } = mount();
        const result = controller.flushBufferText();
        const rejected = expect(result).rejects.toThrow('Terminal view disposed');
        unmount();
        await rejected;
        mockTerm.instance.drain();
    });
});
