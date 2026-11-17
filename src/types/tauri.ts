/**
 * TypeScript contract interfaces for the Tauri Rust backend models.
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

export interface FsChangeEvent {
    kind: 'create' | 'modify' | 'remove' | 'rename' | 'other' | string;
    paths: string[];
}

export interface SearchResult {
    path: string;
    score: number;
}

export interface SystemIntegrationCommands {
    get_initial_cli_path: () => Promise<string | null>;
    is_default_file_manager: () => Promise<boolean>;
    set_default_file_manager: (args: { enable: boolean }) => Promise<void>;
    is_context_menu_enabled: () => Promise<boolean>;
    set_context_menu_enabled: (args: { enable: boolean }) => Promise<void>;
}

