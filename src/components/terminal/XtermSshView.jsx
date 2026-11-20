import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * Real VT100 / xterm-256color terminal emulator view for interactive SSH PTY sessions.
 * Supports full-screen TUI apps (mc, htop, vim), hidden password prompts (sudo),
 * mouse selection, and automatic resize fitting.
 */
const XtermSshView = ({
    sessionId,
    isVisible,
    isFullscreen,
    onData,
    onResize,
    registerController,
}) => {
    const containerRef = useRef(null);
    const termRef = useRef(null);
    const fitAddonRef = useRef(null);
    const onDataRef = useRef(onData);
    const onResizeRef = useRef(onResize);
    onDataRef.current = onData;
    onResizeRef.current = onResize;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return undefined;

        let term = null;
        let fitAddon = null;
        let resizeObserver = null;
        let dataDisposable = null;

        try {
            term = new XTerm({
                cursorBlink: true,
                convertEol: false,
                fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
                fontSize: 13,
                lineHeight: 1.25,
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
            term.open(container);

            termRef.current = term;
            fitAddonRef.current = fitAddon;

            const safeFit = () => {
                if (!fitAddonRef.current || !termRef.current) return;
                try {
                    fitAddonRef.current.fit();
                    if (termRef.current.cols > 0 && termRef.current.rows > 0) {
                        onResizeRef.current?.(termRef.current.cols, termRef.current.rows);
                    }
                } catch {
                    // Ignore fit errors when container has 0 dimensions
                }
            };

            requestAnimationFrame(safeFit);

            dataDisposable = term.onData((data) => {
                onDataRef.current?.(data);
            });

            // Support Ctrl+Shift+C (and Ctrl+C when text is selected) to copy
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
                resizeObserver.observe(container);
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
                    // Trim trailing empty lines
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
        if (!isVisible) return;
        const id = requestAnimationFrame(() => {
            try {
                fitAddonRef.current?.fit();
                if (termRef.current && termRef.current.cols > 0 && termRef.current.rows > 0) {
                    onResizeRef.current?.(termRef.current.cols, termRef.current.rows);
                }
                termRef.current?.focus();
            } catch {
                // ignore
            }
        });
        return () => cancelAnimationFrame(id);
    }, [isVisible, isFullscreen]);

    return (
        <div
            ref={containerRef}
            className="xterm-ssh-container"
            style={{
                width: '100%',
                height: '100%',
                display: isVisible ? 'block' : 'none',
                padding: '6px 8px',
                boxSizing: 'border-box',
                backgroundColor: '#14161a',
                overflow: 'hidden',
            }}
        />
    );
};

export default XtermSshView;
