import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import XtermSshView from './XtermSshView';
import './terminal.css';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_INPUT_ITEMS = 1024;
const POLL_DELAY = 35;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// This window deliberately does not instantiate Explorer or SFTP providers.
// Its identity is resolved in Rust from the actual calling WebView label.
export default function DetachedTerminal() {
    const [controller, setController] = useState(null);
    const [status, setStatus] = useState(null);
    const [sessionId, setSessionId] = useState(null);
    const [error, setError] = useState(null);
    const [transferring, setTransferring] = useState(false);
    const statusRef = useRef(null);
    const sessionRef = useRef(null);
    const transferRef = useRef(false);
    const inputReadyRef = useRef(false);
    const failedRef = useRef(false);
    const queueRef = useRef({ pending: [], bytes: 0, active: false });
    const registerController = useCallback((_, value) => setController(value), []);

    const applyStatus = (next) => {
        const previous = statusRef.current;
        if (previous && (next.epoch < previous.epoch || (next.epoch === previous.epoch &&
            next.phase === previous.phase && next.attach_requested === previous.attach_requested))) return;
        statusRef.current = next;
        setStatus(next);
    };

    const failInput = (message) => {
        const queue = queueRef.current;
        queue.pending.length = 0;
        queue.bytes = 0;
        failedRef.current = true;
        setError(message);
    };

    const drainInput = async () => {
        const queue = queueRef.current;
        if (queue.active) return;
        queue.active = true;
        try {
            while (queue.pending.length && !failedRef.current) {
                const item = queue.pending.shift();
                try {
                    const status = statusRef.current;
                    if (status?.phase !== 'detached') throw new Error('PTY owner changed');
                    await invoke('ssh_write_pty', {
                        sessionId: sessionRef.current, data: item.data, ownerEpoch: status.epoch,
                    });
                    queue.bytes = Math.max(0, queue.bytes - item.bytes);
                } catch (reason) {
                    failInput('SSH input paused: ' + String(reason) + '. Unsent input was discarded; submitted input may execute.');
                }
            }
        } finally {
            queue.active = false;
        }
    };

    const sendInput = (data) => {
        if (!data || !inputReadyRef.current || transferRef.current || failedRef.current ||
            statusRef.current?.phase !== 'detached') return;
        const queue = queueRef.current;
        const bytes = new TextEncoder().encode(data).byteLength;
        if (queue.bytes + bytes > MAX_INPUT_BYTES || queue.pending.length + Number(queue.active) >= MAX_INPUT_ITEMS) {
            failInput('SSH input queue is full. Unsent input was discarded; submitted input may execute.');
            return;
        }
        queue.pending.push({ data, bytes });
        queue.bytes += bytes;
        void drainInput();
    };

    const attach = async () => {
        const current = statusRef.current;
        if (!current || transferRef.current) return;
        transferRef.current = true;
        inputReadyRef.current = false;
        setTransferring(true);
        try {
            const deadline = Date.now() + 5000;
            while (queueRef.current.active || queueRef.current.pending.length) {
                if (Date.now() >= deadline) throw new Error('Pending terminal input did not drain');
                await delay(20);
            }
            await invoke('ssh_attach_pty', { ownerEpoch: current.epoch });
        } catch (reason) {
            setError(String(reason));
            transferRef.current = false;
            inputReadyRef.current = current.phase === 'detached';
            setTransferring(false);
        }
    };

    useEffect(() => {
        if (!controller) return undefined;
        let active = true;
        let cursor = 0;
        let bootstrapThrough = null;
        inputReadyRef.current = false;
        const run = async () => {
            try {
                while (active) {
                    if (transferRef.current) { await delay(POLL_DELAY); continue; }
                    const batch = await invoke('ssh_detached_read', { cursor });
                    if (!active) return;
                    if (transferRef.current) continue;
                    sessionRef.current = batch.session_id;
                    setSessionId(batch.session_id);
                    applyStatus(batch.status);
                    if (bootstrapThrough === null) bootstrapThrough = batch.latest;
                    for (const frame of batch.frames) {
                        if (frame.seq !== cursor + 1) throw new Error('VT output sequence gap');
                        controller.applyFrame(frame);
                        cursor = frame.seq;
                    }
                    if (batch.frames.length) await controller.flushBufferText(false);
                    if (!active) return;
                    if (batch.status.phase === 'detaching' && cursor >= bootstrapThrough) {
                        const ready = await invoke('ssh_detached_ready', { ownerEpoch: batch.status.epoch, cursor });
                        if (!active) return;
                        applyStatus(ready);
                    }
                    if (statusRef.current?.phase === 'detached') inputReadyRef.current = true;
                    if (batch.status.attach_requested) {
                        await attach();
                        continue;
                    }
                    if (cursor >= batch.latest) await delay(POLL_DELAY);
                }
            } catch (reason) {
                if (!active) return;
                inputReadyRef.current = false;
                setError(String(reason) + '. Return to the original terminal to recover the view.');
            }
        };
        void run();
        return () => { active = false; inputReadyRef.current = false; };
    }, [controller]);

    const stop = async () => {
        const current = statusRef.current;
        if (current?.phase !== 'detached' || transferRef.current) return;
        transferRef.current = true;
        inputReadyRef.current = false;
        setTransferring(true);
        queueRef.current.pending.length = 0;
        try {
            await invoke('ssh_close_pty', { sessionId: sessionRef.current, ownerEpoch: current.epoch });
        } catch (reason) {
            setError(String(reason));
            transferRef.current = false;
            setTransferring(false);
        }
    };

    const enabled = status?.phase === 'detached' && !transferring && !error;
    return (
        <main className="detached-terminal">
            <header className="terminal-header">
                <div className="detached-terminal-status">
                    <span className={enabled ? 'detached-terminal-dot connected' : 'detached-terminal-dot'} />
                    <span>{transferring ? 'Returning to Explorer…' : enabled ? 'Connected' : 'Restoring terminal…'}</span>
                    {sessionId && <small>{sessionId}</small>}
                </div>
                <div className="terminal-controls">
                    <button className="terminal-control" type="button" disabled={!status || transferring}
                        onClick={() => void attach()}>Attach to Main</button>
                    <button className="terminal-control detached-stop" type="button" disabled={!enabled}
                        onClick={() => void stop()}>Stop PTY</button>
                </div>
            </header>
            {error && <div role="alert" className="terminal-input-error">{error}
                {failedRef.current && <button className="terminal-control" onClick={() => {
                    failedRef.current = false;
                    setError(null);
                }}>Resume input</button>}
            </div>}
            <XtermSshView sessionId="detached-view" isVisible={true} isFullscreen={true}
                controlledGeometry={true} inputEnabled={enabled} registerController={registerController}
                onData={sendInput} onResize={(cols, rows) => {
                    const current = statusRef.current;
                    if (!inputReadyRef.current || transferRef.current || failedRef.current || current?.phase !== 'detached') return;
                    invoke('ssh_resize_pty', { sessionId: sessionRef.current, cols, rows, ownerEpoch: current.epoch })
                        .catch(reason => setError(String(reason)));
                }} />
        </main>
    );
}
