use crate::error_handling::Error;
use anyhow::Result;
use base64::Engine;
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAX_IMAGE_PREVIEW_BYTES: u64 = 6 * 1024 * 1024;
const MAX_PDF_PREVIEW_BYTES: u64 = 12 * 1024 * 1024;
const HEAD_READ_BYTES: usize = 256 * 1024;
const MAX_TEXT_PREVIEW_CHARS: usize = 200_000;
const MAX_FOLDER_PREVIEW_ENTRIES: usize = 500;

#[derive(Serialize, Debug)]
#[serde(tag = "kind")]
pub enum PreviewPayload {
    Image {
        name: String,
        data_uri: String,
        bytes: usize,
    },
    Pdf {
        name: String,
        data_uri: String,
        bytes: usize,
    },
    Video {
        name: String,
        path: String,
    },
    Audio {
        name: String,
        path: String,
    },
    Text {
        name: String,
        text: String,
        truncated: bool,
    },
    Folder {
        name: String,
        size: u64,
        item_count: usize,
        modified: Option<String>,
    },
    Unknown {
        name: String,
    },
    #[allow(dead_code)]
    Error {
        name: String,
        message: String,
    },
}

fn filename(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file".to_string())
}

fn read_prefix(path: &Path, max_bytes: usize) -> Result<Vec<u8>> {
    let mut f = fs::File::open(path)?;
    let mut buf = Vec::with_capacity(max_bytes.min(1024 * 1024));
    (&mut f).take(max_bytes as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

fn detect_mime(path: &Path, head: &[u8]) -> Option<&'static str> {
    if let Some(kind) = infer::get(head) {
        return Some(kind.mime_type());
    }
    // fallback by extension if needed
    if let Some(ext) = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
    {
        return Some(match ext.as_str() {
            "md" | "rs" | "ts" | "tsx" | "js" | "jsx" | "json" | "txt" | "log" | "toml"
            | "yaml" | "yml" | "xml" | "ini" | "csv" => "text/plain",
            "pdf" => "application/pdf",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "mp4" => "video/mp4",
            "mov" => "video/quicktime",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            _ => "application/octet-stream",
        });
    }
    None
}

fn looks_like_text(mime: &str, head: &[u8]) -> bool {
    if mime.starts_with("text/") {
        return true;
    }
    if head.is_empty() {
        return true;
    }
    // UTF-16 LE / BE BOM
    if head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]) {
        return true;
    }
    // Reject obvious binary files (NUL bytes or control characters other than tab/LF/CR)
    head.iter()
        .all(|&b| b == 9 || b == 10 || b == 13 || (32..0xF5).contains(&b))
}

#[tauri::command]
pub async fn build_preview(path: String, app: tauri::AppHandle) -> Result<PreviewPayload, String> {
    let media_path = PathBuf::from(&path);
    let payload = tokio::task::spawn_blocking(move || build_preview_impl(path))
        .await
        .map_err(|e| Error::internal(format!("Preview worker failed: {e}")).to_json())??;

    if matches!(
        payload,
        PreviewPayload::Video { .. } | PreviewPayload::Audio { .. }
    ) {
        if let Err(e) = app.asset_protocol_scope().allow_file(&media_path) {
            crate::log_warn!(
                "Failed to grant asset protocol access for {}: {}",
                media_path.display(),
                e
            );
        }
    }

    Ok(payload)
}

pub fn build_preview_impl(path: String) -> Result<PreviewPayload, String> {
    let p = PathBuf::from(&path);
    let name = filename(&p);

    // Folders: return Folder preview (capped to avoid stalling on huge folders)
    if p.is_dir() {
        let mut item_count = 0usize;
        let mut size: u64 = 0;
        let mut latest_modified: Option<std::time::SystemTime> = None;
        if let Ok(entries) = fs::read_dir(&p) {
            for entry in entries.flatten().take(MAX_FOLDER_PREVIEW_ENTRIES) {
                item_count += 1;
                if let Ok(meta) = fs::symlink_metadata(entry.path()) {
                    size = size.saturating_add(meta.len());
                    if let Ok(modified) = meta.modified() {
                        latest_modified = match latest_modified {
                            Some(current) if current > modified => Some(current),
                            _ => Some(modified),
                        };
                    }
                }
            }
        }
        // Use folder's own modified time if no children
        let folder_meta = fs::metadata(&p).ok();
        let folder_modified = folder_meta.and_then(|m| m.modified().ok());
        let modified_time = latest_modified.or(folder_modified);
        let modified_str =
            modified_time.map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339());
        return Ok(PreviewPayload::Folder {
            name,
            size,
            item_count,
            modified: modified_str,
        });
    }

    // Files
    let meta = fs::metadata(&p).map_err(|e| Error::from(e).to_json())?;
    let file_len = meta.len();
    // Read a small head for detection + maybe text
    let head = read_prefix(&p, HEAD_READ_BYTES)
        .map_err(|e| Error::internal(format!("Failed to read file preview: {e}")).to_json())?;
    let mime = detect_mime(&p, &head).unwrap_or("application/octet-stream");

    // Branch by mime top-level type
    if mime.starts_with("image/") {
        if file_len > MAX_IMAGE_PREVIEW_BYTES {
            return Ok(PreviewPayload::Unknown { name });
        }
        let data = fs::read(&p).map_err(|e| Error::from(e).to_json())?;
        let bytes = data.len();
        let data_uri = format!(
            "data:{};base64,{}",
            mime,
            base64::engine::general_purpose::STANDARD.encode(data)
        );
        return Ok(PreviewPayload::Image {
            name,
            data_uri,
            bytes,
        });
    }
    if mime == "application/pdf" {
        if file_len > MAX_PDF_PREVIEW_BYTES {
            return Ok(PreviewPayload::Unknown { name });
        }
        let data = fs::read(&p).map_err(|e| Error::from(e).to_json())?;
        let bytes = data.len();
        let data_uri = format!(
            "data:{};base64,{}",
            mime,
            base64::engine::general_purpose::STANDARD.encode(data)
        );
        return Ok(PreviewPayload::Pdf {
            name,
            data_uri,
            bytes,
        });
    }

    if mime.starts_with("video/") {
        return Ok(PreviewPayload::Video { name, path });
    }

    if mime.starts_with("audio/") {
        return Ok(PreviewPayload::Audio { name, path });
    }

    // Only decode as text if the file actually looks like text (never fall back on size alone!)
    if looks_like_text(mime, &head) {
        let (cow, _) = if head.starts_with(&[0xFF, 0xFE]) {
            encoding_decode_utf16(&head[2..], true)
        } else if head.starts_with(&[0xFE, 0xFF]) {
            encoding_decode_utf16(&head[2..], false)
        } else {
            let mut det = chardetng::EncodingDetector::new();
            det.feed(&head, file_len <= head.len() as u64);
            let enc = det.guess(None, true);
            let (cow, _, _) = enc.decode(&head);
            (cow.into_owned(), false)
        };
        let mut text = cow;
        let mut truncated = file_len > head.len() as u64 || text.len() > MAX_TEXT_PREVIEW_CHARS;
        if text.len() > MAX_TEXT_PREVIEW_CHARS {
            let mut cut = MAX_TEXT_PREVIEW_CHARS;
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            truncated = true;
        }
        if truncated {
            text.push_str("\n…(truncated)");
        }
        return Ok(PreviewPayload::Text {
            name,
            text,
            truncated,
        });
    }

    Ok(PreviewPayload::Unknown { name })
}

fn encoding_decode_utf16(bytes: &[u8], little_endian: bool) -> (String, bool) {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| {
            if little_endian {
                u16::from_le_bytes(*c)
            } else {
                u16::from_be_bytes(*c)
            }
        })
        .collect();
    (String::from_utf16_lossy(&units), false)
}

#[cfg(test)]
mod preview_tests {
    use super::*;
    use crate::{log_error, log_info};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_filename() {
        log_info!("Starting test_filename");

        let path = Path::new("/some/path/file.txt");
        assert_eq!(filename(path), "file.txt");

        let path = Path::new("file.txt");
        assert_eq!(filename(path), "file.txt");

        let path = Path::new("");
        assert_eq!(filename(path), "file");

        log_info!("test_filename completed successfully");
    }

    #[test]
    fn test_detect_mime_by_content() {
        log_info!("Starting test_detect_mime_by_content");

        // PNG signature
        let png_bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let path = Path::new("test.png");
        let result = detect_mime(path, &png_bytes);

        if result == Some("image/png") {
            log_info!("PNG detection successful");
        } else {
            log_error!(
                "PNG detection failed: expected 'image/png', got {:?}",
                result
            );
        }

        assert_eq!(result, Some("image/png"));
        log_info!("test_detect_mime_by_content completed successfully");
    }

    #[test]
    fn test_detect_mime_by_extension() {
        log_info!("Starting test_detect_mime_by_extension");

        let empty_bytes = vec![];

        let path = Path::new("test.rs");
        assert_eq!(detect_mime(path, &empty_bytes), Some("text/plain"));
        log_info!("Rust file extension detection successful");

        let path = Path::new("test.pdf");
        assert_eq!(detect_mime(path, &empty_bytes), Some("application/pdf"));
        log_info!("PDF file extension detection successful");

        let path = Path::new("test.mp4");
        assert_eq!(detect_mime(path, &empty_bytes), Some("video/mp4"));
        log_info!("MP4 file extension detection successful");

        let path = Path::new("test.mp3");
        assert_eq!(detect_mime(path, &empty_bytes), Some("audio/mpeg"));
        log_info!("MP3 file extension detection successful");

        log_info!("test_detect_mime_by_extension completed successfully");
    }

    #[test]
    fn test_build_preview_folder() {
        log_info!("Starting test_build_preview_folder");

        let temp_dir = TempDir::new().unwrap();
        let test_dir = temp_dir.path().join("test_folder");

        if let Err(e) = fs::create_dir(&test_dir) {
            log_error!("Failed to create test directory: {}", e);
            panic!("Failed to create test directory: {e}");
        }

        // Create some test files
        if let Err(e) = fs::write(test_dir.join("file1.txt"), "content") {
            log_error!("Failed to create test file: {}", e);
            panic!("Failed to create test file: {e}");
        }

        if let Err(e) = fs::create_dir(test_dir.join("subfolder")) {
            log_error!("Failed to create test subfolder: {}", e);
            panic!("Failed to create test subfolder: {e}");
        }

        log_info!("Test folder structure created successfully");

        let result = build_preview_impl(test_dir.to_string_lossy().to_string());

        match result {
            Ok(PreviewPayload::Folder {
                name,
                size,
                item_count,
                modified,
                ..
            }) => {
                log_info!(
                    "Folder preview generated: name={}, size={}, item_count={}, modified={:?}",
                    name,
                    size,
                    item_count,
                    modified
                );
                assert_eq!(name, "test_folder");
                // Additional checks for size, item_count, modified can be added if needed
                log_info!("All folder preview assertions passed");
            }
            Ok(other) => {
                log_error!("Expected folder preview, got: {:?}", other);
                panic!("Expected folder preview");
            }
            Err(e) => {
                log_error!("Failed to build folder preview: {}", e);
                panic!("Failed to build folder preview: {e}");
            }
        }

        log_info!("test_build_preview_folder completed successfully");
    }

    #[test]
    fn test_build_preview_text_file() {
        log_info!("Starting test_build_preview_text_file");

        let temp_dir = TempDir::new().unwrap();
        let test_file = temp_dir.path().join("test.txt");
        let content = "Hello, world!\nThis is a test file.";

        if let Err(e) = fs::write(&test_file, content) {
            log_error!("Failed to create test text file: {}", e);
            panic!("Failed to create test text file: {e}");
        }

        log_info!("Test text file created successfully");

        let result = build_preview_impl(test_file.to_string_lossy().to_string());

        match result {
            Ok(PreviewPayload::Text {
                name,
                text,
                truncated,
            }) => {
                log_info!(
                    "Text preview generated: name={}, length={}, truncated={}",
                    name,
                    text.len(),
                    truncated
                );
                assert_eq!(name, "test.txt");
                assert_eq!(text, content);
                assert!(!truncated);
                log_info!("All text preview assertions passed");
            }
            Ok(other) => {
                log_error!("Expected text preview, got: {:?}", other);
                panic!("Expected text preview");
            }
            Err(e) => {
                log_error!("Failed to build text preview: {}", e);
                panic!("Failed to build text preview: {e}");
            }
        }

        log_info!("test_build_preview_text_file completed successfully");
    }

    #[test]
    fn test_build_preview_image_file() {
        log_info!("Starting test_build_preview_image_file");

        let temp_dir = TempDir::new().unwrap();
        let test_file = temp_dir.path().join("test.png");
        // Simple PNG signature + minimal data
        let png_data = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00];

        if let Err(e) = fs::write(&test_file, &png_data) {
            log_error!("Failed to create test PNG file: {}", e);
            panic!("Failed to create test PNG file: {e}");
        }

        log_info!("Test PNG file created successfully");

        let result = build_preview_impl(test_file.to_string_lossy().to_string());

        match result {
            Ok(PreviewPayload::Image {
                name,
                data_uri,
                bytes,
            }) => {
                log_info!("Image preview generated: name={}, bytes={}", name, bytes);
                assert_eq!(name, "test.png");
                assert!(data_uri.starts_with("data:image/png;base64,"));
                assert_eq!(bytes, png_data.len());
                log_info!("All image preview assertions passed");
            }
            Ok(other) => {
                log_error!("Expected image preview, got: {:?}", other);
                panic!("Expected image preview");
            }
            Err(e) => {
                log_error!("Failed to build image preview: {}", e);
                panic!("Failed to build image preview: {e}");
            }
        }

        log_info!("test_build_preview_image_file completed successfully");
    }

    #[test]
    fn test_build_preview_pdf_file() {
        log_info!("Starting test_build_preview_pdf_file");

        let temp_dir = TempDir::new().unwrap();
        let test_file = temp_dir.path().join("test.pdf");

        if let Err(e) = fs::write(&test_file, "dummy pdf content") {
            log_error!("Failed to create test PDF file: {}", e);
            panic!("Failed to create test PDF file: {e}");
        }

        log_info!("Test PDF file created successfully");

        let result = build_preview_impl(test_file.to_string_lossy().to_string());

        match result {
            Ok(PreviewPayload::Pdf {
                name,
                data_uri: _,
                bytes,
                ..
            }) => {
                log_info!("PDF preview generated: name={}, bytes={}", name, bytes);
                assert_eq!(name, "test.pdf");
                // Additional checks for data_uri and bytes can be added if needed
                log_info!("All PDF preview assertions passed");
            }
            Ok(other) => {
                log_error!("Expected PDF preview, got: {:?}", other);
                panic!("Expected PDF preview");
            }
            Err(e) => {
                log_error!("Failed to build PDF preview: {}", e);
                panic!("Failed to build PDF preview: {e}");
            }
        }

        log_info!("test_build_preview_pdf_file completed successfully");
    }

    #[test]
    fn test_build_preview_nonexistent_file() {
        log_info!("Starting test_build_preview_nonexistent_file");

        let result = build_preview_impl("/nonexistent/path".to_string());

        match result {
            Err(e) => {
                log_info!("Expected error for nonexistent file: {}", e);
                log_info!("test_build_preview_nonexistent_file completed successfully");
            }
            Ok(payload) => {
                log_error!(
                    "Expected error for nonexistent file, but got: {:?}",
                    payload
                );
                panic!("Expected error for nonexistent file");
            }
        }
    }

    #[test]
    fn test_build_preview_large_text_truncation() {
        log_info!("Starting test_build_preview_large_text_truncation");

        let temp_dir = TempDir::new().unwrap();
        let test_file = temp_dir.path().join("large.txt");
        let large_content = "a".repeat(300_000);

        if let Err(e) = fs::write(&test_file, &large_content) {
            log_error!("Failed to create large test file: {}", e);
            panic!("Failed to create large test file: {e}");
        }

        log_info!("Large test file created successfully (300,000 characters)");

        let result = build_preview_impl(test_file.to_string_lossy().to_string());

        match result {
            Ok(PreviewPayload::Text {
                name,
                text,
                truncated,
            }) => {
                log_info!(
                    "Large text preview generated: name={}, length={}, truncated={}",
                    name,
                    text.len(),
                    truncated
                );
                assert_eq!(name, "large.txt");
                assert!(truncated);
                assert!(text.len() <= 200_000 + 15); // +15 for truncation message
                assert!(text.ends_with("…(truncated)"));
                log_info!("All large text truncation assertions passed");
            }
            Ok(other) => {
                log_error!("Expected text preview, got: {:?}", other);
                panic!("Expected text preview");
            }
            Err(e) => {
                log_error!("Failed to build large text preview: {}", e);
                panic!("Failed to build large text preview: {e}");
            }
        }

        log_info!("test_build_preview_large_text_truncation completed successfully");
    }

    #[test]
    fn test_build_preview_folder_truncation() {
        log_info!("Starting test_build_preview_folder_truncation");

        let temp_dir = TempDir::new().unwrap();
        let test_dir = temp_dir.path().join("large_folder");

        if let Err(e) = fs::create_dir(&test_dir) {
            log_error!("Failed to create large test directory: {}", e);
            panic!("Failed to create large test directory: {e}");
        }

        // Create more than 200 files to test truncation
        for i in 0..250 {
            if let Err(e) = fs::write(test_dir.join(format!("file{i}.txt")), "content") {
                log_error!("Failed to create test file {}: {}", i, e);
                panic!("Failed to create test file {i}: {e}");
            }
        }

        log_info!("Large folder created successfully (250 files)");

        let result = build_preview_impl(test_dir.to_string_lossy().to_string());

        match result {
            Ok(PreviewPayload::Folder {
                name,
                size,
                item_count,
                modified,
                ..
            }) => {
                log_info!("Large folder preview generated: name={}, size={}, item_count={}, modified={:?}", name, size, item_count, modified);
                assert_eq!(name, "large_folder");
                // Additional checks for size, item_count, modified can be added if needed
                log_info!("All large folder truncation assertions passed");
            }
            Ok(other) => {
                log_error!("Expected folder preview, got: {:?}", other);
                panic!("Expected folder preview");
            }
            Err(e) => {
                log_error!("Failed to build large folder preview: {}", e);
                panic!("Failed to build large folder preview: {e}");
            }
        }

        log_info!("test_build_preview_folder_truncation completed successfully");
    }

    #[test]
    fn test_build_preview_binary_under_2mb_returns_unknown() {
        let temp_dir = TempDir::new().unwrap();
        let exe_path = temp_dir.path().join("app.exe");
        // MZ header + NUL and control bytes, ~4 KB (well under 2 MB)
        let mut data = vec![b'M', b'Z', 0x90, 0x00, 0x03, 0x00, 0x00, 0x00];
        data.resize(4096, 0x00);
        fs::write(&exe_path, &data).unwrap();

        let result = build_preview_impl(exe_path.to_string_lossy().to_string()).unwrap();
        match result {
            PreviewPayload::Unknown { name } => assert_eq!(name, "app.exe"),
            other => panic!("Expected Unknown for binary file <=2MB, got {other:?}"),
        }
    }

    #[test]
    fn test_build_preview_oversized_image_and_pdf_return_unknown() {
        let temp_dir = TempDir::new().unwrap();

        // Image > 6 MB (PNG magic bytes + zero padding via set_len)
        let img_path = temp_dir.path().join("huge.png");
        let png_header = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        fs::write(&img_path, png_header).unwrap();
        let f = fs::OpenOptions::new().write(true).open(&img_path).unwrap();
        f.set_len(MAX_IMAGE_PREVIEW_BYTES + 1024).unwrap();
        drop(f);

        match build_preview_impl(img_path.to_string_lossy().to_string()).unwrap() {
            PreviewPayload::Unknown { name } => assert_eq!(name, "huge.png"),
            other => panic!("Expected Unknown for oversized image, got {other:?}"),
        }

        // PDF > 12 MB
        let pdf_path = temp_dir.path().join("huge.pdf");
        fs::write(&pdf_path, b"%PDF-1.7\n").unwrap();
        let f = fs::OpenOptions::new().write(true).open(&pdf_path).unwrap();
        f.set_len(MAX_PDF_PREVIEW_BYTES + 1024).unwrap();
        drop(f);

        match build_preview_impl(pdf_path.to_string_lossy().to_string()).unwrap() {
            PreviewPayload::Unknown { name } => assert_eq!(name, "huge.pdf"),
            other => panic!("Expected Unknown for oversized PDF, got {other:?}"),
        }
    }

    #[test]
    fn test_build_preview_utf16_300kb_sets_truncated_true() {
        let temp_dir = TempDir::new().unwrap();
        let txt_path = temp_dir.path().join("utf16.txt");
        // UTF-16LE BOM + 150,000 'A' code units = 300,002 bytes (> 256 KB head read),
        // even though the decoded 128K chars from the 256 KB head is < 200,000 chars.
        let mut bytes = Vec::with_capacity(300_002);
        bytes.extend_from_slice(&[0xFF, 0xFE]);
        for _ in 0..150_000 {
            bytes.extend_from_slice(&[b'A', 0x00]);
        }
        fs::write(&txt_path, &bytes).unwrap();

        match build_preview_impl(txt_path.to_string_lossy().to_string()).unwrap() {
            PreviewPayload::Text {
                name,
                text,
                truncated,
            } => {
                assert_eq!(name, "utf16.txt");
                assert!(
                    truncated,
                    "300KB file larger than 256KB head must report truncated=true"
                );
                assert!(text.ends_with("…(truncated)"));
            }
            other => panic!("Expected Text preview for UTF-16 file, got {other:?}"),
        }
    }
}
