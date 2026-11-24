/**
 * Truncates a filename or folder name in the middle so both its beginning
 * and its trailing characters + file extension remain visible.
 *
 * @param {string} name - Full file or directory name.
 * @param {number} [maxLength=26] - Maximum character budget before truncating.
 * @param {Object} [options]
 * @param {boolean} [options.isDirectory=false] - Directories have no file extension.
 * @param {number} [options.tailBaseChars=6] - Trailing characters of the base name to keep before extension.
 * @returns {string}
 */
export function middleEllipsis(name, maxLength = 26, options = {}) {
    if (!name || typeof name !== 'string') return '';
    if (!Number.isFinite(maxLength) || maxLength <= 0 || name.length <= maxLength) {
        return name;
    }
    if (maxLength <= 3) {
        return name.slice(0, maxLength);
    }

    const { isDirectory = false, tailBaseChars = 6 } = options;
    const ellipsis = '…';
    const lastDot = name.lastIndexOf('.');
    const hasExtension = !isDirectory && lastDot > 0 && lastDot < name.length - 1;

    if (hasExtension) {
        const base = name.slice(0, lastDot);
        const ext = name.slice(lastDot);
        const minHeadChars = 3;

        if (minHeadChars + ellipsis.length + ext.length <= maxLength) {
            const maxTail = Math.max(0, maxLength - ellipsis.length - minHeadChars - ext.length);
            const actualTail = Math.min(Math.max(0, tailBaseChars), base.length, maxTail);
            const tail = `${base.slice(base.length - actualTail)}${ext}`;
            const headLen = maxLength - ellipsis.length - tail.length;

            if (headLen >= 1 && headLen + actualTail < base.length) {
                return `${base.slice(0, headLen)}${ellipsis}${tail}`;
            }
            if (headLen + actualTail >= base.length) {
                return name;
            }
        }
    }

    const tailLen = Math.min(Math.max(0, tailBaseChars), Math.floor((maxLength - 1) / 2));
    const headLen = maxLength - ellipsis.length - tailLen;
    if (headLen <= 0 || headLen + tailLen >= name.length) {
        return `${name.slice(0, maxLength - 1)}${ellipsis}`;
    }
    return `${name.slice(0, headLen)}${ellipsis}${tailLen > 0 ? name.slice(-tailLen) : ''}`;
}
