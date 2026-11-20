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
    onResize,
    registerController,
}) => {
    const mountRef = useRef(null);
    const termRef = useRef(null);
    const fitAddonRef = useRef(null);
    const onDataRef = useRef(onData);
    const onResizeRef = useRef(onResize);
    const writeQueueRef = useRef(Promise.resolve());
    onDataRef.current = onData;
    onResizeRef.current = onResize;

    useEffect(() => {
        const mountEl = mountRef.current;
        if (!mountEl) return undefined;

        let term = null;
        let fitAddon = null;
        let resizeObserver = null;
        let dataDisposable = null;
        let lastCols = 0;
        let lastRows = 0;

        try {
            term = new XTerm({
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
                if (!fitAddonRef.current || !termRef.current || !mountRef.current) return;
                if (mountRef.current.clientWidth < 20 || mountRef.current.clientHeight < 20) return;
                try {
                    fitAddonRef.current.fit();
                    const { cols, rows } = termRef.current;
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

            // Serialize PTY writes to preserve strict keystroke ordering across async IPC
            dataDisposable = term.onData((data) => {
                writeQueueRef.current = writeQueueRef.current
                    .then(() => onDataRef.current?.(data))
                    .catch(() => {});
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

            registerController?.(sessionId, {
                write: (chunk) => {
                    termRef.current?.write(chunk);
                },
                focus: () => {
                    termRef.current?.focus();
                },
                clear: () => {
                    termRef.current?.clear();
                },
                fit: safeFit,
                getBufferText: () => {
                    const t = termRef.current;
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
                },
            });
        } catch {
            // Non-canvas test environments (e.g. jsdom) cannot mount xterm canvas
        }

        return () => {
            registerController?.(sessionId, null);
            if (resizeObserver) resizeObserver.disconnect();
            if (dataDisposable) dataDisposable.dispose();
            if (term) term.dispose();
            termRef.current = null;
            fitAddonRef.current = null;
        };
    }, [sessionId]);

    useEffect(() => {
        if (!isVisible) return undefined;
        const fitNow = () => {
            try {
                fitAddonRef.current?.fit();
                if (termRef.current && termRef.current.cols > 0 && termRef.current.rows > 0) {
                    onResizeRef.current?.(termRef.current.cols, termRef.current.rows);
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
    }, [isVisible, isFullscreen]);

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
