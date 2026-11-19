/**
 * Path utility functions for cross-platform path handling
 */

const isSftpUrl = (path: string): boolean => path.startsWith('sftp://');
const isSftpCustom = (path: string): boolean => path.startsWith('sftp:') && !path.startsWith('sftp://');
const isSftpAny = (path: string): boolean => path.startsWith('sftp:');

/**
 * Detect the path separator based on the given path or platform.
 * @param path - A sample path to detect the separator from.
 * @returns The path separator ('/' or '\\').
 */
export const detectPathSeparator = (path?: string | null): string => {
    if (path && isSftpAny(path)) {
        return '/';
    }
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

    // SFTP URL: sftp://user@host:port/path/to/file
    if (isSftpUrl(fullPath)) {
        const schemeEnd = 'sftp://'.length;
        const firstSlash = fullPath.indexOf('/', schemeEnd);
        if (firstSlash === -1) {
            return fullPath;
        }
        const trimmed = fullPath.replace(/\/+$/, '');
        if (trimmed.length <= firstSlash) {
            return fullPath.substring(0, firstSlash + 1);
        }
        const lastSlash = trimmed.lastIndexOf('/');
        if (lastSlash <= firstSlash) {
            return fullPath.substring(0, firstSlash + 1);
        }
        return trimmed.substring(0, lastSlash);
    }

    // SFTP custom format: sftp:connectionName:remote/path
    if (isSftpCustom(fullPath)) {
        const firstColon = fullPath.indexOf(':');
        const secondColon = fullPath.indexOf(':', firstColon + 1);
        if (secondColon !== -1) {
            const prefix = fullPath.substring(0, secondColon + 1);
            const remote = fullPath.substring(secondColon + 1).replace(/\/+$/, '');
            if (!remote || remote === '.') {
                return prefix + (remote || '');
            }
            const lastSlash = remote.lastIndexOf('/');
            if (lastSlash === -1) {
                return prefix;
            }
            if (lastSlash === 0) {
                return prefix + '/';
            }
            return prefix + remote.substring(0, lastSlash);
        }
    }

    // Windows drive root (e.g. "C:\", "c:/", "C:")
    if (/^[A-Za-z]:[/\\]*$/.test(fullPath)) {
        return `${fullPath.substring(0, 2)}${fullPath.charAt(2) === '/' ? '/' : '\\'}`;
    }

    // UNC root (e.g. "\\server\share" or "\\server\share\" or "\\server")
    const trimmedUnc = fullPath.replace(/[/\\]+$/, '');
    if (/^\\\\[^\\]+(?:\\[^\\]+)?$/.test(trimmedUnc)) {
        return trimmedUnc;
    }

    const normalized = fullPath.replace(/[/\\]+$/, '') || fullPath;
    const lastForward = normalized.lastIndexOf('/');
    const lastBackward = normalized.lastIndexOf('\\');
    const lastSeparatorIndex = Math.max(lastForward, lastBackward);

    if (lastSeparatorIndex === -1) {
        return '';
    }

    // For root directories, keep the separator
    if (lastSeparatorIndex === 0 && (normalized.charAt(0) === '/' || normalized.charAt(0) === '\\')) {
        return normalized.charAt(0);
    }
    if (lastSeparatorIndex === 2 && /^[A-Za-z]:$/.test(normalized.substring(0, 2))) {
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

    if (isSftpCustom(fullPath)) {
        const firstColon = fullPath.indexOf(':');
        const secondColon = fullPath.indexOf(':', firstColon + 1);
        if (secondColon !== -1) {
            const remote = fullPath.substring(secondColon + 1).replace(/\/+$/, '');
            if (!remote) return '';
            const lastSlash = remote.lastIndexOf('/');
            return lastSlash === -1 ? remote : remote.substring(lastSlash + 1);
        }
    }

    const trimmed = fullPath.length > 3 ? fullPath.replace(/[/\\]+$/, '') : fullPath;
    const lastSeparatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));

    if (lastSeparatorIndex === -1) {
        return trimmed;
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
    if (!dirPath) {
        return newFileName;
    }

    const separator = detectPathSeparator(fullPath);

    // Handle root directory or SFTP prefix cases
    if (
        dirPath === '/' ||
        /^[A-Za-z]:[/\\]$/.test(dirPath) ||
        (isSftpCustom(dirPath) && dirPath.endsWith(':'))
    ) {
        return dirPath + newFileName;
    }

    if (dirPath.endsWith(separator) || (isSftpUrl(dirPath) && dirPath.endsWith('/'))) {
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

    const first = validSegments[0];
    const isSftp = isSftpAny(first);

    // Detect separator from the first segment that explicitly contains one (SFTP always uses '/')
    let separator = '/';
    if (!isSftp) {
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
    }

    // Preserve single root segment
    if (validSegments.length === 1) {
        if (first === '/' || /^[A-Za-z]:[/\\]$/.test(first) || /^\\\\[^\\]+\\[^\\]+$/.test(first)) {
            return first;
        }
    }

    // Handle SFTP custom prefix ending in ':' (e.g. joinPath('sftp:conn:', 'sub\\file'))
    if (isSftpCustom(first) && first.endsWith(':') && validSegments.length > 1) {
        const rest = validSegments
            .slice(1)
            .map(s => s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
            .filter(Boolean)
            .join('/');
        return first + rest;
    }

    return validSegments
        .map((segment, index) => {
            const cleanSeg = isSftp ? segment.replace(/\\/g, '/') : segment;
            if (index === 0) {
                if (cleanSeg === '/' || cleanSeg === '\\') {
                    return '';
                }
                if (isSftpUrl(cleanSeg)) {
                    return cleanSeg.replace(/\/+$/, '');
                }
                return cleanSeg.replace(/[/\\]+$/g, '');
            }
            return cleanSeg.replace(/^[/\\]+|[/\\]+$/g, '');
        })
        .join(separator) || (first.startsWith('/') ? '/' : '');
};

/**
 * Normalize a path by removing redundant separators and handling edge cases.
 * @param path - The path to normalize.
 * @returns The normalized path.
 */
export const normalizePath = (path?: string | null): string => {
    if (!path) return '';

    // Preserve sftp:// scheme
    if (isSftpUrl(path)) {
        const scheme = 'sftp://';
        const rest = path.slice(scheme.length).replace(/[/\\]+/g, '/');
        const firstSlash = rest.indexOf('/');
        if (firstSlash === -1) {
            return scheme + rest;
        }
        if (firstSlash === rest.length - 1) {
            return scheme + rest;
        }
        return scheme + rest.replace(/\/+$/, '');
    }

    // Preserve sftp:<name>: prefix
    if (isSftpCustom(path)) {
        const firstColon = path.indexOf(':');
        const secondColon = path.indexOf(':', firstColon + 1);
        if (secondColon !== -1) {
            const prefix = path.substring(0, secondColon + 1);
            const remote = path.substring(secondColon + 1).replace(/[/\\]+/g, '/');
            if (remote === '/') return prefix + '/';
            return prefix + remote.replace(/\/+$/, '');
        }
    }

    const separator = detectPathSeparator(path);
    const isUnc = path.startsWith('\\\\');

    // Collapse redundant mixed separators into the detected separator
    const body = isUnc ? path.slice(2) : path;
    const normalizedBody = body.replace(/[/\\]+/g, separator);
    const restoredPath = isUnc ? `\\\\${normalizedBody}` : normalizedBody;

    // Handle root directories
    if (restoredPath === separator || restoredPath === '\\\\') {
        return restoredPath;
    }
    if (/^[A-Za-z]:[/\\]$/.test(restoredPath)) {
        return restoredPath;
    }
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(restoredPath)) {
        return restoredPath.replace(/\\+$/, '');
    }

    return restoredPath.replace(/[/\\]+$/, '');
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

    // Windows drive root (C:\, c:/, D:\, etc.)
    if (/^[A-Za-z]:[/\\]$/.test(path)) {
        return true;
    }

    // UNC share root (\\server\share or \\server\share\)
    if (/^\\\\[^\\]+\\[^\\]+[/\\]?$/.test(path)) {
        return true;
    }

    // SFTP roots
    if (/^sftp:\/\/[^/]+\/?$/.test(path) || /^sftp:[^:]+:(\/|\.)?$/.test(path)) {
        return true;
    }

    return false;
};
