/**
 * Path utility functions for cross-platform path handling
 */

/**
 * Detect the path separator based on the given path or platform.
 * @param path - A sample path to detect the separator from.
 * @returns The path separator ('/' or '\\').
 */
export const detectPathSeparator = (path?: string | null): string => {
    if (path && path.includes('\\')) {
        return '\\';
    }
    return '/';
};

/**
 * Get the directory path from a full file/directory path.
 * @param fullPath - The full path.
 * @returns The directory path.
 */
export const getDirectoryPath = (fullPath?: string | null): string => {
    if (!fullPath) return '';

    const normalized = fullPath.replace(/[/\\]+$/, '') || fullPath;
    const lastForward = normalized.lastIndexOf('/');
    const lastBackward = normalized.lastIndexOf('\\');
    const lastSeparatorIndex = Math.max(lastForward, lastBackward);

    if (lastSeparatorIndex === -1) {
        return fullPath; // No separator found, return as is
    }

    // For root directories, keep the separator
    if (lastSeparatorIndex === 0 && (normalized.charAt(0) === '/' || normalized.charAt(0) === '\\')) {
        return normalized.charAt(0);
    }
    if (lastSeparatorIndex === 2 && normalized.charAt(1) === ':') {
        return normalized.substring(0, 3); // Keep "C:\" or "C:/" format
    }

    return normalized.substring(0, lastSeparatorIndex);
};

/**
 * Get the filename from a full path.
 * @param fullPath - The full path.
 * @returns The filename.
 */
export const getFileName = (fullPath?: string | null): string => {
    if (!fullPath) return '';

    const trimmed = fullPath.length > 3 ? fullPath.replace(/[/\\]+$/, '') : fullPath;
    const lastSeparatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));

    if (lastSeparatorIndex === -1) {
        return trimmed; // No separator found, return as is
    }

    return trimmed.substring(lastSeparatorIndex + 1);
};

/**
 * Create a new path by replacing the filename in a full path.
 * @param fullPath - The original full path.
 * @param newFileName - The new filename.
 * @returns The new full path.
 */
export const replaceFileName = (fullPath: string, newFileName: string): string => {
    if (!fullPath || !newFileName) return fullPath;

    const dirPath = getDirectoryPath(fullPath);
    const separator = detectPathSeparator(fullPath);

    // Handle root directory cases
    if (dirPath === '/' || (dirPath.length === 3 && dirPath.charAt(1) === ':' && (dirPath.charAt(2) === '\\' || dirPath.charAt(2) === '/'))) {
        return dirPath + newFileName;
    }

    return dirPath + separator + newFileName;
};

/**
 * Join path segments using the appropriate separator.
 * @param segments - Path segments to join.
 * @returns The joined path.
 */
export const joinPath = (...segments: (string | undefined | null)[]): string => {
    const validSegments = segments.filter(
        (segment): segment is string => Boolean(segment && typeof segment === 'string')
    );
    if (validSegments.length === 0) return '';

    // Detect separator from the first segment that explicitly contains one
    let separator = '/';
    for (const segment of validSegments) {
        if (segment.includes('\\')) {
            separator = '\\';
            break;
        }
        if (segment.includes('/')) {
            separator = '/';
            break;
        }
    }

    // Preserve Windows drive/Unix root if single root segment
    if (validSegments.length === 1) {
        const only = validSegments[0];
        if (only === '/' || /^[A-Za-z]:[/\\]$/.test(only)) {
            return only;
        }
    }

    return validSegments
        .map((segment, index) => {
            if (index === 0) {
                if (segment === '/' || segment === '\\') {
                    return '';
                }
                return segment.replace(/[/\\]+$/g, '');
            }
            return segment.replace(/^[/\\]+|[/\\]+$/g, '');
        })
        .join(separator) || (validSegments[0].startsWith('/') ? '/' : '');
};

/**
 * Normalize a path by removing redundant separators and handling edge cases.
 * @param path - The path to normalize.
 * @returns The normalized path.
 */
export const normalizePath = (path?: string | null): string => {
    if (!path) return '';

    const separator = detectPathSeparator(path);
    const isUnc = path.startsWith('\\\\');

    // Replace multiple separators with single separator
    const normalizedPath = path.replace(new RegExp(`\\${separator}+`, 'g'), separator);
    const restoredPath = isUnc ? '\\' + normalizedPath : normalizedPath;

    // Handle trailing separator (keep for root directories)
    if (restoredPath === separator || restoredPath === '\\\\') {
        return restoredPath;
    }
    if (restoredPath.length === 3 && restoredPath.charAt(1) === ':' && (restoredPath.charAt(2) === '\\' || restoredPath.charAt(2) === '/')) {
        return restoredPath; // Keep "C:\" format
    }

    // Remove trailing separator for other paths
    return restoredPath.replace(new RegExp(`\\${separator}$`), '');
};

/**
 * Check if a path is a root path.
 * @param path - The path to check.
 * @returns True if it's a root path.
 */
export const isRootPath = (path?: string | null): boolean => {
    if (!path) return false;

    // Unix root
    if (path === '/') return true;

    // Windows drive root (C:\, C:/, D:\, etc.)
    if (path.length === 3 && /^[A-Za-z]:[/\\]$/.test(path)) {
        return true;
    }

    return false;
};
