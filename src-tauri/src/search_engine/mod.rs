mod art_v5;
mod fast_fuzzy_v2;
mod lru_cache_v2;
mod path_cache_wrapper;
pub mod search_core;

#[cfg(test)]
pub mod test_generate_test_data {
    use crate::log_info;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    static TEST_DATA_GEN_LOCK: Mutex<()> = Mutex::new(());

    /// Generates a test data directory structure with random folder and file names.
    /// This function creates a hierarchical directory structure with random file and folder names
    /// for testing purposes. It creates a specified number of folders per level, with files
    /// in each folder, up to a maximum depth.
    ///
    /// # Arguments
    /// * `base_path` - A PathBuf that specifies the root directory where the test data will be created.
    ///
    /// # Returns
    /// * `Ok(PathBuf)` - The path to the created test data directory if successful.
    /// * `Err(std::io::Error)` - If there was an error during directory or file creation.
    ///
    /// # Example
    /// ```rust
    /// use std::path::PathBuf;
    /// use crate::search_engine::test_generate_test_data::generate_test_data;
    ///
    /// let test_dir = PathBuf::from("/path/to/test_data");
    /// match generate_test_data(test_dir) {
    ///     Ok(path) => println!("Test data created at: {:?}", path),
    ///     Err(err) => println!("Failed to create test data: {}", err),
    /// }
    /// ```
    #[allow(dead_code)]
    pub fn generate_test_data(base_path: PathBuf) -> Result<PathBuf, std::io::Error> {
        let _guard = TEST_DATA_GEN_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        generate_test_data_locked(&base_path, 20, 20, 3, true)?;
        Ok(base_path)
    }

    fn generate_test_data_locked(
        base_path: &Path,
        folders_per_level: usize,
        files_per_folder: usize,
        max_depth: usize,
        clean_existing: bool,
    ) -> Result<(), std::io::Error> {
        use rand::{thread_rng, Rng};
        use std::fs::{create_dir_all, File};
        use std::time::Instant;

        // Remove the directory if it already exists when requested
        if clean_existing && base_path.exists() {
            log_info!("Removing existing test data at: {:?}", base_path);
            std::fs::remove_dir_all(base_path)?;
        }

        // Create the base directory
        create_dir_all(base_path)?;
        log_info!("Creating test data at: {:?}", base_path);

        let start_time = Instant::now();

        // Function to generate random strings based on a predefined set
        let generate_random_name = || -> String {
            let charset: Vec<&str> =
                "banana,apple,orange,grape,watermelon,kiwi,mango,peach,cherry,\
        strawberry,blueberry,raspberry,blackberry,lemon,lime,coconut,papaya,pineapple,tangerine,\
        car,truck,motorcycle,bicycle,bus,train,airplane,helicopter,boat,ship,submarine,scooter,van,\
        ambulance,taxi,firetruck,tractor,yacht,jetski,speedboat,racecar"
                    .split(",")
                    .collect::<Vec<_>>();

            let mut rng = thread_rng();

            let idx = rng.gen_range(0, charset.len());
            charset[idx].to_string()
        };

        // Function to create file extensions
        let generate_extension = || -> &str {
            const EXTENSIONS: [&str; 20] = [
                "txt", "pdf", "doc", "jpg", "png", "mp3", "mp4", "html", "css", "js", "rs", "json",
                "xml", "md", "csv", "zip", "exe", "dll", "sh", "py",
            ];

            let mut rng = thread_rng();
            let idx = rng.gen_range(0, EXTENSIONS.len());
            EXTENSIONS[idx]
        };

        // Counter to track progress
        let entry_count = Arc::new(Mutex::new(0usize));

        // Recursive function to create the folder structure
        fn create_structure(
            path: &Path,
            depth: usize,
            max_depth: usize,
            folders_per_level: usize,
            files_per_folder: usize,
            name_generator: &dyn Fn() -> String,
            ext_generator: &dyn Fn() -> &'static str,
            counter: &Arc<Mutex<usize>>,
        ) -> Result<(), std::io::Error> {
            // Create files in current folder
            for _ in 0..files_per_folder {
                let file_name = format!("{}.{}", name_generator(), ext_generator());
                let file_path = path.join(file_name);
                File::create(file_path)?;

                // Increment counter
                if let Ok(mut count) = counter.lock() {
                    *count += 1;
                    if *count % 1000 == 0 {
                        log_info!("Created {} entries so far...", *count);
                    }
                }
            }

            // Stop creating subfolders if we've reached max depth
            if depth >= max_depth {
                return Ok(());
            }

            // Create subfolders and recurse
            for _ in 0..folders_per_level {
                let folder_name = name_generator();
                let folder_path = path.join(folder_name);
                create_dir_all(&folder_path)?;

                // Increment counter for folder
                if let Ok(mut count) = counter.lock() {
                    *count += 1;
                }

                // Recurse into subfolder
                create_structure(
                    &folder_path,
                    depth + 1,
                    max_depth,
                    folders_per_level,
                    files_per_folder,
                    name_generator,
                    ext_generator,
                    counter,
                )?;
            }

            Ok(())
        }

        if folders_per_level > 0 || files_per_folder > 0 {
            create_structure(
                base_path,
                0,
                max_depth,
                folders_per_level,
                files_per_folder,
                &generate_random_name,
                &generate_extension,
                &entry_count,
            )?;
        }

        let total_count = *entry_count.lock().unwrap();
        let elapsed = start_time.elapsed();

        log_info!("Test data generation complete!");
        log_info!("Created {} total entries in {:?}", total_count, elapsed);
        log_info!("Path: {:?}", base_path);

        Ok(())
    }

    #[allow(dead_code)]
    pub fn generate_test_data_if_not_exists(base_path: PathBuf) -> Result<(), std::io::Error> {
        let _guard = TEST_DATA_GEN_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let ready_marker = base_path.join(".test_data_ready");
        let has_entries = base_path.exists()
            && (ready_marker.exists()
                || std::fs::read_dir(&base_path)
                    .map(|mut d| d.next().is_some())
                    .unwrap_or(false));

        if !has_entries {
            log_info!("Test data not found, generating...");
            generate_test_data_locked(&base_path, 20, 20, 3, true)?;
            std::fs::write(&ready_marker, b"ok")?;
        } else {
            log_info!("Test data already exists at: {:?}", base_path);
        }
        Ok(())
    }

    /// Creates an isolated `TempDir` populated with deterministic seed files/subdirectories
    /// plus optional random hierarchical entries so tests never race on `./test-data-for-fuzzy-search`.
    #[allow(dead_code)]
    pub fn create_isolated_test_fixture(
        folders_per_level: usize,
        files_per_folder: usize,
        max_depth: usize,
    ) -> Result<tempfile::TempDir, std::io::Error> {
        let temp_dir = tempfile::tempdir()?;
        let root = temp_dir.path();

        let seed_files = [
            "file1.txt",
            "file2.txt",
            "test.md",
            "apple.pdf",
            "banana.txt",
            "orange.md",
            "train.txt",
            "document.pdf",
            "readme.md",
        ];
        for file_name in &seed_files {
            std::fs::write(root.join(file_name), format!("seed content for {}", file_name))?;
        }

        let subdir_alpha = root.join("subdir_alpha");
        let subdir_beta = root.join("subdir_beta");
        std::fs::create_dir_all(&subdir_alpha)?;
        std::fs::create_dir_all(&subdir_beta)?;

        for file_name in [
            "file_alpha1.txt",
            "file_alpha2.txt",
            "test_alpha.md",
            "apple_notes.txt",
        ] {
            std::fs::write(
                subdir_alpha.join(file_name),
                format!("alpha content for {}", file_name),
            )?;
        }

        for file_name in [
            "file_beta1.txt",
            "file_beta2.txt",
            "test_beta.md",
            "train_schedule.txt",
        ] {
            std::fs::write(
                subdir_beta.join(file_name),
                format!("beta content for {}", file_name),
            )?;
        }

        if folders_per_level > 0 || files_per_folder > 0 {
            generate_test_data_locked(
                root,
                folders_per_level,
                files_per_folder,
                max_depth,
                false,
            )?;
        }

        Ok(temp_dir)
    }
}
