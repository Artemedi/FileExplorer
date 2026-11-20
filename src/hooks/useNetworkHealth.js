import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

/**
 * Periodically checks reachability and TCP latency (ms) for SFTP and SMB/UNC endpoints.
 * @param {Array<{id: string, host: string, port?: number|null, unc_path?: string|null}>} targets
 * @param {number} [intervalMs=10000]
 */
export function useNetworkHealth(targets, intervalMs = 30000) {
    const [statusesById, setStatusesById] = useState({});
    const [isChecking, setIsChecking] = useState(false);
    const targetsRef = useRef(targets);
    targetsRef.current = targets;

    const targetSignature = JSON.stringify(
        (targets || []).map((t) => [t.id, t.host, t.port ?? null, t.unc_path ?? null])
    );

    const refresh = useCallback(async () => {
        const currentTargets = targetsRef.current || [];
        if (currentTargets.length === 0) {
            setStatusesById({});
            return;
        }
        setIsChecking(true);
        try {
            const results = await invoke('check_network_endpoints', { targets: currentTargets });
            if (Array.isArray(results)) {
                const next = {};
                for (const item of results) {
                    if (item?.id) next[item.id] = item;
                }
                setStatusesById(next);
            }
        } catch {
            // Keep last known statuses if a probe fails transiently
        } finally {
            setIsChecking(false);
        }
    }, []);

    useEffect(() => {
        refresh();
        if (!targetsRef.current || targetsRef.current.length === 0) return undefined;
        const timer = setInterval(() => {
            if (typeof document === 'undefined' || !document.hidden) {
                refresh();
            }
        }, intervalMs);
        return () => clearInterval(timer);
    }, [targetSignature, intervalMs, refresh]);

    return { statusesById, isChecking, refresh };
}

/**
 * Formats a compact latency label for display.
 * @param {{reachable?: boolean, latency_ms?: number|null}|undefined} status
 * @returns {{ label: string, color: string, title: string }}
 */
export function getHealthDisplay(status) {
    if (!status) {
        return {
            label: '...',
            color: '#9ca3af',
            title: 'Checking endpoint reachability...',
        };
    }
    if (status.reachable) {
        const ms = typeof status.latency_ms === 'number' ? status.latency_ms : 0;
        const label = ms < 1 ? '<1 ms' : `${ms} ms`;
        const color = ms <= 80 ? '#22c55e' : ms <= 250 ? '#eab308' : '#f97316';
        return {
            label,
            color,
            title: `Online (${label})`,
        };
    }
    return {
        label: 'Offline',
        color: '#ef4444',
        title: 'Endpoint unreachable',
    };
}
