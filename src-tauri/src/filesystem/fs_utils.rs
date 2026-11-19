use std::path::{Path, PathBuf, MAIN_SEPARATOR_STR};

pub fn _get_mount_point(path: String) -> Option<String> {
    let path = Path::new(&path);
    let root = path.components().next()?;
    let mount_point = root.as_os_str().to_string_lossy().into_owned();

    let mut mount_point_path = PathBuf::new();
    mount_point_path.push(&mount_point);
    mount_point_path.push(MAIN_SEPARATOR_STR);
    Some(mount_point_path.to_string_lossy().into_owned())
}
