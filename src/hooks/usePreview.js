import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useSftp } from '../providers/SftpProvider';
import { formatErrorMessage } from '../utils/formatters';

/**
 * Hook for managing file/folder preview functionality
 * @param {Function} getFocusedItem - Function that returns the currently focused file/folder object
 * @param {Function} navigateUp - Function to navigate up one row
 * @param {Function} navigateDown - Function to navigate down one row  
 * @param {Function} navigateLeft - Function to navigate left one column
 * @param {Function} navigateRight - Function to navigate right one column
 * @param {boolean} isExplorerActive - Whether the explorer view is currently active
 * @returns {Object} Object containing preview state and control functions
 */
export function usePreview(
  getFocusedItem,
  navigateUp = null,
  navigateDown = null,
  navigateLeft = null,
  navigateRight = null,
  isExplorerActive = true
) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const previewRequestIdRef = useRef(0);
  const { isSftpPath, parseSftpPath } = useSftp();

  /**
   * Opens preview for the specified path
   * @param {string} path - Path to the file/folder to preview
   */
  const openPreview = useCallback(async (path) => {
    if (!path) return;

    const requestId = ++previewRequestIdRef.current;
    setIsLoading(true);
    try {
      let previewPayload;

      // Check if this is an SFTP path
      if (isSftpPath(path)) {
        const parsed = parseSftpPath(path);
        if (parsed && parsed.connection) {
          const port = Number(parsed.connection.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid SFTP port: ${parsed.connection.port}`);
          }
          // Use SFTP preview command
          previewPayload = await invoke('build_preview_sftp', {
            host: parsed.connection.host,
            port,
            username: parsed.connection.username,
            password: parsed.connection.password,
            filePath: parsed.remotePath
          });
        } else {
          throw new Error('Invalid SFTP path or connection not found');
        }
      } else {
        // Use regular preview command for local files
        previewPayload = await invoke('build_preview', { path });
      }

      if (previewRequestIdRef.current !== requestId) return;
      setPayload(previewPayload);
      setOpen(true);
    } catch (error) {
      if (previewRequestIdRef.current !== requestId) return;
      console.error('Failed to build preview:', error);
      setPayload({
        kind: 'Error',
        name: String(path).split(/[/\\]/).pop() || 'Unknown',
        message: formatErrorMessage(error) || 'Failed to generate preview'
      });
      setOpen(true);
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [isSftpPath, parseSftpPath]);

  /**
   * Closes the preview modal
   */
  const closePreview = useCallback(() => {
    previewRequestIdRef.current += 1;
    setIsLoading(false);
    setOpen(false);
    setPayload(null);
  }, []);

  /**
   * Toggles preview for the currently focused item (files and folders)
   */
  const togglePreview = useCallback(() => {
    if (open) {
      closePreview();
      return;
    }

    const focusedItem = getFocusedItem();
    if (focusedItem && focusedItem.path) {
      openPreview(focusedItem.path);
    }
  }, [open, closePreview, openPreview, getFocusedItem]);

  // Keyboard event handler
  useEffect(() => {
    const onKey = (e) => {
      // Don't trigger if we're typing in an input or activating a button/link
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable ||
        (target instanceof HTMLElement && target.closest('button, a, [role="button"]'))
      ) {
        return;
      }

      // Spacebar toggles preview
      if (e.key === ' ') {
        if (!open && !isLoading) {
          if (!isExplorerActive) return;
          if (target instanceof Element && target.closest('.enhanced-terminal, .details-panel')) {
            return;
          }
          if (document.querySelector('[role="dialog"], .modal-overlay, .preview-modal-backdrop')) {
            return;
          }
        }
        e.preventDefault();
        togglePreview();
      }
      // Escape closes preview (including while loading)
      else if (e.key === 'Escape' && (open || isLoading)) {
        e.preventDefault();
        e.stopPropagation();
        closePreview();
      }
      // Arrow keys navigate when preview is open
      else if (open && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        let navigationFunction = null;
        switch (e.key) {
          case 'ArrowUp':
            navigationFunction = navigateUp;
            break;
          case 'ArrowDown':
            navigationFunction = navigateDown;
            break;
          case 'ArrowLeft':
            navigationFunction = navigateLeft;
            break;
          case 'ArrowRight':
            navigationFunction = navigateRight;
            break;
        }
        if (navigationFunction) {
          const nextItem = navigationFunction();
          if (nextItem && nextItem.path) {
            openPreview(nextItem.path);
          } else {
            // Fallback if navigationFunction does not return the new item
            setTimeout(() => {
              const focused = getFocusedItem();
              if (focused && focused.path) {
                openPreview(focused.path);
              } else {
                closePreview();
              }
            }, 0);
          }
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isLoading, isExplorerActive, togglePreview, closePreview, navigateUp, navigateDown, navigateLeft, navigateRight, getFocusedItem, openPreview]);

  return { 
    open, 
    payload, 
    isLoading,
    openPreview,
    closePreview, 
    togglePreview 
  };
}

// Also export as default for compatibility
export default usePreview;
