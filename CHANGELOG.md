# Changelog

## [0.2.16] - 2026-11-20

### Added
- **Disk & Partition Manager (`This PC` → `Disks & Partitions`):**
  - Physical disk and partition layout inspection (`get_physical_disks_info`) showing `GPT`/`MBR`, bus type, total/free size, health status, and `System` badges with quick navigation to mounted partitions.
  - Partition management and formatting (`create_partition`, `resize_partition` with `get_partition_supported_size` bounds, `delete_partition`, `initialize_disk` for `GPT`/`MBR`, `format_partition` with `get_supported_filesystems`):
    - **Windows:** `NTFS`, `exFAT`, `FAT32`, `ReFS` (quick or full format, volume label).
    - **Linux:** `ext4`, `ext3`, `ext2`, `xfs`, `btrfs`, `f2fs`, `vfat`, `exfat`, `ntfs`, `swap` (auto-unmount and privilege elevation via `pkexec` or `sudo -S`).
  - Disk & partition imaging and cloning (`create_disk_image`, `clone_or_restore_disk`):
    - Streaming raw (`.img`) and on-the-fly Zstandard compressed (`.img.zst`) image creation with live progress events (`disk-image-progress`), local/UNC destination support, and direct SFTP upload.
    - Disk-to-disk / partition-to-partition cloning and `.img` / `.img.zst` restore with target capacity validation.
  - Safety guards blocking destructive operations on system/boot disks and partitions, plus explicit confirmation tokens (`DISK-N`, `PART-N-M`).
- **SMB / UNC Network Shares & Live Endpoint Reachability:**
  - Dedicated **Network Shares (SMB / UNC)** section in `Network` and in the `NETWORK` sidebar for local/domain UNC paths (`\\server\share\folder`) via Win32 `WNetAddConnection2W` (`connect_network_share`) with OS `keyring` credential storage.
  - Live TCP reachability and latency indicator (`ms` / `Offline` via `check_network_endpoints`) across both `Network` cards and the `NETWORK` sidebar.
  - `0-9 · A-Z · А-Я` alphabetical grouping and sorting (`networkSort.js`) in `Network` and the sidebar, with a compact card layout.
  - UNC path hint in `Add SFTP Connection` redirecting `\\...` paths to SMB Network Shares.
- **Full SSH & SFTP Client + Embedded `xterm.js` WebGL Terminal:**
  - Authentication methods in `Add SFTP Connection`: `Password`, `SSH Private Key`, `SSH Key + Certificate` (`*-cert.pub`), `SSH Agent`, and `Guest / Anonymous`, stored securely via OS `keyring` + `ZeroizingString`.
  - Per-operation `sudo` elevation (`sudo -S -p ''` over stdin) when remote file operations hit `Permission denied`.
  - Adaptive **Transfer Compression** (`Auto`, `Always`, `Off`) using `libssh2` zlib compression and remote `zstd` probing (`ssh_probe_zstd`).
  - Multi-tab terminal (`Local`, `SSH: <name>`, `+` new tab, `×` close) automatically switching with the active explorer tab/path.
  - Embedded **`@xterm/xterm`** + **`@xterm/addon-fit`** + **`@xterm/addon-webgl`** (`XtermSshView`) with `customGlyphs: true`, auto-starting interactive SSH PTY by default for `sudo` password prompts, `mc`, `btop`, `htop`, and `vim`.
  - Fullscreen toggle (`⛶` / `Restore`) without unmounting the terminal, **Copy** button + mouse selection (`user-select: text`), automatic directory sync (`cd`, `OSC 7` / `OSC 0/2`) with the active explorer tab, and **Ext SSH** (`open_external_ssh_terminal`) to launch the native OS terminal (`wt.exe` / `ssh` / Linux terminal) with `-i <private_key_path>`.
- **Interactive Copy/Paste Conflict Resolution:**
  - `ConflictResolutionModal` for `Ctrl+C` / `Ctrl+V` and Dual-Pane `F5` when a target file or directory already exists: **Replace existing item**, **Insert renamed duplicate**, **Rename original**, or **Skip**.

### Fixed
- **Dual-Pane Directory Compare (`Compare`):** Case-insensitive name matching on local filesystems, comparison by both `size_in_bytes` and `last_modified`, automatic `Diff Only` activation when differences exist, and accurate `left only` / `right only` / `modified` / `identical` counts.
- **SSH Handshake & PTY Reliability:** Automatic retry (up to 3 attempts with `TCP_NODELAY`) for transient `error banner` / timeout errors on initial SFTP connection; UTF-8 multi-byte chunk buffering (`drain_valid_utf8`) across PTY reads; `WouldBlock` retry loop on `channel.request_pty_size`; serialized PTY keystroke writes.
- **UI & WebView Polish:** Suppressed native browser/WebView `Save As...` HTML context menu outside editable inputs; removed hover `transform` scrollbars on the terminal `+` button; cleaned up `Network` card overflow and action button alignment.
