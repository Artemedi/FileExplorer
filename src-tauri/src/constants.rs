use std::env;
use std::path::PathBuf;
use std::sync::LazyLock;

pub static VERSION: &str = "0.2.17";

/// Returns the base directory for application data (config, logs, templates).
/// On Windows: %APPDATA%\Explr
/// On macOS: ~/Library/Application Support/Explr
/// On Linux: $XDG_CONFIG_HOME/explr or ~/.config/explr
/// In local dev / portable mode: if EXPLR_DATA_DIR env is set, use that.
pub fn get_app_base_dir() -> PathBuf {
    if let Ok(custom_dir) = env::var("EXPLR_DATA_DIR") {
        return PathBuf::from(custom_dir);
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = env::var("APPDATA") {
            return PathBuf::from(app_data).join("Explr");
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = home::home_dir() {
            return home
                .join("Library")
                .join("Application Support")
                .join("Explr");
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = env::var("XDG_CONFIG_HOME") {
            return PathBuf::from(xdg).join("explr");
        }
        if let Some(home) = home::home_dir() {
            return home.join(".config").join("explr");
        }
    }

    if let Some(home) = home::home_dir() {
        home.join(".explr")
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("explr_data")
    }
}

pub static CONFIG_PATH: LazyLock<PathBuf> = LazyLock::new(|| {
    let base = get_app_base_dir();
    let config_dir = base.join("config");
    let _ = std::fs::create_dir_all(&config_dir);
    config_dir
});

pub static META_DATA_CONFIG_ABS_PATH: LazyLock<PathBuf> =
    LazyLock::new(|| CONFIG_PATH.join(META_DATA_CONFIG_FILE_NAME));

pub static LOG_PATH: LazyLock<PathBuf> = LazyLock::new(|| {
    let base = get_app_base_dir();
    let logs_dir = base.join("logs");
    let _ = std::fs::create_dir_all(&logs_dir);
    logs_dir
});

pub static META_DATA_CONFIG_FILE_NAME: &str = "meta_data.json";

pub static LOG_FILE_NAME: &str = "app.log";
pub static ERROR_LOG_FILE_NAME: &str = "error.log";

pub static TEST_DATA_PATH: &str = "./test-data-for-fuzzy-search";

pub static LOG_FILE_ABS_PATH: LazyLock<PathBuf> = LazyLock::new(|| LOG_PATH.join(LOG_FILE_NAME));

pub static ERROR_LOG_FILE_ABS_PATH: LazyLock<PathBuf> =
    LazyLock::new(|| LOG_PATH.join(ERROR_LOG_FILE_NAME));

pub const MAX_NUMBER_OF_LOG_FILES: usize = 3;

pub static SETTINGS_CONFIG_ABS_PATH: LazyLock<PathBuf> =
    LazyLock::new(|| CONFIG_PATH.join(SETTINGS_CONFIG_FILE_NAME));
pub static SETTINGS_CONFIG_FILE_NAME: &str = "settings.json";

pub static TEMPLATES_ABS_PATH_FOLDER: LazyLock<PathBuf> =
    LazyLock::new(|| CONFIG_PATH.join(TEMPLATES_FOLDER));
pub static TEMPLATES_FOLDER: &str = "templates";
