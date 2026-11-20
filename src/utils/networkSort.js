const GROUP_ORDER = ['0-9', 'A-Z', 'А-Я', 'Other'];

/**
 * Classifies a connection name into 0-9, A-Z (Latin), А-Я (Cyrillic), or Other.
 * @param {string} name
 * @returns {'0-9'|'A-Z'|'А-Я'|'Other'}
 */
export function getNetworkGroup(name) {
    const ch = String(name || '').trim().charAt(0);
    if (!ch) return 'Other';
    if (/^[0-9]$/.test(ch)) return '0-9';
    if (/^[A-Za-z]$/.test(ch)) return 'A-Z';
    if (/^[А-Яа-яЁё]$/.test(ch)) return 'А-Я';
    return 'Other';
}

/**
 * Comparator sorting network items in order: 0-9 -> A-Z -> А-Я -> Other.
 * @param {{name?: string}} a
 * @param {{name?: string}} b
 * @returns {number}
 */
export function compareNetworkItems(a, b) {
    const nameA = String(a?.name || '').trim();
    const nameB = String(b?.name || '').trim();
    const groupA = GROUP_ORDER.indexOf(getNetworkGroup(nameA));
    const groupB = GROUP_ORDER.indexOf(getNetworkGroup(nameB));
    if (groupA !== groupB) return groupA - groupB;
    return nameA.localeCompare(nameB, ['en', 'ru'], { numeric: true, sensitivity: 'base' });
}

/**
 * Groups and sorts network items into non-empty buckets ordered 0-9, A-Z, А-Я, Other.
 * @template T
 * @param {T[]} items
 * @returns {Array<{ group: string, items: T[] }>}
 */
export function groupNetworkItems(items) {
    const sorted = [...(items || [])].sort(compareNetworkItems);
    const buckets = new Map();
    for (const g of GROUP_ORDER) buckets.set(g, []);
    for (const item of sorted) {
        const g = getNetworkGroup(item?.name);
        buckets.get(g).push(item);
    }
    return GROUP_ORDER
        .map((group) => ({ group, items: buckets.get(group) }))
        .filter((b) => b.items.length > 0);
}
