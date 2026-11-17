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

    const separator = detectPathSeparator(fullPath);
    const lastSeparatorIndex = fullPath.lastIndexOf(separator);

    if (lastSeparatorIndex === -1) {
        return fullPath; // No separator found, return as is
    }

    // For root directories, keep the separator
    if (lastSeparatorIndex === 0 && separator === '/') {
        return '/';
    }
    if (lastSeparatorIndex === 2 && fullPath.charAt(1) === ':' && separator === '\\') {
        return fullPath.substring(0, 3); // Keep "C:\" format
    }

    return fullPath.substring(0, lastSeparatorIndex);
};

/**
 * Get the filename from a full path.
 * @param fullPath - The full path.
 * @returns The filename.
 */
export const getFileName = (fullPath?: string | null): string => {
    if (!fullPath) return '';

    const separator = detectPathSeparator(fullPath);
    const lastSeparatorIndex = fullPath.lastIndexOf(separator);

    if (lastSeparatorIndex === -1) {
        return fullPath; // No separator found, return as is
    }

    return fullPath.substring(lastSeparatorIndex + 1);
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
    if (dirPath === '/' || (dirPath.length === 3 && dirPath.charAt(1) === ':' && dirPath.charAt(2) === '\\')) {
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
    if (segments.length === 0) return '';

    // Detect separator from the first segment that contains one
    let separator = '/';
    for (const segment of segments) {
        if (segment && typeof segment === 'string') {
            separator = detectPathSeparator(segment);
            break;
        }
    }

    return segments
        .filter((segment): segment is string => Boolean(segment && typeof segment === 'string'))
        .map((segment, index) => {
            // Remove leading/trailing separators except for the first segment
            if (index === 0) {
                return segment.replace(new RegExp(`\\${separator}+$`, 'g'), '');
            }
            return segment.replace(new RegExp(`^\\${separator}+|\\${separator}+$`, 'g'), '');
        })
        .join(separator);
};

/**
 * Normalize a path by removing redundant separators and handling edge cases.
 * @param path - The path to normalize.
 * @returns The normalized path.
 */
export const normalizePath = (path?: string | null): string => {
    if (!path) return '';

    const separator = detectPathSeparator(path);

    // Replace multiple separators with single separator
    const normalizedPath = path.replace(new RegExp(`\\${separator}+`, 'g'), separator);

    // Handle trailing separator (keep for root directories)
    if (normalizedPath === separator) {
        return normalizedPath;
    }
    if (normalizedPath.length === 3 && normalizedPath.charAt(1) === ':' && normalizedPath.charAt(2) === separator) {
        return normalizedPath; // Keep "C:\" format
    }

    // Remove trailing separator for other paths
    return normalizedPath.replace(new RegExp(`\\${separator}$`), '');
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

    // Windows drive root (C:\, D:\, etc.)
    if (path.length === 3 && path.charAt(1) === ':' && path.charAt(2) === '\\') {
        return true;
    }

    return false;
};
