use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SystemClipboardFiles {
    pub paths: Vec<String>,
    pub cut: bool,
}

/// Builds a Win32 `DROPFILES` clipboard payload (20-byte header with `pFiles = 20`,
/// `fWide = 1`, followed by UTF-16LE NUL-terminated paths and a trailing NUL).
pub fn build_dropfiles_buffer(paths: &[String]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(20 + paths.len() * 32 + 2);
    // DROPFILES header: pFiles (u32), pt.x (i32), pt.y (i32), fNC (i32), fWide (i32)
    buf.extend_from_slice(&20u32.to_le_bytes());
    buf.extend_from_slice(&0i32.to_le_bytes());
    buf.extend_from_slice(&0i32.to_le_bytes());
    buf.extend_from_slice(&0i32.to_le_bytes());
    buf.extend_from_slice(&1i32.to_le_bytes());

    for path in paths {
        for unit in path
            .chars()
            .filter(|&c| c != '\0')
            .collect::<String>()
            .encode_utf16()
        {
            buf.extend_from_slice(&unit.to_le_bytes());
        }
        buf.extend_from_slice(&0u16.to_le_bytes());
    }
    // Double-NUL termination
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf
}

#[cfg(windows)]
mod win_clipboard {
    use super::{build_dropfiles_buffer, SystemClipboardFiles};
    use std::ffi::c_void;
    use std::ptr;
    use std::thread;
    use std::time::Duration;

    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const DROPEFFECT_COPY: u32 = 1;
    const DROPEFFECT_MOVE: u32 = 2;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hWndNewOwner: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(uFormat: u32, hMem: *mut c_void) -> *mut c_void;
        fn GetClipboardData(uFormat: u32) -> *mut c_void;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn RegisterClipboardFormatW(lpszFormat: *const u16) -> u32;
        fn GetClipboardSequenceNumber() -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(uFlags: u32, dwBytes: usize) -> *mut c_void;
        fn GlobalFree(hMem: *mut c_void) -> *mut c_void;
        fn GlobalLock(hMem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(hMem: *mut c_void) -> i32;
        fn GlobalSize(hMem: *mut c_void) -> usize;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(hDrop: *mut c_void, iFile: u32, lpszFile: *mut u16, cch: u32) -> u32;
    }

    struct ClipboardGuard;

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    fn open_clipboard_with_retry() -> Result<ClipboardGuard, String> {
        // RDP clipboard sync (rdpclip.exe) can briefly hold the clipboard open
        for attempt in 0..10 {
            if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
                return Ok(ClipboardGuard);
            }
            if attempt < 9 {
                thread::sleep(Duration::from_millis(20));
            }
        }
        Err("Failed to open Windows clipboard".to_string())
    }

    unsafe fn alloc_global_bytes(bytes: &[u8]) -> Result<*mut c_void, String> {
        let hmem = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
        if hmem.is_null() {
            return Err("GlobalAlloc failed for clipboard payload".to_string());
        }
        let dst = GlobalLock(hmem);
        if dst.is_null() {
            GlobalFree(hmem);
            return Err("GlobalLock failed for clipboard payload".to_string());
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), dst as *mut u8, bytes.len());
        GlobalUnlock(hmem);
        Ok(hmem)
    }

    unsafe fn set_clipboard_bytes(format: u32, bytes: &[u8]) -> Result<(), String> {
        let hmem = alloc_global_bytes(bytes)?;
        if SetClipboardData(format, hmem).is_null() {
            GlobalFree(hmem);
            return Err(format!("SetClipboardData failed for format {format}"));
        }
        Ok(())
    }

    fn register_format(name: &str) -> u32 {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
    }

    pub fn set_files(paths: Vec<String>, cut: bool) -> Result<u32, String> {
        let normalized: Vec<String> = paths
            .into_iter()
            .map(|p| p.trim().replace('/', "\\"))
            .filter(|p| !p.is_empty())
            .collect();
        if normalized.is_empty() {
            return Err("No local file paths provided".to_string());
        }

        let dropfiles_buf = build_dropfiles_buffer(&normalized);
        let drop_effect_val = if cut {
            DROPEFFECT_MOVE
        } else {
            DROPEFFECT_COPY
        };
        let drop_effect_buf = drop_effect_val.to_le_bytes();
        let text_payload: Vec<u8> = normalized
            .join("\r\n")
            .encode_utf16()
            .chain(std::iter::once(0u16))
            .flat_map(|u| u.to_le_bytes())
            .collect();

        let drop_effect_fmt = register_format("Preferred DropEffect");

        {
            let _guard = open_clipboard_with_retry()?;
            if unsafe { EmptyClipboard() } == 0 {
                return Err("EmptyClipboard failed".to_string());
            }
            unsafe {
                set_clipboard_bytes(CF_HDROP, &dropfiles_buf)?;
                if drop_effect_fmt != 0 {
                    set_clipboard_bytes(drop_effect_fmt, &drop_effect_buf)?;
                }
                let _ = set_clipboard_bytes(CF_UNICODETEXT, &text_payload);
            }
        }

        Ok(unsafe { GetClipboardSequenceNumber() })
    }

    pub fn get_files() -> Result<Option<SystemClipboardFiles>, String> {
        if unsafe { IsClipboardFormatAvailable(CF_HDROP) } == 0 {
            return Ok(None);
        }

        let drop_effect_fmt = register_format("Preferred DropEffect");
        let _guard = open_clipboard_with_retry()?;

        let hdrop = unsafe { GetClipboardData(CF_HDROP) };
        if hdrop.is_null() {
            return Ok(None);
        }

        let count = unsafe { DragQueryFileW(hdrop, u32::MAX, ptr::null_mut(), 0) };
        if count == 0 {
            return Ok(None);
        }

        let mut paths = Vec::with_capacity(count as usize);
        for i in 0..count {
            let len = unsafe { DragQueryFileW(hdrop, i, ptr::null_mut(), 0) };
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; (len + 1) as usize];
            let copied = unsafe { DragQueryFileW(hdrop, i, buf.as_mut_ptr(), len + 1) };
            if copied > 0 {
                paths.push(String::from_utf16_lossy(&buf[..copied as usize]));
            }
        }

        if paths.is_empty() {
            return Ok(None);
        }

        let mut cut = false;
        if drop_effect_fmt != 0 && unsafe { IsClipboardFormatAvailable(drop_effect_fmt) } != 0 {
            let hmem = unsafe { GetClipboardData(drop_effect_fmt) };
            if !hmem.is_null() && unsafe { GlobalSize(hmem) } >= 4 {
                let ptr = unsafe { GlobalLock(hmem) };
                if !ptr.is_null() {
                    let effect = unsafe { ptr::read_unaligned(ptr as *const u32) };
                    unsafe { GlobalUnlock(hmem) };
                    cut = (effect & DROPEFFECT_MOVE) != 0 && (effect & DROPEFFECT_COPY) == 0;
                }
            }
        }

        Ok(Some(SystemClipboardFiles { paths, cut }))
    }

    pub fn sequence_number() -> Result<u32, String> {
        Ok(unsafe { GetClipboardSequenceNumber() })
    }
}

#[tauri::command]
pub fn clipboard_set_files(paths: Vec<String>, cut: bool) -> Result<u32, String> {
    #[cfg(windows)]
    {
        win_clipboard::set_files(paths, cut)
    }
    #[cfg(not(windows))]
    {
        let _ = (paths, cut);
        Err("unsupported".to_string())
    }
}

#[tauri::command]
pub fn clipboard_get_files() -> Result<Option<SystemClipboardFiles>, String> {
    #[cfg(windows)]
    {
        win_clipboard::get_files()
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn clipboard_sequence_number() -> Result<u32, String> {
    #[cfg(windows)]
    {
        win_clipboard::sequence_number()
    }
    #[cfg(not(windows))]
    {
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropfiles_buffer_has_valid_header_and_double_nul_utf16_paths() {
        let paths = vec![
            r"C:\Users\Test\file one.txt".to_string(),
            r"D:\Data\archive.zip".to_string(),
        ];
        let buf = build_dropfiles_buffer(&paths);

        // Header: 20 bytes, pFiles = 20, pt=(0,0), fNC=0, fWide=1
        assert!(buf.len() >= 24);
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 20);
        assert_eq!(i32::from_le_bytes(buf[4..8].try_into().unwrap()), 0);
        assert_eq!(i32::from_le_bytes(buf[8..12].try_into().unwrap()), 0);
        assert_eq!(i32::from_le_bytes(buf[12..16].try_into().unwrap()), 0);
        assert_eq!(i32::from_le_bytes(buf[16..20].try_into().unwrap()), 1);

        // Decode UTF-16LE payload after 20-byte header
        let u16_units: Vec<u16> = buf[20..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&c| u16::from_le_bytes(c))
            .collect();

        // Must end with two NUL code units (path terminator + list terminator)
        assert!(u16_units.ends_with(&[0, 0]));

        let decoded: Vec<String> = u16_units[..u16_units.len() - 1]
            .split(|&u| u == 0)
            .filter(|slice| !slice.is_empty())
            .map(String::from_utf16_lossy)
            .collect();
        assert_eq!(decoded, paths);
    }

    #[test]
    fn dropfiles_buffer_handles_empty_input() {
        let buf = build_dropfiles_buffer(&[]);
        assert_eq!(buf.len(), 22);
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 20);
        assert_eq!(i32::from_le_bytes(buf[16..20].try_into().unwrap()), 1);
        assert_eq!(&buf[20..22], &[0, 0]);
    }
}
