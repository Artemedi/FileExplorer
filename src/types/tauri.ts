/**
 * TypeScript contract interfaces for the Tauri Rust backend models and commands.
 */

export interface FileEntry {
    name: string;
    path: string;
    is_symlink: boolean;
    access_rights_as_string: string;
    access_rights_as_number: number;
    size_in_bytes: number;
    created: string;
    last_modified: string;
    accessed: string;
}

export interface DirectoryEntry {
    name: string;
    path: string;
    is_symlink: boolean;
    access_rights_as_string: string;
    access_rights_as_number: number;
    size_in_bytes: number;
    sub_file_count: number;
    sub_dir_count: number;
    created: string;
    last_modified: string;
    accessed: string;
}

export interface DirectoryContent {
    directories: DirectoryEntry[];
    files: FileEntry[];
}

export interface VolumeInfo {
    volume_name: string;
    mount_point: string;
    file_system: string;
    size: number;
    available_space: number;
    is_removable: boolean;
    total_written_bytes: number;
    total_read_bytes: number;
}

export interface BackendError {
    code: number;
    message_from_code: string;
    custom_message: string;
}

export interface CommandResponse<T = unknown> {
    success?: boolean;
    data?: T;
    error?: BackendError;
}

export interface FsChangeEvent {
    kind: 'create' | 'modify' | 'remove' | 'other';
    paths: string[];
}

export type SearchResult = [string, number];

export interface BackendSettings {
    search_engine_enabled: boolean;
    case_sensitive_search: boolean;
    index_hidden_files: boolean;
    fuzzy_search_enabled: boolean;
    preferred_extensions: string[];
    excluded_paths?: string[];
    max_search_results?: number;
    [key: string]: unknown;
}

export interface Settings {
    darkmode: boolean;
    custom_themes: string[];
    default_theme: string;
    default_themes_path: string;
    default_folder_path_on_opening: string;
    default_view: string;
    font_size: string;
    show_hidden_files_and_folders: boolean;
    show_details_panel: boolean;
    accent_color: string;
    confirm_delete: boolean;
    auto_refresh_dir: boolean;
    sort_direction: string;
    sort_by: string;
    double_click: string;
    show_file_extensions: boolean;
    terminal_height: number;
    terminal_sync_explorer_to_terminal: boolean;
    enable_animations_and_transitions: boolean;
    enable_virtual_scroll_for_large_directories: boolean;
    abs_file_path_buf: string;
    enable_suggestions: boolean;
    highlight_matches: boolean;
    backend_settings: BackendSettings;
}

export type PreviewPayload =
    | { kind: 'Image'; name: string; data_uri: string; bytes: number }
    | { kind: 'Pdf'; name: string; data_uri: string; bytes: number }
    | { kind: 'Video'; name: string; path: string }
    | { kind: 'Audio'; name: string; path: string }
    | { kind: 'Text'; name: string; text: string; truncated: boolean }
    | { kind: 'Folder'; name: string; size: number; item_count: number; modified: string | null }
    | { kind: 'Unknown'; name: string }
    | { kind: 'Error'; name: string; message?: string };

export interface SftpDirectory {
    sftp_directory: string;
    files: string[];
    directories: string[];
}

export interface IndexingProgress {
    status: string;
    files_indexed: number;
    directories_indexed: number;
    total_estimated: number;
    current_path: string;
    percentage: number;
    estimated_time_remaining_ms: number;
    items_per_second: number;
    bytes_processed: number;
    errors_count: number;
    started_at: number | null;
    last_update: number;
}

export interface SearchEngineInfo {
    status: string;
    progress: IndexingProgress;
    metrics: Record<string, unknown>;
    recent_activity: Record<string, unknown>;
    stats: Record<string, unknown>;
    last_updated: number;
}

export interface MetaData {
    current_running_os: string;
    user_home_dir: string;
    [key: string]: unknown;
}

export interface SftpConnectionArgs {
    host: string;
    port: number;
    username: string;
    password: string;
}

export interface SystemIntegrationCommands {
    get_initial_cli_path: () => Promise<string | null>;
    is_default_file_manager: () => Promise<boolean>;
    set_default_file_manager: (args: { enable: boolean }) => Promise<void>;
    is_context_menu_enabled: () => Promise<boolean>;
    set_context_menu_enabled: (args: { enable: boolean }) => Promise<void>;
}

export interface TauriCommands extends SystemIntegrationCommands {
    // Filesystem
    open_file: (args: { path: string }) => Promise<string>;
    open_directory: (args: { path: string }) => Promise<string>;
    open_in_default_app: (args: { path: string }) => Promise<void>;
    create_file: (args: { folderPathAbs: string; fileName: string }) => Promise<void>;
    create_directory: (args: { folderPathAbs: string; folderName: string }) => Promise<void>;
    rename: (args: { oldPath: string; newPath: string }) => Promise<void>;
    move_to_trash: (args: { path: string }) => Promise<void>;
    copy_file_or_dir: (args: { sourcePath: string; destinationPath: string }) => Promise<void>;
    zip: (args: { sourcePaths: string[]; destinationPath: string | null }) => Promise<void>;
    unzip: (args: { zipPaths: string[]; destinationPath: string | null }) => Promise<void>;

    // Metadata & Volumes
    get_meta_data_as_json: () => Promise<string>;
    update_meta_data: () => Promise<void>;
    get_system_volumes_information_as_json: () => Promise<string>;
    get_system_volumes_information: () => Promise<VolumeInfo[]>;
    eject_volume: (args: { mountPoint: string }) => Promise<void>;

    // Settings
    get_settings_as_json: () => Promise<string>;
    update_settings_field: (args: { key: string; value: unknown }) => Promise<void>;
    get_setting_field: (args: { key: string }) => Promise<unknown>;
    update_multiple_settings_command: (args: { updates: Record<string, unknown> }) => Promise<void>;
    reset_settings_command: () => Promise<void>;

    // Search
    search: (args: { query: string }) => Promise<SearchResult[]>;
    search_with_extension: (args: { query: string; extensions: string[] }) => Promise<SearchResult[]>;
    add_paths_recursive: (args: { folder: string }) => Promise<void>;
    add_path: (args: { path: string }) => Promise<void>;
    remove_path: (args: { path: string }) => Promise<void>;
    remove_paths_recursive: (args: { folder: string }) => Promise<void>;
    clear_search_engine: () => Promise<void>;
    get_search_engine_info: () => Promise<SearchEngineInfo>;
    add_paths_recursive_async: (args: { folder: string }) => Promise<void>;
    get_indexing_progress: () => Promise<IndexingProgress>;
    get_indexing_status: () => Promise<string>;
    stop_indexing: () => Promise<void>;
    get_suggestions: (args: { prefix: string }) => Promise<string[]>;
    set_search_current_directory: (args: { directory: string | null }) => Promise<void>;

    // Preview
    build_preview: (args: { path: string }) => Promise<PreviewPayload>;

    // Watcher
    watch_directory: (args: { path: string }) => Promise<void>;
    unwatch_directory: () => Promise<void>;

    // SFTP & Credentials
    load_dir: (args: SftpConnectionArgs & { directory: string }) => Promise<SftpDirectory>;
    build_preview_sftp: (args: SftpConnectionArgs & { path: string }) => Promise<PreviewPayload>;
    download_and_open_sftp_file: (args: SftpConnectionArgs & { filePath: string; openFile?: boolean }) => Promise<string>;
    cleanup_sftp_temp_files: () => Promise<void>;
    store_sftp_credentials: (args: { connectionId: string; password: string }) => Promise<void>;
    remove_sftp_credentials: (args: { connectionId: string }) => Promise<void>;
    has_sftp_credentials: (args: { connectionId: string }) => Promise<boolean>;
    trust_sftp_host_key: (args: { host: string; port: number; fingerprint: string }) => Promise<void>;
}
