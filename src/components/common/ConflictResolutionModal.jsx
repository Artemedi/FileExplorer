import React, { useEffect, useRef, useState } from 'react';
import { buildSuggestedName, registerConflictHandler } from '../../utils/conflictResolver';

/**
 * Global modal for resolving file/directory copy & paste conflicts:
 * Replace existing, Insert renamed copy, Rename original, or Skip.
 */
const ConflictResolutionModal = () => {
    const [request, setRequest] = useState(null);
    const [newCopyName, setNewCopyName] = useState('');
    const [renameOrigName, setRenameOrigName] = useState('');
    const resolverRef = useRef(null);

    useEffect(() => {
        registerConflictHandler((params) => {
            return new Promise((resolve) => {
                resolverRef.current = resolve;
                setNewCopyName(buildSuggestedName(params.itemName, ' (copy)'));
                setRenameOrigName(buildSuggestedName(params.itemName, '_old'));
                setRequest(params);
            });
        });
        return () => registerConflictHandler(null);
    }, []);

    if (!request) return null;

    const finish = (result) => {
        const resolve = resolverRef.current;
        resolverRef.current = null;
        setRequest(null);
        if (resolve) resolve(result);
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0, 0, 0, 0.65)',
                zIndex: 10000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '16px',
            }}
            onClick={() => finish({ action: 'skip' })}
        >
            <div
                style={{
                    width: '100%',
                    maxWidth: '480px',
                    background: 'var(--bg-secondary, #1b1e23)',
                    border: '1px solid var(--border, #2a2d32)',
                    borderRadius: '10px',
                    padding: '18px 20px',
                    color: 'var(--text-primary, #f3f4f6)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>Conflict: "{request.itemName}" already exists</h3>
                    <button
                        type="button"
                        onClick={() => finish({ action: 'skip' })}
                        style={{ background: 'transparent', border: 'none', color: 'inherit', fontSize: '18px', cursor: 'pointer' }}
                    >
                        ×
                    </button>
                </div>

                <div style={{ fontSize: '12px', opacity: 0.8, wordBreak: 'break-all' }}>
                    Destination: <code>{request.destPath}</code>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {!request.isSameLocation && (
                        <button
                            type="button"
                            onClick={() => finish({ action: 'replace' })}
                            style={{
                                padding: '8px 12px',
                                borderRadius: '6px',
                                border: 'none',
                                background: '#dc2626',
                                color: '#fff',
                                fontWeight: 600,
                                cursor: 'pointer',
                                textAlign: 'left',
                            }}
                        >
                            Replace existing item
                        </button>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px', borderRadius: '6px', border: '1px solid var(--border, #2a2d32)' }}>
                        <div style={{ fontSize: '12px', fontWeight: 600 }}>Insert renamed duplicate:</div>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <input
                                type="text"
                                value={newCopyName}
                                onChange={(e) => setNewCopyName(e.target.value)}
                                style={{ flex: 1, padding: '6px 8px', borderRadius: '5px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                            />
                            <button
                                type="button"
                                disabled={!newCopyName.trim()}
                                onClick={() => finish({ action: 'rename_new', customName: newCopyName.trim() })}
                                style={{ padding: '6px 12px', borderRadius: '5px', border: 'none', background: 'var(--accent, #0672ef)', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
                            >
                                Insert Copy
                            </button>
                        </div>
                    </div>

                    {!request.isSameLocation && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px', borderRadius: '6px', border: '1px solid var(--border, #2a2d32)' }}>
                            <div style={{ fontSize: '12px', fontWeight: 600 }}>Rename original and keep new name:</div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <input
                                    type="text"
                                    value={renameOrigName}
                                    onChange={(e) => setRenameOrigName(e.target.value)}
                                    style={{ flex: 1, padding: '6px 8px', borderRadius: '5px', background: '#111317', color: 'inherit', border: '1px solid var(--border, #2a2d32)' }}
                                />
                                <button
                                    type="button"
                                    disabled={!renameOrigName.trim()}
                                    onClick={() => finish({ action: 'rename_original', customName: renameOrigName.trim() })}
                                    style={{ padding: '6px 12px', borderRadius: '5px', border: 'none', background: '#059669', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
                                >
                                    Rename Original
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={() => finish({ action: 'skip' })}
                        style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--border, #2a2d32)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                    >
                        Skip
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ConflictResolutionModal;
