use crate::error_handling::{Error, ErrorCode};
use crate::state::meta_data::MetaDataState;
use std::sync::{Arc, Mutex};
use tauri::State;

/// Retrieves system metadata information as a JSON string.
/// This includes information about volumes, drives, and storage devices.
/// Updates the metadata state before returning the JSON.
///
/// # Arguments
/// * `state` - The application state containing metadata information.
///
/// # Returns
/// * `Ok(String)` - A JSON string containing the metadata if successful.
/// * `Err(String)` - If there was an error retrieving or serializing the metadata.
///
/// # Example
/// ```javascript
/// invoke('get_meta_data_as_json')
///   .then((response) => {
///     // Process the metadata JSON
///     console.log('Metadata:', response);
///     const metadata = JSON.parse(response);
///     // Use the metadata in the UI
///   })
///   .catch((error) => {
///     console.error('Error retrieving metadata:', error);
///   });
/// ```
#[tauri::command]
pub fn get_meta_data_as_json(state: State<Arc<Mutex<MetaDataState>>>) -> Result<String, String> {
    get_meta_data_as_json_impl(state.inner().clone())
}

pub fn get_meta_data_as_json_impl(state: Arc<Mutex<MetaDataState>>) -> Result<String, String> {
    let meta_data_guard = state.lock().map_err(|_| {
        Error::new(
            ErrorCode::InternalError,
            "Failed to acquire lock on metadata state".to_string(),
        )
        .to_json()
    })?;

    meta_data_guard.refresh_volumes().map_err(|e| {
        Error::new(
            ErrorCode::InternalError,
            format!("Error refreshing volumes: {e}"),
        )
        .to_json()
    })?;

    let inner_meta_data = meta_data_guard.0.lock().map_err(|_| {
        Error::new(
            ErrorCode::InternalError,
            "Failed to acquire inner lock on metadata state".to_string(),
        )
        .to_json()
    })?;

    serde_json::to_string(&*inner_meta_data).map_err(|e| {
        Error::new(
            ErrorCode::InternalError,
            format!("Error serializing metadata: {e}"),
        )
        .to_json()
    })
}

#[tauri::command]
pub fn update_meta_data(state: State<Arc<Mutex<MetaDataState>>>) -> Result<(), String> {
    update_meta_data_impl(state.inner().clone())
}

pub fn update_meta_data_impl(state: Arc<Mutex<MetaDataState>>) -> Result<(), String> {
    let meta_data_guard = state.lock().map_err(|_| {
        Error::new(
            ErrorCode::InternalError,
            "Failed to acquire lock on metadata state".to_string(),
        )
        .to_json()
    })?;

    meta_data_guard
        .refresh_volumes()
        .map_err(|e| Error::new(ErrorCode::InternalError, format!("Error: {e}")).to_json())
}

#[cfg(test)]
mod tests_meta_data_commands {
    use super::*;

    // Helper function to create a test MetaDataState
    fn create_test_meta_data_state() -> (Arc<Mutex<MetaDataState>>, tempfile::TempDir) {
        // Create a temporary MetaDataState for testing isolated from real user config
        let temp_dir = tempfile::tempdir().expect("Failed to create temporary directory");
        let meta_path = temp_dir.path().join("meta_data.json");
        let state = Arc::new(Mutex::new(MetaDataState::new_with_path(meta_path)));
        (state, temp_dir)
    }

    #[test]
    fn test_get_meta_data_as_json_success() {
        let (state, _temp_dir) = create_test_meta_data_state();

        // Call the implementation function with our test state
        let result = get_meta_data_as_json_impl(state.clone());

        // Check that we got a successful result
        assert!(result.is_ok());

        // Verify the JSON contains expected metadata structure
        let json = result.unwrap();
        assert!(json.contains("volumes"));
    }

    #[test]
    fn test_get_meta_data_as_json_contains_volumes() {
        let (state, _temp_dir) = create_test_meta_data_state();

        // First update the metadata to ensure we have fresh data
        state
            .lock()
            .unwrap()
            .refresh_volumes()
            .expect("Failed to refresh volumes");

        // Call the implementation function
        let result = get_meta_data_as_json_impl(state);

        // Verify the result contains volumes information
        assert!(result.is_ok());
        let json = result.unwrap();

        // Parse the JSON to check its structure
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("Failed to parse JSON");

        // Check that the parsed JSON has the expected structure
        assert!(parsed.is_object());
        assert!(parsed
            .as_object()
            .unwrap()
            .contains_key("all_volumes_with_information"));
    }

    #[test]
    fn test_update_meta_data_success() {
        let (state, _temp_dir) = create_test_meta_data_state();
        let result = update_meta_data_impl(state);
        assert!(result.is_ok(), "update_meta_data_impl should succeed");
    }

    #[test]
    fn test_update_meta_data_poisoned_mutex_returns_err() {
        let (state, _temp_dir) = create_test_meta_data_state();
        let state_clone = state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = state_clone.lock().unwrap();
            panic!("intentional metadata state poison");
        })
        .join();

        let err =
            update_meta_data_impl(state.clone()).expect_err("Poisoned outer mutex must return Err");
        assert!(err.contains("InternalError"));

        let json_err =
            get_meta_data_as_json_impl(state).expect_err("Poisoned outer mutex must return Err");
        assert!(json_err.contains("InternalError"));
    }
}
