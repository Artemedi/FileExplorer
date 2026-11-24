use crate::constants;
use crate::models::backend_settings::BackendSettings;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Error};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

//In this file we should change everything to lowercase for the json -> first step is done in DefaultView
/// File view mode for directories.
///
/// Controls how files and directories are displayed in the UI.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[allow(non_camel_case_types)]
pub enum DefaultView {
    grid,
    list,
    details,
}

/// Font size setting for UI elements.
///
/// Controls the text size throughout the application.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub enum FontSize {
    Small,
    Medium,
    Large,
}

/// Direction for sorting files and directories.
///
/// Controls whether items are sorted in ascending or descending order.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub enum SortDirection {
    #[serde(alias = "Acscending")]
    Ascending,
    Descending,
}

/// Property used for sorting files and directories.
///
/// Determines which attribute is used when ordering items.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub enum SortBy {
    Name,
    Size,
    #[serde(alias = "Modified")]
    Date,
    Type,
}

/// Behavior configuration for double-click actions.
///
/// Controls what happens when a user double-clicks on items.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub enum DoubleClick {
    OpenFilesAndFolders,
    SelectFilesAndFolders,
}

/// Application settings configuration.
///
/// This struct contains all configurable options for the application,
/// including appearance, behavior, and file operation preferences.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Settings {
    /// Whether dark mode is enabled
    pub darkmode: bool,
    /// List of custom theme identifiers
    pub custom_themes: Vec<String>,
    /// Currently selected theme
    pub default_theme: String,
    /// Path to themes directory
    pub default_themes_path: PathBuf,
    /// Default directory to open when application starts
    pub default_folder_path_on_opening: PathBuf,
    /// Default view mode for directories
    pub default_view: DefaultView,
    /// Font size setting for UI elements
    pub font_size: FontSize,
    /// Whether to display hidden files and folders
    pub show_hidden_files_and_folders: bool,
    /// Whether to show the details panel by default
    pub show_details_panel: bool,
    /// Primary UI accent color in hex format
    pub accent_color: String,
    /// Whether to prompt for confirmation before deleting files
    pub confirm_delete: bool,
    /// Whether to automatically refresh directory contents
    pub auto_refresh_dir: bool,
    /// Direction for sorting items
    pub sort_direction: SortDirection,
    /// Property to use for sorting items
    pub sort_by: SortBy,
    /// Behavior for double-click actions
    pub double_click: DoubleClick,
    /// Whether to display file extensions
    pub show_file_extensions: bool,
    /// Height of the terminal panel in pixels
    pub terminal_height: u32,
    /// Whether explorer SFTP navigation sends `cd` to an idle SSH PTY
    #[serde(default)]
    pub terminal_sync_explorer_to_terminal: bool,
    /// Whether to enable UI animations and transitions
    pub enable_animations_and_transitions: bool,
    /// Whether to use virtual scrolling for large directories
    pub enable_virtual_scroll_for_large_directories: bool,
    /// Absolute path to the settings file
    pub abs_file_path_buf: PathBuf,
    // need to implement
    /// Whether to enable suggestions in the application
    pub enable_suggestions: bool,
    /// Whether to highlight matches in search results
    pub highlight_matches: bool,

    /// Backend settings for the application
    pub backend_settings: BackendSettings,
}

//TODO implement the default settings -> talk to Lauritz for further more information
impl Default for Settings {
    fn default() -> Self {
        Settings {
            darkmode: false,
            custom_themes: vec![],
            default_theme: "".to_string(),
            default_themes_path: Default::default(),
            default_folder_path_on_opening: Default::default(),
            abs_file_path_buf: constants::SETTINGS_CONFIG_ABS_PATH.to_path_buf(),
            default_view: DefaultView::grid,
            font_size: FontSize::Medium,
            show_hidden_files_and_folders: false,
            show_details_panel: false,
            accent_color: "#0672ef".to_string(),
            confirm_delete: true,
            auto_refresh_dir: true,
            sort_direction: SortDirection::Ascending,
            sort_by: SortBy::Name,
            double_click: DoubleClick::OpenFilesAndFolders,
            show_file_extensions: true,
            terminal_height: 240,
            terminal_sync_explorer_to_terminal: false,
            enable_animations_and_transitions: true,
            enable_virtual_scroll_for_large_directories: false,
            enable_suggestions: true, //implement?
            highlight_matches: true,  // implement?
            backend_settings: BackendSettings::default(),
        }
    }
}

/// Thread-safe state for application settings.
///
/// This struct provides methods for reading, writing, and modifying application settings
/// while ensuring thread safety through a mutex-protected shared state.
pub struct SettingsState(pub Arc<Mutex<Settings>>);

impl Default for SettingsState {
    fn default() -> Self {
        Self::new()
    }
}

impl SettingsState {
    /// Creates a new SettingsState instance.
    ///
    /// This method initializes settings by:
    /// 1. Checking if a settings file exists at the default path
    /// 2. If it exists, attempting to read settings from that file
    /// 3. If reading/parsing fails, backing up the corrupt file as `<filename>.corrupt.bak`
    ///    before writing default settings
    ///
    /// # Returns
    ///
    /// A new SettingsState instance with either loaded or default settings.
    ///
    /// # Example
    ///
    /// ```rust
    /// let settings_state = SettingsState::new();
    /// ```
    pub fn new() -> Self {
        Self::load_or_init_with_path(constants::SETTINGS_CONFIG_ABS_PATH.to_path_buf())
    }

    /// Loads settings from `path` if present, backing up corrupt files before writing defaults.
    pub(crate) fn load_or_init_with_path(path: PathBuf) -> Self {
        let defaults = Settings {
            abs_file_path_buf: path.clone(),
            ..Settings::default()
        };

        let settings = if path.exists() {
            match Self::read_settings_from_file(&path) {
                Ok(mut loaded) => {
                    loaded.abs_file_path_buf = path;
                    loaded
                }
                Err(err) => {
                    eprintln!(
                        "Failed to read/parse settings file '{}': {}. Backing up before restoring defaults.",
                        path.display(),
                        err
                    );
                    if let Some(file_name) = path.file_name() {
                        let backup_path = path
                            .with_file_name(format!("{}.corrupt.bak", file_name.to_string_lossy()));
                        if let Err(backup_err) = std::fs::rename(&path, &backup_path) {
                            eprintln!(
                                "Failed to back up corrupt settings file to '{}': {}",
                                backup_path.display(),
                                backup_err
                            );
                        }
                    }
                    Self::write_settings_to_file_and_save_in_state(defaults)
                }
            }
        } else {
            Self::write_settings_to_file_and_save_in_state(defaults)
        };
        Self(Arc::new(Mutex::new(settings)))
    }

    /// Converts a Settings struct to a JSON map representation.
    ///
    /// This function serializes the settings object into a serde_json Map structure
    /// for easier manipulation of individual fields.
    ///
    /// # Arguments
    ///
    /// * `settings` - A reference to the Settings struct to be converted.
    ///
    /// # Returns
    ///
    /// * `Ok(Map<String, Value>)` - A map of setting keys to their values if successful.
    /// * `Err(Error)` - If serialization fails or the result is not a JSON object.
    ///
    /// # Example
    ///
    /// ```rust
    /// let settings = Settings::default();
    /// let map = settings_to_json_map(&settings)?;
    /// println!("Settings map: {:?}", map);
    /// ```
    pub fn settings_to_json_map(
        settings: &Settings,
    ) -> Result<serde_json::Map<String, Value>, Error> {
        let settings_value = serde_json::to_value(settings).map_err(io::Error::other)?;

        settings_value
            .as_object()
            .cloned()
            .ok_or_else(|| Error::new(io::ErrorKind::InvalidData, "Settings is not a JSON object"))
    }

    /// Converts a JSON map back to a Settings struct.
    ///
    /// This function deserializes a map of settings values into a Settings struct.
    ///
    /// # Arguments
    ///
    /// * `map` - A serde_json Map containing setting keys and their values.
    ///
    /// # Returns
    ///
    /// * `Ok(Settings)` - The deserialized Settings struct if successful.
    /// * `Err(io::Error)` - If deserialization fails.
    ///
    /// # Example
    ///
    /// ```rust
    /// let mut map = serde_json::Map::new();
    /// map.insert("theme".to_string(), json!("dark"));
    ///
    /// let settings = json_map_to_settings(map)?;
    /// println!("Converted settings: {:?}", settings);
    /// ```
    pub fn json_map_to_settings(map: serde_json::Map<String, Value>) -> Result<Settings, Error> {
        serde_json::from_value(Value::Object(map))
            .map_err(|e| Error::new(io::ErrorKind::InvalidData, e))
    }

    /// Updates a single setting field with a new value.
    ///
    /// This method updates a specific setting identified by its key, validates that the
    /// key exists, and writes the updated settings to file.
    ///
    /// # Arguments
    ///
    /// * `&self` - Reference to the settings state.
    /// * `key` - A string slice identifying the setting to update.
    /// * `value` - The new value to assign to the setting.
    ///
    /// # Returns
    ///
    /// * `Ok(Settings)` - The updated Settings struct if successful.
    /// * `Err(io::Error)` - If the key doesn't exist or there's an error saving the settings.
    ///
    /// # Example
    ///
    /// ```rust
    /// let result = settings_state.update_setting_field("theme", json!("dark"))?;
    /// println!("Updated settings: {:?}", result);
    /// ```
    fn resolve_setting_key(key: &str) -> &str {
        match key {
            "search_engine_enabled" => {
                "backend_settings.search_engine_config.search_engine_enabled"
            }
            "case_sensitive_search" => {
                "backend_settings.search_engine_config.case_sensitive_search"
            }
            "index_hidden_files" => "backend_settings.search_engine_config.index_hidden_files",
            "fuzzy_search_enabled" => "backend_settings.search_engine_config.fuzzy_search_enabled",
            "default_checksum_hash" => "backend_settings.default_checksum_hash",
            "logging_level" => "backend_settings.logging_config.logging_level",
            _ => key,
        }
    }

    fn is_protected_key(key: &str, resolved_key: &str) -> bool {
        key == "abs_file_path_buf"
            || resolved_key == "abs_file_path_buf"
            || resolved_key.starts_with("abs_file_path_buf.")
    }

    fn apply_setting_update(
        settings_map: &mut serde_json::Map<String, Value>,
        key: &str,
        value: Value,
    ) -> Result<(), Error> {
        let resolved_key = Self::resolve_setting_key(key);
        if key.is_empty() || resolved_key.split('.').any(str::is_empty) {
            return Err(Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unknown settings key: {key}"),
            ));
        }
        if Self::is_protected_key(key, resolved_key) {
            return Err(Error::new(
                io::ErrorKind::PermissionDenied,
                "Cannot modify protected settings key: abs_file_path_buf",
            ));
        }

        // Handle nested fields with dot notation (e.g., "backend_settings.logging_config.logging_level")
        if resolved_key.contains('.') {
            let path: Vec<&str> = resolved_key.split('.').collect();

            if !settings_map.contains_key(path[0]) {
                return Err(Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("Unknown settings key: {key}"),
                ));
            }

            Self::update_nested_field(settings_map, &path, key, value)
        } else if settings_map.contains_key(resolved_key) {
            settings_map.insert(resolved_key.to_string(), value);
            Ok(())
        } else {
            Err(Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unknown settings key: {key}"),
            ))
        }
    }

    fn apply_and_persist_updates<'a, I>(&self, updates: I) -> Result<Settings, Error>
    where
        I: IntoIterator<Item = (&'a str, Value)>,
    {
        let mut settings = self
            .0
            .lock()
            .map_err(|_| io::Error::other("Failed to acquire settings lock"))?;

        let mut settings_map = Self::settings_to_json_map(&settings)?;
        for (key, value) in updates {
            Self::apply_setting_update(&mut settings_map, key, value)?;
        }

        let updated_settings = Self::json_map_to_settings(settings_map)?;
        self.write_settings_to_file(&updated_settings)?;
        *settings = updated_settings.clone();

        Ok(updated_settings)
    }

    pub fn update_setting_field(&self, key: &str, value: Value) -> Result<Settings, Error> {
        self.apply_and_persist_updates(std::iter::once((key, value)))
    }

    /// Helper method to update an existing nested field in a JSON object using a path.
    ///
    /// Rejects unknown leaf or intermediate keys instead of inserting new fields that
    /// `serde` would silently ignore on deserialization.
    fn update_nested_field(
        obj: &mut serde_json::Map<String, Value>,
        path: &[&str],
        full_key: &str,
        value: Value,
    ) -> Result<(), Error> {
        if path.is_empty() {
            return Err(Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unknown settings key: {full_key}"),
            ));
        }

        let field = path[0];
        if path.len() == 1 {
            if obj.contains_key(field) {
                obj.insert(field.to_string(), value);
                return Ok(());
            }
            return Err(Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unknown settings key: {full_key}"),
            ));
        }

        match obj.get_mut(field) {
            Some(Value::Object(nested_obj)) => {
                Self::update_nested_field(nested_obj, &path[1..], full_key, value)
            }
            Some(_) => Err(Error::new(
                io::ErrorKind::InvalidInput,
                format!("Invalid nested path at: {field}"),
            )),
            None => Err(Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unknown settings key: {full_key}"),
            )),
        }
    }

    /// Retrieves the value of a specific setting field.
    ///
    /// This method gets the value of a setting identified by its key.
    ///
    /// # Arguments
    ///
    /// * `&self` - Reference to the settings state.
    /// * `key` - A string slice identifying the setting to retrieve.
    ///
    /// # Returns
    ///
    /// * `Ok(Value)` - The value of the requested setting if found.
    /// * `Err(Error)` - If the key doesn't exist or there's an error accessing the settings.
    ///
    /// # Example
    ///
    /// ```rust
    /// let theme = settings_state.get_setting_field("theme")?;
    /// println!("Current theme: {}", theme);
    /// ```
    pub fn get_setting_field(&self, key: &str) -> Result<Value, Error> {
        let settings = self
            .0
            .lock()
            .map_err(|_| io::Error::other("Failed to acquire settings lock"))?;
        let settings_value = serde_json::to_value(&*settings).map_err(io::Error::other)?;

        if let Some(obj) = settings_value.as_object() {
            let resolved_key = Self::resolve_setting_key(key);

            // Handle nested fields with dot notation
            if resolved_key.contains('.') {
                let path: Vec<&str> = resolved_key.split('.').collect();
                return Self::get_nested_field(obj, &path);
            }

            // Handle top-level fields
            obj.get(resolved_key).cloned().ok_or_else(|| {
                Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("Unknown settings key: {key}"),
                )
            })
        } else {
            Err(Error::new(
                io::ErrorKind::InvalidData,
                "Failed to serialize settings to object",
            ))
        }
    }

    /// Helper method to get a nested field from a JSON object using a path.
    ///
    /// # Arguments
    ///
    /// * `obj` - The JSON object to retrieve from
    /// * `path` - Vector of path segments (field names)
    ///
    /// # Returns
    ///
    /// * `Ok(Value)` - The value at the specified path if found
    /// * `Err(Error)` - If the path is invalid or not found
    fn get_nested_field(
        obj: &serde_json::Map<String, Value>,
        path: &[&str],
    ) -> Result<Value, Error> {
        if path.is_empty() {
            return Err(Error::new(
                io::ErrorKind::InvalidInput,
                "Empty path provided",
            ));
        }

        let field = path[0];

        if let Some(value) = obj.get(field) {
            if path.len() == 1 {
                // Base case: return the value
                return Ok(value.clone());
            }

            // Recursive case: continue traversing
            if let Some(nested_obj) = value.as_object() {
                return Self::get_nested_field(nested_obj, &path[1..]);
            } else {
                return Err(Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("Cannot traverse into non-object field: {field}"),
                ));
            }
        }

        Err(Error::new(
            io::ErrorKind::InvalidInput,
            format!("Unknown settings key: {}", path.join(".")),
        ))
    }

    /// Updates multiple settings fields atomically (all-or-nothing).
    ///
    /// Validates and applies all updates to a working copy first, then writes
    /// the updated settings to disk once before committing in-memory state.
    pub fn update_multiple_settings(
        &self,
        updates: &serde_json::Map<String, Value>,
    ) -> Result<Settings, Error> {
        if updates.is_empty() {
            return Err(Error::new(
                io::ErrorKind::InvalidInput,
                "No settings were provided",
            ));
        }

        self.apply_and_persist_updates(updates.iter().map(|(k, v)| (k.as_str(), v.clone())))
    }

    /// Resets all settings to their default values while preserving the settings file path.
    pub fn reset_settings(&self) -> Result<Settings, Error> {
        let mut settings = self
            .0
            .lock()
            .map_err(|_| io::Error::other("Failed to acquire settings lock"))?;

        let default_settings = Settings {
            abs_file_path_buf: settings.abs_file_path_buf.clone(),
            ..Settings::default()
        };
        self.write_settings_to_file(&default_settings)?;
        *settings = default_settings.clone();

        Ok(default_settings)
    }

    /// Creates a new SettingsState with a custom path for testing purposes.
    #[cfg(test)]
    pub fn new_with_path(path: PathBuf) -> Self {
        let defaults = Settings {
            abs_file_path_buf: path,
            ..Settings::default()
        };
        Self(Arc::new(Mutex::new(
            Self::write_settings_to_file_and_save_in_state(defaults),
        )))
    }

    /// Writes the current settings atomically to the configured file path.
    fn write_settings_to_file(&self, settings: &Settings) -> io::Result<()> {
        let user_config_file_path = &settings.abs_file_path_buf;
        let serialized = serde_json::to_string_pretty(&settings).map_err(io::Error::other)?;

        crate::state::atomic_write_file(user_config_file_path, serialized.as_bytes())
    }

    /// Helper method to write settings to a file and return the settings instance.
    fn write_settings_to_file_and_save_in_state(defaults: Settings) -> Settings {
        let settings_state = Self(Arc::new(Mutex::new(defaults.clone())));

        if let Err(e) = settings_state.write_settings_to_file(&defaults) {
            eprintln!("Error writing settings to file: {e}");
        }

        defaults
    }

    /// Reads settings from a file path.
    pub fn read_settings_from_file(path: &Path) -> io::Result<Settings> {
        let contents = std::fs::read_to_string(path)?;
        serde_json::from_str(&contents).map_err(|e| Error::new(io::ErrorKind::InvalidData, e))
    }
}

#[cfg(test)]
mod tests_settings {
    use super::*;
    use crate::commands::hash_commands::ChecksumMethod;
    use crate::models::LoggingLevel;
    use serde_json::{json, Map, Value};
    use tempfile::tempdir;

    /// Tests that the default settings have the expected initial values.
    ///
    /// Verifies that a newly created Settings instance has the correct
    /// default values for all properties.
    #[test]
    fn test_default_settings() {
        let settings = Settings::default();
        assert!(!settings.darkmode);
        //assert_eq!(settings.custom_themes, vec![]);
        assert_eq!(settings.default_theme, "".to_string());
        //assert_eq!(settings.default_themes_path, Default::default());
        //assert_eq!(settings.default_folder_path_on_opening, Default::default());
        assert_eq!(
            settings.backend_settings.default_checksum_hash,
            ChecksumMethod::SHA256
        );
        assert_eq!(
            settings.backend_settings.logging_config.logging_level,
            LoggingLevel::Full
        );
        assert!(
            !settings
                .backend_settings
                .search_engine_config
                .case_sensitive_search
        );
        assert!(
            !settings
                .backend_settings
                .search_engine_config
                .index_hidden_files
        );
        assert!(
            settings
                .backend_settings
                .search_engine_config
                .fuzzy_search_enabled
        );
        assert_eq!(
            settings.abs_file_path_buf,
            constants::SETTINGS_CONFIG_ABS_PATH.to_path_buf()
        );
    }

    /// Tests the creation of a new SettingsState with a custom path.
    ///
    /// Verifies that:
    /// 1. The settings file is created at the specified path
    /// 2. The file can be read back
    /// 3. The read settings have the expected default values
    /// 4. The path in the settings matches the custom path
    #[test]
    fn test_settings_state_creation() {
        // Create a temporary directory
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let test_path = temp_dir.path().join("settings.json");

        // Create a new Settings with our test path
        let _settings_state = SettingsState::new_with_path(test_path.clone());

        // Verify the file was created
        assert!(
            test_path.exists(),
            "Settings file should exist after creation"
        );

        // Read the file and verify its contents
        let read_result = SettingsState::read_settings_from_file(&test_path);
        assert!(read_result.is_ok(), "Should be able to read settings file");

        let settings = read_result.unwrap();
        assert!(!settings.darkmode);
        assert_eq!(settings.default_theme, "".to_string());
        //assert_eq!(settings.default_themes_path, Default::default());
        //assert_eq!(settings.default_folder_path_on_opening, Default::default());
        assert_eq!(settings.abs_file_path_buf, test_path);
    }

    #[test]
    fn test_init_settings_json_exists() {
        // Create a temporary directory
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let test_path = temp_dir.path().join("settings.json");

        // Step 1: Create the first SettingsState and update some values
        let settings_state = SettingsState::new_with_path(test_path.clone());

        let mut updates = Map::new();
        updates.insert("darkmode".to_string(), json!(true));
        updates.insert("default_theme".to_string(), json!("solarized"));

        let result = settings_state.update_multiple_settings(&updates);
        assert!(result.is_ok(), "Settings update should succeed");

        // Step 2: Drop the first state and reinitialize from file
        drop(settings_state);

        let loaded = SettingsState::read_settings_from_file(&test_path);
        assert!(
            loaded.is_ok(),
            "Should load settings from file after reload"
        );

        let loaded_settings = loaded.unwrap();
        assert!(loaded_settings.darkmode);
        assert_eq!(loaded_settings.default_theme, "solarized");
    }

    /// Tests writing custom settings to a file.
    ///
    /// Verifies that:
    /// 1. Modified settings can be written to disk successfully
    /// 2. The written settings can be read back correctly
    /// 3. The read settings match the original modified values
    #[test]
    fn test_write_settings_to_file() {
        // Create a temporary directory
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let test_path = temp_dir.path().join("settings.json");

        // Create a custom settings object
        let mut settings = Settings {
            abs_file_path_buf: test_path.clone(),
            default_folder_path_on_opening: PathBuf::from("temp_dir"),
            ..Settings::default()
        };
        settings.backend_settings.logging_config.logging_level = LoggingLevel::Partial;

        // Create a MetaDataState and write the custom metadata
        // Construct a MetaDataState with the custom metadata (is the struct from above)
        let settings_state = SettingsState(Arc::new(Mutex::new(settings.clone())));
        let write_result = settings_state.write_settings_to_file(&settings);
        assert!(write_result.is_ok(), "Writing settings should succeed");

        // Read back the file and verify contents
        let read_result = SettingsState::read_settings_from_file(&test_path);
        assert!(read_result.is_ok(), "Should be able to read metadata file");

        let read_settings = read_result.unwrap();
        assert_eq!(
            read_settings.default_folder_path_on_opening,
            PathBuf::from("temp_dir")
        );
    }

    fn create_test_settings_state() -> (SettingsState, tempfile::TempDir) {
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let test_path = temp_dir.path().join("settings.json");
        let state = SettingsState::new_with_path(test_path);
        (state, temp_dir)
    }

    /// Tests updating the darkmode setting field.
    ///
    /// Verifies that:
    /// 1. The darkmode field can be updated to true
    /// 2. The returned settings object reflects the updated value
    #[test]
    fn test_update_darkmode_field() {
        let (state, _temp_dir) = create_test_settings_state();

        let result = state.update_setting_field("darkmode", json!(true));
        assert!(result.is_ok());
        assert!(result.unwrap().darkmode);
    }

    /// Tests updating the default_theme setting field.
    ///
    /// Verifies that:
    /// 1. The default_theme field can be updated to a new string value
    /// 2. The returned settings object reflects the updated value
    #[test]
    fn test_update_default_theme_field() {
        let (state, _temp_dir) = create_test_settings_state();

        let result = state.update_setting_field("default_theme", json!("ocean"));
        assert!(result.is_ok());
        assert_eq!(result.unwrap().default_theme, "ocean");
    }

    /// Tests updating the default_checksum_hash setting field.
    ///
    /// Verifies that:
    /// 1. The default_checksum_hash field can be updated to a new string value
    /// 2. The returned settings object reflects the updated value
    #[test]
    fn test_update_default_checksum_hash_field() {
        let (state, _temp_dir) = create_test_settings_state();

        let result =
            state.update_setting_field("backend_settings.default_checksum_hash", json!("MD5"));
        assert!(result.is_ok());
        assert_eq!(
            result.unwrap().backend_settings.default_checksum_hash,
            ChecksumMethod::MD5
        );
    }

    /// Tests updating the custom_themes setting field.
    ///
    /// Verifies that:
    /// 1. The custom_themes field can be updated to an array of strings
    /// 2. The returned settings object reflects the updated values
    #[test]
    fn test_update_custom_themes_field() {
        let (state, _temp_dir) = create_test_settings_state();

        let themes = vec!["dark".to_string(), "light".to_string()];
        let result = state.update_setting_field("custom_themes", json!(themes.clone()));
        assert!(result.is_ok());
        assert_eq!(result.unwrap().custom_themes, themes);
    }

    /// Tests updating path-type settings fields.
    ///
    /// Verifies that:
    /// 1. The default_themes_path field can be updated with a path string
    /// 2. The default_folder_path_on_opening field can be updated with a path string
    /// 3. Both fields are properly converted to PathBuf values
    #[test]
    fn test_update_path_fields() {
        let (state, _temp_dir) = create_test_settings_state();

        let path = "/some/path";
        let result1 = state.update_setting_field("default_themes_path", json!(path));
        let result2 = state.update_setting_field("default_folder_path_on_opening", json!(path));

        assert!(result1.is_ok());
        assert!(result2.is_ok());
        assert_eq!(result1.unwrap().default_themes_path, PathBuf::from(path));
        assert_eq!(
            result2.unwrap().default_folder_path_on_opening,
            PathBuf::from(path)
        );
    }

    /// Tests updating the logging_state setting field.
    ///
    /// Verifies that:
    /// 1. The logging_state field can be updated to a different enum value
    /// 2. The returned settings object reflects the updated enum value
    #[test]
    fn test_update_logging_level_field() {
        let (state, _temp_dir) = create_test_settings_state();

        let result = state.update_setting_field(
            "backend_settings.logging_config.logging_level",
            json!("Minimal"),
        );
        assert!(result.is_ok());
        assert_eq!(
            result
                .unwrap()
                .backend_settings
                .logging_config
                .logging_level,
            LoggingLevel::Minimal
        );
    }

    /// Tests error handling when attempting to update a non-existent key.
    ///
    /// Verifies that:
    /// 1. Attempting to update a non-existent key results in an error
    /// 2. The error message contains "Unknown settings key"
    #[test]
    fn test_invalid_key() {
        let (state, _temp_dir) = create_test_settings_state();

        let result = state.update_setting_field("non_existing_key", json!("value"));
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Unknown settings key"));
    }

    /// Tests type validation when updating the darkmode field.
    ///
    /// Verifies that:
    /// 1. Attempting to update the darkmode field with a non-boolean value results in an error
    /// 2. The error message indicates the type mismatch
    #[test]
    fn test_invalid_type_for_darkmode() {
        let (state, _temp_dir) = create_test_settings_state();

        let result = state.update_setting_field("darkmode", json!("not_a_bool"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("expected a boolean") || err.contains("invalid type"));
    }

    /// Tests retrieving an existing setting field.
    ///
    /// Verifies that:
    /// 1. A previously set field can be retrieved successfully
    /// 2. The retrieved value matches what was set
    #[test]
    fn test_get_existing_field() {
        let (settings_state, _temp_dir) = create_test_settings_state();

        // Set a known value
        settings_state
            .update_setting_field("darkmode", json!(true))
            .unwrap();

        // Call get_setting_field
        let result = settings_state.get_setting_field("darkmode");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), json!(true));
    }

    /// Tests error handling when retrieving a non-existent key.
    ///
    /// Verifies that:
    /// 1. Attempting to get a non-existent key results in an error
    /// 2. The error message contains "Unknown settings key"
    #[test]
    fn test_get_invalid_key() {
        let (settings_state, _temp_dir) = create_test_settings_state();

        let result = settings_state.get_setting_field("non_existing_key");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Unknown settings key"));
    }

    /// Tests retrieving a complex field (array type).
    ///
    /// Verifies that:
    /// 1. A complex field (array of strings) can be retrieved successfully
    /// 2. The retrieved value matches what was set
    #[test]
    fn test_get_complex_field() {
        let (settings_state, _temp_dir) = create_test_settings_state();

        settings_state
            .update_setting_field("custom_themes", json!(["dark", "light"]))
            .unwrap();

        let result = settings_state.get_setting_field("custom_themes");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), json!(["dark", "light"]));
    }

    /// Tests updating multiple valid settings fields at once.
    ///
    /// Verifies that:
    /// 1. Multiple fields can be updated in a single operation
    /// 2. All updated fields have the expected values in the returned settings
    #[test]
    fn test_update_multiple_valid_fields() {
        let (settings_state, _temp_dir) = create_test_settings_state();

        let mut updates: Map<String, Value> = Map::new();
        updates.insert("darkmode".into(), Value::Bool(true));
        updates.insert("default_theme".into(), Value::String("gruvbox".into()));

        let result = settings_state.update_multiple_settings(&updates);
        assert!(result.is_ok());

        let updated = result.unwrap();
        assert!(updated.darkmode);
        assert_eq!(updated.default_theme, "gruvbox");
    }

    /// Tests error handling when updating with an invalid key.
    ///
    /// Verifies that:
    /// 1. Attempting to update multiple settings with a non-existent key results in an error
    /// 2. The error message identifies the specific invalid key
    #[test]
    fn test_update_with_invalid_key() {
        let (settings_state, _temp_dir) = create_test_settings_state();

        let mut updates: Map<String, Value> = Map::new();
        updates.insert("non_existing_field".into(), Value::String("value".into()));

        let result = settings_state.update_multiple_settings(&updates);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Unknown settings key: non_existing_field"));
    }

    /// Tests error handling when updating with a mix of valid and invalid keys.
    ///
    /// Verifies that:
    /// 1. When attempting to update multiple settings with both valid and invalid keys,
    ///    the operation fails with an error
    /// 2. No partial updates are applied (all-or-nothing behavior) in memory or on disk
    /// 3. The error message identifies the specific invalid key
    #[test]
    fn test_update_with_mixed_valid_and_invalid_keys() {
        let (settings_state, temp_dir) = create_test_settings_state();

        let mut updates: Map<String, Value> = Map::new();
        updates.insert("darkmode".into(), Value::Bool(true));
        updates.insert("unknown".into(), Value::String("oops".into()));

        let result = settings_state.update_multiple_settings(&updates);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Unknown settings key: unknown"));

        // Verify all-or-nothing rollback in memory and on disk
        assert_eq!(
            settings_state.get_setting_field("darkmode").unwrap(),
            json!(false)
        );
        let on_disk =
            SettingsState::read_settings_from_file(&temp_dir.path().join("settings.json"))
                .expect("Should read settings from disk");
        assert!(!on_disk.darkmode);
    }

    /// Tests error handling when updating with an empty updates map.
    ///
    /// Verifies that:
    /// 1. Attempting to update with an empty map results in an error
    /// 2. The error message indicates that no settings were provided
    #[test]
    fn test_update_with_empty_updates_map() {
        let (settings_state, _temp_dir) = create_test_settings_state();

        let updates: Map<String, Value> = Map::new();

        let result = settings_state.update_multiple_settings(&updates);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().to_string(), "No settings were provided");
    }

    /// Tests type validation when updating with an invalid value type.
    ///
    /// Verifies that:
    /// 1. Attempting to update a field with a value of the wrong type results in an error
    /// 2. The error message indicates the type mismatch
    #[test]
    fn test_update_with_invalid_value_type() {
        let (settings_state, temp_dir) = create_test_settings_state();

        let mut updates: Map<String, Value> = Map::new();
        updates.insert("default_theme".into(), Value::String("changed".into()));
        updates.insert("darkmode".into(), Value::String("not_a_bool".into())); // darkmode expects bool

        let result = settings_state.update_multiple_settings(&updates);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("invalid type: string"));

        // Verify default_theme was NOT partially applied
        assert_eq!(
            settings_state.get_setting_field("default_theme").unwrap(),
            json!("")
        );
        let on_disk =
            SettingsState::read_settings_from_file(&temp_dir.path().join("settings.json"))
                .expect("Should read settings from disk");
        assert_eq!(on_disk.default_theme, "");
    }

    /// TP-BE-06: Verify SearchEngineConfig boolean flags round-trip via flat keys and resolve_setting_key.
    #[test]
    fn test_search_engine_boolean_flags_roundtrip() {
        let (settings_state, temp_dir) = create_test_settings_state();

        assert_eq!(
            settings_state
                .get_setting_field("case_sensitive_search")
                .unwrap(),
            json!(false)
        );
        assert_eq!(
            settings_state
                .get_setting_field("index_hidden_files")
                .unwrap(),
            json!(false)
        );
        assert_eq!(
            settings_state
                .get_setting_field("fuzzy_search_enabled")
                .unwrap(),
            json!(true)
        );

        settings_state
            .update_setting_field("case_sensitive_search", json!(true))
            .expect("case_sensitive_search update should succeed");
        settings_state
            .update_setting_field("index_hidden_files", json!(true))
            .expect("index_hidden_files update should succeed");
        settings_state
            .update_setting_field("fuzzy_search_enabled", json!(false))
            .expect("fuzzy_search_enabled update should succeed");

        assert_eq!(
            settings_state
                .get_setting_field("case_sensitive_search")
                .unwrap(),
            json!(true)
        );
        assert_eq!(
            settings_state
                .get_setting_field("index_hidden_files")
                .unwrap(),
            json!(true)
        );
        assert_eq!(
            settings_state
                .get_setting_field("fuzzy_search_enabled")
                .unwrap(),
            json!(false)
        );

        let reloaded =
            SettingsState::read_settings_from_file(&temp_dir.path().join("settings.json"))
                .expect("Should reload settings from disk");
        assert!(
            reloaded
                .backend_settings
                .search_engine_config
                .case_sensitive_search
        );
        assert!(
            reloaded
                .backend_settings
                .search_engine_config
                .index_hidden_files
        );
        assert!(
            !reloaded
                .backend_settings
                .search_engine_config
                .fuzzy_search_enabled
        );
    }

    /// TP-BE-06: Reject unknown nested keys explicitly instead of silently dropping them.
    #[test]
    fn test_update_nested_unknown_key_rejected() {
        let (settings_state, _temp_dir) = create_test_settings_state();

        let err1 = settings_state
            .update_setting_field(
                "backend_settings.search_engine_config.nonexistent_flag",
                json!(true),
            )
            .expect_err("Unknown nested leaf key must be rejected");
        assert!(err1.to_string().contains("Unknown settings key"));

        let err2 = settings_state
            .update_setting_field("backend_settings.nonexistent_section.field", json!(true))
            .expect_err("Unknown nested object key must be rejected");
        assert!(err2.to_string().contains("Unknown settings key"));
    }

    /// TP-SEC-05: Reject external mutation of abs_file_path_buf.
    #[test]
    fn test_update_rejects_abs_file_path_buf() {
        let (settings_state, temp_dir) = create_test_settings_state();
        let original_path = temp_dir.path().join("settings.json");
        let redirected_path = temp_dir.path().join("hijacked_settings.json");

        let single_res = settings_state.update_setting_field(
            "abs_file_path_buf",
            json!(redirected_path.to_string_lossy()),
        );
        assert!(
            single_res.is_err(),
            "Direct mutation of abs_file_path_buf must be rejected"
        );
        assert!(!redirected_path.exists());

        let mut batch = Map::new();
        batch.insert("darkmode".into(), json!(true));
        batch.insert(
            "abs_file_path_buf".into(),
            json!(redirected_path.to_string_lossy()),
        );
        let batch_res = settings_state.update_multiple_settings(&batch);
        assert!(
            batch_res.is_err(),
            "Batch mutation containing abs_file_path_buf must be rejected"
        );
        assert!(!redirected_path.exists());
        assert_eq!(
            settings_state.get_setting_field("darkmode").unwrap(),
            json!(false)
        );
        assert_eq!(
            settings_state.0.lock().unwrap().abs_file_path_buf,
            original_path
        );
    }

    /// TP-BE-06: reset_settings preserves the instance's abs_file_path_buf.
    #[test]
    fn test_reset_settings_preserves_abs_file_path_buf() {
        let (settings_state, temp_dir) = create_test_settings_state();
        let expected_path = temp_dir.path().join("settings.json");

        settings_state
            .update_setting_field("darkmode", json!(true))
            .expect("Update should succeed");
        settings_state
            .update_setting_field("case_sensitive_search", json!(true))
            .expect("Search flag update should succeed");

        let reset = settings_state
            .reset_settings()
            .expect("reset_settings should succeed");
        assert!(!reset.darkmode);
        assert!(
            !reset
                .backend_settings
                .search_engine_config
                .case_sensitive_search
        );
        assert_eq!(reset.abs_file_path_buf, expected_path);

        let on_disk = SettingsState::read_settings_from_file(&expected_path)
            .expect("Should read reset settings from custom file");
        assert!(!on_disk.darkmode);
        assert_eq!(on_disk.abs_file_path_buf, expected_path);
    }

    /// TP-BE-06: Corrupt settings.json is backed up to settings.json.corrupt.bak before restoring defaults.
    #[test]
    fn test_corrupt_settings_backed_up_before_defaults() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let settings_path = temp_dir.path().join("settings.json");
        let backup_path = temp_dir.path().join("settings.json.corrupt.bak");

        let corrupt_payload = "{ \"darkmode\": \"corrupt_boolean\", broken json";
        std::fs::write(&settings_path, corrupt_payload).expect("Should write corrupt file");

        let state = SettingsState::load_or_init_with_path(settings_path.clone());
        assert!(
            backup_path.exists(),
            "Corrupt settings file should be backed up to settings.json.corrupt.bak"
        );
        assert_eq!(
            std::fs::read_to_string(&backup_path).unwrap(),
            corrupt_payload
        );

        let recovered = state.0.lock().unwrap().clone();
        assert!(!recovered.darkmode);
        assert_eq!(recovered.abs_file_path_buf, settings_path);

        let on_disk = SettingsState::read_settings_from_file(&settings_path)
            .expect("New default settings file should be valid JSON");
        assert!(!on_disk.darkmode);
        assert_eq!(on_disk.abs_file_path_buf, settings_path);
    }

    #[test]
    fn test_terminal_sync_explorer_to_terminal_setting() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let settings_path = temp_dir.path().join("settings.json");
        let state = SettingsState::load_or_init_with_path(settings_path);
        assert!(!state.0.lock().unwrap().terminal_sync_explorer_to_terminal);

        let updated = state
            .update_setting_field("terminal_sync_explorer_to_terminal", json!(true))
            .expect("Updating terminal_sync_explorer_to_terminal should succeed");
        assert!(updated.terminal_sync_explorer_to_terminal);
    }
}
