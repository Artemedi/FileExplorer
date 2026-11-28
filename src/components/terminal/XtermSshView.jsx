import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

/**
 * Real VT100 / xterm-256color terminal emulator view for interactive SSH PTY sessions.
 * Uses a zero-padding inner mount element inside a flex-1 wrapper so FitAddon calculates
 * exact cols/rows for TUI apps (mc, htop, vim) without line-wrapping artifacts.
 */
const XtermSshView = ({
    sessionId,
    isVisible,
    isFullscreen,
    onData,
    onProtocolResponse,
    onResize,
    registerController,
    controlledGeometry = false,
    inputEnabled = true,
}) => {
    const mountRef = useRef(null);
    const termRef = useRef(null);
    const fitAddonRef = useRef(null);
    const onDataRef = useRef(onData);
    const onProtocolResponseRef = useRef(onProtocolResponse);
    const onResizeRef = useRef(onResize);
    onDataRef.current = onData;
    onProtocolResponseRef.current = onProtocolResponse;
    onResizeRef.current = onResize;
    const inputEnabledRef = useRef(inputEnabled);
    inputEnabledRef.current = inputEnabled;

    useEffect(() => {
        const mountEl = mountRef.current;
        if (!mountEl) return undefined;

        let term = null;
        let fitAddon = null;
        let resizeObserver = null;
        let dataDisposable = null;
        let lastCols = 0;
        let lastRows = 0;
        let cancelFlush = null;
        let restoreDataRouting = null;

        try {
            term = new XTerm({
                ...(controlledGeometry ? { cols: 100, rows: 30 } : {}),
                cursorBlink: true,
                convertEol: false,
                customGlyphs: true,
                fontFamily: "'Consolas', 'Courier New', monospace",
                fontSize: 13,
                lineHeight: 1.0,
                letterSpacing: 0,
                scrollback: 5000,
                theme: {
                    background: '#14161a',
                    foreground: '#e5e7eb',
                    cursor: '#3b82f6',
                    selectionBackground: 'rgba(59, 130, 246, 0.35)',
                },
            });
            fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.open(mountEl);

            // Enable GPU-accelerated WebGL cell grid rendering for crisp box-drawing (mc/btop/htop)
            try {
                const webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => {
                    try {
                        webglAddon.dispose();
                    } catch {
                        // ignore
                    }
                });
                term.loadAddon(webglAddon);
            } catch {
                // Fallback to DOM renderer when WebGL is unavailable
            }

            termRef.current = term;
            fitAddonRef.current = fitAddon;

            const safeFit = () => {
                if (!inputEnabledRef.current || !fitAddonRef.current || !termRef.current || !mountRef.current) return;
                if (mountRef.current.clientWidth < 20 || mountRef.current.clientHeight < 20) return;
                try {
                    const dimensions = controlledGeometry ? fitAddonRef.current.proposeDimensions() : (fitAddonRef.current.fit(), termRef.current);
                    if (!dimensions) return;
                    const { cols, rows } = dimensions;
                    if (cols > 0 && rows > 0 && (cols !== lastCols || rows !== lastRows)) {
                        lastCols = cols;
                        lastRows = rows;
                        onResizeRef.current?.(cols, rows);
                    }
                } catch {
                    // Ignore fit errors when container is hidden
                }
            };

            requestAnimationFrame(() => {
                safeFit();
                setTimeout(safeFit, 80);
            });

            // xterm 6.0.0 (lockfile) merges parser replies and human input in
            // public onData. Preserve its internal origin bit before that
            // merge. Focus reports are view-local, not replayable replies.
            // Main is the single reply source; detached replay never replies.
            if (controlledGeometry) {
                const core = term._core?.coreService;
                if (typeof core?.triggerDataEvent !== 'function') {
                    throw new Error('Unsupported xterm protocol response routing');
                }
                const trigger = core.triggerDataEvent;
                core.triggerDataEvent = function (data, wasUserInput = false) {
                    if (wasUserInput || data === '\x1b[I' || data === '\x1b[O') {
                        return trigger.call(this, data, wasUserInput);
                    }
                    onProtocolResponseRef.current?.(data);
                };
                restoreDataRouting = () => { core.triggerDataEvent = trigger; };
            }

            // The terminal owner bounds and serializes all PTY input.
            dataDisposable = term.onData((data) => {
                if (inputEnabledRef.current) onDataRef.current?.(data);
            });

            term.attachCustomKeyEventHandler((ev) => {
                if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === 'c') {
                    const sel = term.getSelection();
                    if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
                    return false;
                }
                if (ev.type === 'keydown' && ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === 'c' && term.hasSelection()) {
                    const sel = term.getSelection();
                    if (sel) {
                        navigator.clipboard?.writeText(sel).catch(() => {});
                        term.clearSelection();
                        return false;
                    }
                }
                return true;
            });

            if (typeof ResizeObserver !== 'undefined') {
                resizeObserver = new ResizeObserver(() => {
                    safeFit();
                });
                resizeObserver.observe(mountEl);
            }

            const getBufferText = () => {
                const t = termRef.current === term ? term : null;
                if (!t?.buffer?.active) return '';
                const lines = [];
                const buf = t.buffer.active;
                for (let i = 0; i < buf.length; i++) {
                    const line = buf.getLine(i);
                    if (line) lines.push(line.translateToString(true));
                }
                while (lines.length > 0 && lines[lines.length - 1] === '') {
                    lines.pop();
                }
                return lines.join('\n');
            };

            const applyFrame = (frame) => {
                if (termRef.current !== term) return;
                if (frame.cols && frame.rows) {
                    const { cols, rows } = frame;
                    term.write('', () => {
                        if (termRef.current === term && (term.cols !== cols || term.rows !== rows)) term.resize(cols, rows);
                    });
                } else if (frame.clear) {
                    term.write('', () => { if (termRef.current === term) term.clear(); });
                } else if (frame.data) {
                    term.write(frame.data);
                }
            };
            registerController?.(sessionId, {
                applyFrame,
                write: (chunk) => {
                    termRef.current?.write(chunk);
                },
                focus: () => {
                    termRef.current?.focus();
                },
                clear: () => {
                    termRef.current?.clear();
                },
                fit: () => { lastCols = 0; lastRows = 0; safeFit(); },
                getBufferText,
                flushBufferText: (collectText = true) => new Promise((resolve, reject) => {
                    if (cancelFlush) { reject(new Error("Terminal flush already pending")); return; }
                    // xterm.write callbacks run after parsing, not on enqueue.
                    // Bound the wait and cancel it if the view is disposed.
                    const finish = (error) => {
                        if (cancelFlush !== cancel) return;
                        cancelFlush = null;
                        clearTimeout(timer);
                        if (error) reject(error);
                        else {
                            try {
                                resolve(collectText ? getBufferText() : undefined);
                            } catch (e) {
                                reject(e);
                            }
                        }
                    };
                    const cancel = () => finish(new Error('Terminal view disposed'));
                    const timer = setTimeout(() => finish(new Error('Terminal flush timed out')), 5000);
                    cancelFlush = cancel;
                    try {
                        term.write('', () => finish());
                    } catch (e) {
                        finish(e);
                    }
                }),
            });
        } catch {
            // Non-canvas test environments (e.g. jsdom) cannot mount xterm canvas
        }

        return () => {
            cancelFlush?.();
            registerController?.(sessionId, null);
            if (resizeObserver) resizeObserver.disconnect();
            if (dataDisposable) dataDisposable.dispose();
            restoreDataRouting?.();
            if (term) term.dispose();
            termRef.current = null;
            fitAddonRef.current = null;
        };
    }, [sessionId]);

    useEffect(() => {
        if (!isVisible || !inputEnabled) return undefined;
        const fitNow = () => {
            try {
                const dimensions = controlledGeometry ? fitAddonRef.current?.proposeDimensions() : (fitAddonRef.current?.fit(), termRef.current);
                if (dimensions && dimensions.cols > 0 && dimensions.rows > 0) {
                    onResizeRef.current?.(dimensions.cols, dimensions.rows);
                }
                termRef.current?.focus();
            } catch {
                // ignore
            }
        };
        const id = requestAnimationFrame(fitNow);
        const t = setTimeout(fitNow, 80);
        return () => {
            cancelAnimationFrame(id);
            clearTimeout(t);
        };
    }, [isVisible, isFullscreen, inputEnabled, controlledGeometry]);

    return (
        <div
            className="xterm-ssh-wrapper"
            style={{
                flex: 1,
                minHeight: 0,
                width: '100%',
                display: isVisible ? 'flex' : 'none',
                padding: '4px 6px',
                boxSizing: 'border-box',
                backgroundColor: '#14161a',
                overflow: 'hidden',
            }}
        >
            <div
                ref={mountRef}
                className="xterm-ssh-container"
                style={{
                    width: '100%',
                    height: '100%',
                    padding: 0,
                    margin: 0,
                    overflow: 'hidden',
                }}
            />
        </div>
    );
};

export default XtermSshView;
