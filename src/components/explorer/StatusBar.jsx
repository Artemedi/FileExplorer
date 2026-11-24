import React from 'react';
import { formatFileSize, formatDate, getFileType } from '../../utils/formatters';
import { useTranslation } from '../../i18n';
import './statusBar.css';

const isItemDirectory = (item) =>
    Boolean(item?.isDirectory || item?.is_directory || (item && 'sub_file_count' in item));

const getFileExtension = (name) => {
    if (!name || typeof name !== 'string') return '';
    const lastDot = name.lastIndexOf('.');
    if (lastDot <= 0 || lastDot === name.length - 1) return '';
    return name.slice(lastDot + 1);
};

/**
 * Explorer status bar displaying directory item counts and full metadata
 * (full name, detected type + extension, size, modified date) for selected items.
 */
const StatusBar = ({ data, selectedItems = [] }) => {
    const { t } = useTranslation();
    const totalItems = (data?.directories?.length || 0) + (data?.files?.length || 0);
    const itemsLabel = t('common.itemsPlural', { count: totalItems }, `${totalItems} items`);

    if (!selectedItems || selectedItems.length === 0) {
        return (
            <div className="explorer-status-bar" role="status" aria-live="polite">
                <span className="status-bar-count">{itemsLabel}</span>
            </div>
        );
    }

    if (selectedItems.length === 1) {
        const item = selectedItems[0];
        const isDir = isItemDirectory(item);
        const fileType = isDir ? 'Folder' : getFileType(item.name);
        const ext = isDir ? '' : getFileExtension(item.name);
        const typeDisplay = ext ? `${fileType} (.${ext})` : fileType;

        const rawSize = item.size_in_bytes ?? item.size;
        let sizeDisplay = '';
        if (isDir) {
            if (typeof item.sub_file_count === 'number' && item.sub_file_count > 0) {
                sizeDisplay = t(
                    'common.itemsPlural',
                    { count: item.sub_file_count },
                    `${item.sub_file_count} items`
                );
            }
        } else if (typeof rawSize === 'number' && Number.isFinite(rawSize)) {
            sizeDisplay = formatFileSize(rawSize);
        }

        const modRaw = item.last_modified ?? item.modified;
        const modFormatted = modRaw ? formatDate(modRaw, true) : '';
        const modifiedDisplay =
            modFormatted && modFormatted !== 'Unknown' && modFormatted !== 'Invalid date'
                ? modFormatted
                : '';

        return (
            <div className="explorer-status-bar" role="status" aria-live="polite">
                <div className="status-bar-details">
                    <span className="status-bar-name" title={item.name}>
                        {item.name}
                    </span>
                    <span className="status-bar-sep" aria-hidden="true">·</span>
                    <span className="status-bar-meta status-bar-type" title={typeDisplay}>
                        {typeDisplay}
                    </span>
                    {sizeDisplay && (
                        <>
                            <span className="status-bar-sep" aria-hidden="true">·</span>
                            <span className="status-bar-meta">{sizeDisplay}</span>
                        </>
                    )}
                    {modifiedDisplay && (
                        <>
                            <span className="status-bar-sep" aria-hidden="true">·</span>
                            <span className="status-bar-meta">{modifiedDisplay}</span>
                        </>
                    )}
                </div>
                <span className="status-bar-count">{itemsLabel}</span>
            </div>
        );
    }

    const filesOnly = selectedItems.filter((item) => !isItemDirectory(item));
    const totalSelectedSize = filesOnly.reduce(
        (acc, item) => acc + (Number(item.size_in_bytes ?? item.size) || 0),
        0
    );

    return (
        <div className="explorer-status-bar" role="status" aria-live="polite">
            <div className="status-bar-details">
                <span className="status-bar-selected">
                    {selectedItems.length} {t('common.selected', 'selected')}
                </span>
                {filesOnly.length > 0 && (
                    <>
                        <span className="status-bar-sep" aria-hidden="true">·</span>
                        <span className="status-bar-meta">{formatFileSize(totalSelectedSize)}</span>
                    </>
                )}
            </div>
            <span className="status-bar-count">{itemsLabel}</span>
        </div>
    );
};

export default StatusBar;
