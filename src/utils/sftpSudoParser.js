/**
 * Parses output from `find -- <path> -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%T@\t%f\0'`
 * into the directory listing shape expected by FileList / SftpProvider.
 */
export function parseSudoFindOutput(stdout, connection, remotePath, createSftpUrl) {
    const directories = [];
    const files = [];

    if (!stdout || typeof stdout !== 'string') {
        return { directories, files };
    }

    const base = !remotePath || remotePath === '.' || remotePath === '/'
        ? ''
        : remotePath.replace(/\/+$/, '');

    const records = stdout.split('\0');
    for (const record of records) {
        if (!record) continue;
        const parts = record.split('\t');
        if (parts.length < 4) continue;

        const entryType = parts[0];
        const sizeRaw = parts[1];
        const mtimeRaw = parts[2];
        const name = parts.slice(3).join('\t').replace(/[\r\n]+$/, '');

        if (!name || name === '.' || name === '..') continue;

        const isDirectory = entryType === 'd';
        const isSymlink = entryType === 'l';
        const parsedSize = Number.parseInt(sizeRaw, 10);
        const sizeBytes = isDirectory ? 0 : (Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : 0);

        const parsedMtime = Number.parseFloat(mtimeRaw);
        const lastModified =
            Number.isFinite(parsedMtime) && parsedMtime > 0
                ? new Date(Math.floor(parsedMtime * 1000)).toISOString()
                : null;

        const fullRemotePath = `${base}/${name}` || `/${name}`;
        const entry = {
            name,
            path: createSftpUrl(connection, fullRemotePath),
            isDirectory,
            is_symlink: isSymlink,
            size_in_bytes: sizeBytes,
            last_modified: lastModified,
            size: sizeBytes,
            modified: lastModified,
        };

        if (isDirectory) {
            entry.sub_file_count = 0;
            entry.sub_dir_count = 0;
            directories.push(entry);
        } else {
            files.push(entry);
        }
    }

    return { directories, files };
}
