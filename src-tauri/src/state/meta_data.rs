use crate::commands::volume_operations_commands;
use crate::models::VolumeInformation;
use crate::{constants, log_error};
use home::home_dir;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::{fs, io};

/// Application metadata and system information.
///
/// This struct stores essential application configuration data,
/// system information, and paths to important application resources.
/// It is serialized to a JSON configuration file for persistence.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct MetaData {
    version: String,
    abs_file_path_buf: PathBuf,
    abs_file_path_for_settings_json: PathBuf,
    pub abs_folder_path_buf_for_templates: PathBuf,
    pub template_paths: Vec<PathBuf>,
    all_volumes_with_information: Vec<VolumeInformation>,
    current_running_os: String,
    current_cpu_architecture: String,
    user_home_dir: String,
}
impl Default for MetaData {
    /// Creates a new MetaData instance with default values.
    ///
    /// This method initializes metadata with:
    /// 1. The current application version
    /// 2. Default file paths for configuration and templates
    /// 3. Current system information (volumes, OS, architecture)
    /// 4. User's home directory
    ///
    /// # Returns
    ///
    /// A new MetaData instance populated with default values
    fn default() -> Self {
        MetaData {
            version: constants::VERSION.to_owned(),
            abs_file_path_buf: constants::META_DATA_CONFIG_ABS_PATH.to_path_buf(),
            abs_file_path_for_settings_json: constants::SETTINGS_CONFIG_ABS_PATH.to_path_buf(),
            abs_folder_path_buf_for_templates: constants::TEMPLATES_ABS_PATH_FOLDER.to_path_buf(),
            template_paths: load_templates(),
            all_volumes_with_information:
                volume_operations_commands::get_system_volumes_information(),
            current_running_os: std::env::consts::OS.to_string(),
            current_cpu_architecture: std::env::consts::ARCH.to_string(),
            user_home_dir: home_dir().unwrap_or_default().to_string_lossy().to_string(),
        }
    }
}

/// Loads template paths from the specified templates directory.
///
/// Reads all entries in `templates_path` and returns their paths. If the directory
/// doesn't exist, it attempts to create an empty one.
fn load_templates_from(templates_path: &Path) -> Vec<PathBuf> {
    if templates_path.exists() {
        match fs::read_dir(templates_path) {
            Ok(entries) => entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .collect(),
            Err(e) => {
                log_error!("Failed to read templates folder: {e}");
                vec![]
            }
        }
    } else {
        if let Err(e) = fs::create_dir_all(templates_path) {
            log_error!("Failed to create templates folder. Error: {e}");
        }
        vec![]
    }
}

/// Loads template paths from the default templates directory.
fn load_templates() -> Vec<PathBuf> {
    load_templates_from(&constants::TEMPLATES_ABS_PATH_FOLDER)
}

/// Thread-safe container for application metadata.
///
/// Provides synchronized access to application metadata through
/// a mutex-protected shared state, with methods for reading and
/// writing metadata to persistent storage.
pub struct MetaDataState(pub Arc<Mutex<MetaData>>);

impl Default for MetaDataState {
    fn default() -> Self {
        Self::new()
    }
}

impl MetaDataState {
    /// Creates a new MetaDataState with default metadata.
    ///
    /// Initializes a new metadata state, writes the default metadata to disk,
    /// and returns the state wrapped in thread-safe containers.
    ///
    /// # Returns
    ///
    /// A new MetaDataState instance with default metadata
    ///
    /// # Example
    ///
    /// ```rust
    /// let metadata_state = MetaDataState::new();
    /// ```
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(
            Self::write_default_meta_data_to_file_and_save_in_state(),
        )))
    }

    /// Creates a new MetaDataState with a custom file path for testing.
    ///
    /// # Arguments
    ///
    /// * `path` - The file path where metadata will be stored
    ///
    /// # Returns
    ///
    /// A new MetaDataState instance configured with the specified path
    ///
    /// # Example
    ///
    /// ```rust
    /// let test_path = PathBuf::from("test_metadata.json");
    /// let metadata_state = MetaDataState::new_with_path(test_path);
    /// ```
    #[cfg(test)]
    pub fn new_with_path(path: PathBuf) -> Self {
        let defaults = MetaData {
            abs_file_path_buf: path,
            ..MetaData::default()
        };
        Self(Arc::new(Mutex::new(
            Self::write_meta_data_to_file_and_save_in_state(defaults),
        )))
    }

    /// Updates volume information in the metadata.
    ///
    /// Refreshes the list of volumes and their metadata to reflect
    /// the current system state, and writes the updated metadata to disk.
    ///
    /// # Returns
    ///
    /// * `Ok(())` - If volumes were successfully refreshed
    /// * `Err(io::Error)` - If there was an error writing metadata to disk
    ///
    /// # Example
    ///
    /// ```rust
    /// let metadata_state = MetaDataState::new();
    /// metadata_state.refresh_volumes()?;
    /// ```
    pub fn refresh_volumes(&self) -> io::Result<()> {
        let mut meta_data = self
            .0
            .lock()
            .map_err(|_| io::Error::other("Failed to acquire metadata lock"))?;
        meta_data.all_volumes_with_information =
            volume_operations_commands::get_system_volumes_information();
        self.write_meta_data_to_file(&meta_data)
    }

    /// Updates the list of available templates.
    ///
    /// Rescans the configured templates directory (`abs_folder_path_buf_for_templates`)
    /// and updates the metadata with the current list of templates, then writes
    /// the updated metadata to disk atomically.
    ///
    /// # Returns
    ///
    /// * `Ok(())` - If template paths were successfully updated
    /// * `Err(io::Error)` - If there was an error acquiring the lock or writing metadata to disk
    ///
    /// # Example
    ///
    /// ```rust
    /// let metadata_state = MetaDataState::new();
    /// metadata_state.update_template_paths()?;
    /// ```
    pub fn update_template_paths(&self) -> io::Result<()> {
        let mut meta_data = self
            .0
            .lock()
            .map_err(|_| io::Error::other("Failed to acquire metadata lock"))?;
        meta_data.template_paths =
            load_templates_from(&meta_data.abs_folder_path_buf_for_templates);
        self.write_meta_data_to_file(&meta_data)
    }

    /// Writes the current metadata atomically to file.
    ///
    /// Serializes the metadata to JSON format and saves it atomically to the
    /// configured file path, creating parent directories if needed.
    ///
    /// # Arguments
    ///
    /// * `meta_data` - A reference to the MetaData to be saved
    ///
    /// # Returns
    ///
    /// * `Ok(())` - If the metadata was successfully written
    /// * `Err(io::Error)` - If there was an error creating directories, opening the file, or writing to it
    pub fn write_meta_data_to_file(&self, meta_data: &MetaData) -> io::Result<()> {
        let user_config_file_path = &meta_data.abs_file_path_buf;
        let serialized = serde_json::to_string_pretty(&meta_data).map_err(io::Error::other)?;

        crate::state::atomic_write_file(user_config_file_path, serialized.as_bytes())
    }

    /// Creates default metadata and writes it to file.
    ///
    /// This is a helper method that creates default metadata
    /// and persists it to disk.
    ///
    /// # Returns
    ///
    /// The created MetaData instance with default values
    fn write_default_meta_data_to_file_and_save_in_state() -> MetaData {
        let defaults = MetaData::default();
        Self::write_meta_data_to_file_and_save_in_state(defaults)
    }

    /// Helper method to write metadata to a file and return the metadata instance.
    fn write_meta_data_to_file_and_save_in_state(defaults: MetaData) -> MetaData {
        let meta_data_state = Self(Arc::new(Mutex::new(defaults.clone())));

        if let Err(e) = meta_data_state.write_meta_data_to_file(&defaults) {
            eprintln!("Error writing metadata to file: {e}");
        }

        defaults
    }

    /// Reads metadata from a file.
    #[cfg(test)]
    pub fn read_meta_data_from_file(path: &Path) -> io::Result<MetaData> {
        let contents = fs::read_to_string(path)?;
        serde_json::from_str(&contents).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    use tempfile::tempdir;

    //test the default values of the metadata
    #[test]
    fn test_default_meta_data() {
        let meta_data = MetaData::default();
        assert_eq!(meta_data.version, constants::VERSION);
        assert_eq!(
            meta_data.abs_file_path_buf,
            constants::META_DATA_CONFIG_ABS_PATH.to_path_buf()
        );
        // Check the OS and architecture fields
        assert_eq!(
            meta_data.current_running_os,
            std::env::consts::OS.to_string()
        );
        assert_eq!(
            meta_data.current_cpu_architecture,
            std::env::consts::ARCH.to_string()
        );
        // Check the home directory field
        assert_eq!(
            meta_data.user_home_dir,
            home_dir().unwrap_or_default().to_string_lossy().to_string()
        );
        // Cannot test volume information directly as it depends on the system
    }

    #[test]
    fn test_meta_data_state_creation() {
        // Create a temporary directory
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let test_path = temp_dir.path().join("meta_data.json");

        // Create a new MetaDataState with our test path
        let _meta_data_state = MetaDataState::new_with_path(test_path.clone());

        // Verify the file was created
        assert!(
            test_path.exists(),
            "Metadata file should exist after creation"
        );

        // Read the file and verify its contents
        let read_result = MetaDataState::read_meta_data_from_file(&test_path);
        assert!(read_result.is_ok(), "Should be able to read metadata file");

        let meta_data = read_result.unwrap();
        assert_eq!(meta_data.version, constants::VERSION);
        assert_eq!(meta_data.abs_file_path_buf, test_path);
        assert_eq!(
            meta_data.abs_file_path_for_settings_json,
            constants::SETTINGS_CONFIG_ABS_PATH.to_path_buf()
        );
        // Check the OS and architecture fields
        assert_eq!(
            meta_data.current_running_os,
            std::env::consts::OS.to_string()
        );
        assert_eq!(
            meta_data.current_cpu_architecture,
            std::env::consts::ARCH.to_string()
        );
        // Check the home directory field
        assert_eq!(
            meta_data.user_home_dir,
            home_dir().unwrap_or_default().to_string_lossy().to_string()
        );
    }

    #[test]
    fn test_refresh_volumes() {
        // Create a temporary directory
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let test_path = temp_dir.path().join("meta_data.json");

        // Create a new MetaDataState
        let meta_data_state = MetaDataState::new_with_path(test_path.clone());

        // Get the initial volumes count
        let initial_volumes = {
            let meta_data = meta_data_state.0.lock().unwrap();
            meta_data.all_volumes_with_information.len()
        };

        // Refresh volumes
        let refresh_result = meta_data_state.refresh_volumes();
        assert!(refresh_result.is_ok(), "Volume refresh should succeed");

        // Verify the file still exists and can be read
        assert!(
            test_path.exists(),
            "Metadata file should exist after refresh"
        );

        // Get the volumes after refresh
        let refreshed_volumes = {
            let meta_data = meta_data_state.0.lock().unwrap();
            meta_data.all_volumes_with_information.len()
        };

        // The number of volumes should be the same after refresh since we're on the same system
        assert_eq!(
            initial_volumes, refreshed_volumes,
            "Volume count should remain the same after refresh"
        );
    }

    #[test]
    fn test_write_meta_data_to_file() {
        // Create a temporary directory
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let test_path = temp_dir.path().join("meta_data.json");

        // Customize the OS, CPU, and home directory fields for testing
        let test_os = "test-os".to_string();
        let test_arch = "test-arch".to_string();
        let test_home = "/test/home/path".to_string();

        // Create a custom metadata object
        let meta_data = MetaData {
            abs_file_path_buf: test_path.clone(),
            version: "test-version".to_string(),
            current_running_os: test_os.clone(),
            current_cpu_architecture: test_arch.clone(),
            user_home_dir: test_home.clone(),
            ..MetaData::default()
        };

        // Create a MetaDataState and write the custom metadata
        // Construct a MetaDataState with the custom metadata (is the struct from above)
        let meta_data_state = MetaDataState(Arc::new(Mutex::new(meta_data.clone())));
        let write_result = meta_data_state.write_meta_data_to_file(&meta_data);
        assert!(write_result.is_ok(), "Writing metadata should succeed");

        // Read back the file and verify contents
        let read_result = MetaDataState::read_meta_data_from_file(&test_path);
        assert!(read_result.is_ok(), "Should be able to read metadata file");

        let read_meta_data = read_result.unwrap();
        assert_eq!(read_meta_data.version, "test-version");
        assert_eq!(read_meta_data.abs_file_path_buf, test_path);
        assert_eq!(
            meta_data.abs_file_path_for_settings_json,
            constants::SETTINGS_CONFIG_ABS_PATH.to_path_buf()
        );

        // Verify the custom OS, CPU, and home directory fields
        assert_eq!(read_meta_data.current_running_os, test_os);
        assert_eq!(read_meta_data.current_cpu_architecture, test_arch);
        assert_eq!(read_meta_data.user_home_dir, test_home);
    }

    /// TP-BE-06 / BUG-045: update_template_paths reads from meta_data.abs_folder_path_buf_for_templates.
    #[test]
    fn test_update_template_paths_uses_configured_templates_dir() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let meta_path = temp_dir.path().join("meta_data.json");
        let custom_templates_dir = temp_dir.path().join("custom_templates");
        fs::create_dir_all(&custom_templates_dir).expect("Should create custom templates dir");

        let tpl_a = custom_templates_dir.join("alpha.txt");
        let tpl_b = custom_templates_dir.join("beta.md");
        fs::write(&tpl_a, "alpha").expect("Should write alpha template");
        fs::write(&tpl_b, "beta").expect("Should write beta template");

        let meta_data_state = MetaDataState::new_with_path(meta_path.clone());
        {
            let mut inner = meta_data_state.0.lock().unwrap();
            inner.abs_folder_path_buf_for_templates = custom_templates_dir.clone();
            inner.template_paths.clear();
        }

        meta_data_state
            .update_template_paths()
            .expect("update_template_paths should succeed");

        let inner = meta_data_state.0.lock().unwrap();
        assert_eq!(inner.template_paths.len(), 2);
        assert!(inner.template_paths.contains(&tpl_a));
        assert!(inner.template_paths.contains(&tpl_b));
        drop(inner);

        let on_disk = MetaDataState::read_meta_data_from_file(&meta_path)
            .expect("Should read updated metadata from disk");
        assert_eq!(on_disk.template_paths.len(), 2);
        assert!(on_disk.template_paths.contains(&tpl_a));
        assert!(on_disk.template_paths.contains(&tpl_b));
    }

    /// BUG-045: refresh_volumes and update_template_paths return Err on poisoned mutex instead of panicking.
    #[test]
    fn test_refresh_volumes_and_update_templates_poisoned_mutex_returns_err() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let meta_path = temp_dir.path().join("meta_data.json");
        let meta_data_state = MetaDataState::new_with_path(meta_path);

        let inner_arc = meta_data_state.0.clone();
        let _ = std::thread::spawn(move || {
            let _guard = inner_arc.lock().unwrap();
            panic!("intentional metadata inner lock poison");
        })
        .join();

        assert!(
            meta_data_state.refresh_volumes().is_err(),
            "refresh_volumes must return Err when inner mutex is poisoned"
        );
        assert!(
            meta_data_state.update_template_paths().is_err(),
            "update_template_paths must return Err when inner mutex is poisoned"
        );
    }
}
