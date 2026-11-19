use crate::models::{
    format_system_time, get_access_permission_number, get_access_permission_string,
};
use serde::{Deserialize, Serialize};
use std::fs::{self, DirEntry};
use std::io::Result;
use std::time::{SystemTime, UNIX_EPOCH};

fn format_optional_time(res: Result<SystemTime>) -> String {
    format_system_time(res.unwrap_or(UNIX_EPOCH))
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct File {
    pub name: String,
    pub path: String,
    pub is_symlink: bool,
    pub access_rights_as_string: String,
    pub access_rights_as_number: u32,
    pub size_in_bytes: u64,
    pub created: String,
    pub last_modified: String,
    pub accessed: String,
}

impl File {
    /// Creates a new File struct from a DirEntry
    ///
    /// # Arguments
    /// * `entry` - The DirEntry to convert
    ///
    /// # Returns
    /// * `Result<File>` - The created File or an error
    pub fn from_dir_entry(entry: DirEntry) -> Result<Self> {
        let path_of_entry = entry.path();
        let sym_meta = fs::symlink_metadata(&path_of_entry)?;
        let is_symlink = sym_meta.file_type().is_symlink();
        let metadata = if is_symlink {
            fs::metadata(&path_of_entry).unwrap_or(sym_meta)
        } else {
            sym_meta
        };
        let perms = metadata.permissions();

        Ok(File {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path_of_entry.to_string_lossy().into_owned(),
            is_symlink,
            access_rights_as_string: get_access_permission_string(perms.clone(), false),
            access_rights_as_number: get_access_permission_number(perms, false),
            size_in_bytes: metadata.len(),
            created: format_optional_time(metadata.created()),
            last_modified: format_optional_time(metadata.modified()),
            accessed: format_optional_time(metadata.accessed()),
        })
    }
}
