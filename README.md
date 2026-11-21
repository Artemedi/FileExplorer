<div align="center">

# 🚀 Fast File Explorer

<img src="./src-tauri/assets/images/original.png" alt="Rust Logo" width="100"/>
  
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

**A fast file explorer built with Rust and Tauri**

<img src="assets/screenshot_ThisPC.png" alt="Fast Search Feature" width="1000px"/>

</div>

## ✨ Features

- **🚀 Blazing Fast Search**: Multiple search algorithms with ~15ms response time vs 3min 45sec for Windows Explorer
- **🔍 Advanced Search Engine**: 
  - Fast fuzzy search with ART (Adaptive Radix Tree) implementation
  - LRU caching for optimal performance
  - Multiple search algorithms for different use cases
- **📁 Comprehensive File Operations**: Copy, move, delete, rename with interactive conflict resolution (Replace / Insert Duplicate / Rename Original / Skip) and robust error handling
- **⚖️ Dual-Pane & Directory Compare**: Side-by-side browsing with case-insensitive diffing (`size` + `last_modified`), `Diff Only` filter, and `F5`/`Shift+F6` transfers
- **🌐 SFTP, SSH & SMB/UNC Network Shares**:
  - Full SFTP support with `Password`, `SSH Key`, `Key + Certificate`, `SSH Agent`, and `Guest` authentication stored securely in OS `keyring`
  - Per-operation `sudo` elevation and adaptive `zstd` / `zlib` transfer compression
  - Native Windows SMB / UNC network share mounting (`\\server\share`) with live TCP latency/reachability monitoring and `0-9 · A-Z · А-Я` grouping
- **💻 Multi-Tab Embedded Terminal (`xterm.js` + WebGL)**: Per-context tabs (`Local` / `SSH`), auto-launched interactive SSH PTY (`mc`, `btop`, `htop`, `sudo`), fullscreen mode, directory sync with the explorer, and one-click `Ext SSH` native terminal launch
- **💾 Disk & Partition Manager**: Physical disk/partition layout inspection (`GPT`/`MBR`), formatting (`NTFS`, `exFAT`, `FAT32`, `ReFS`, `ext4`, `xfs`, `btrfs`, `f2fs`, `swap`), partition create/resize/delete, raw `.img` / Zstd `.img.zst` imaging (local, UNC, SFTP), and cloning with system-disk safety guards
- **🔐 Advanced Permissions**: File and directory permission management
- **📊 File Metadata**: Comprehensive metadata viewing and management
- **🔨 File Hashing**: MD5, SHA2, and CRC32 hash generation for file integrity
- **📄 File Templates**: Template system for creating new files
- **👁️ File Preview**: Built-in preview system for various file types (spotlight-like)
- **💾 Volume Operations**: Drive management, safe eject, and volume operations

See [CHANGELOG.md](CHANGELOG.md) for the full list of changes and fixes in `v0.2.16`.
- **⚙️ Customizable Settings**: Extensive configuration options
- **🎨 Modern UI**: React-based interface with context menus and responsive design
- **⚡ Real-Time File Watching**: Automatic live directory updates powered by the Rust `notify` engine
- **🛡️ Modernized Rust Core**: Memory-safe zero-unsafe ASCII mapping, `std::sync::{LazyLock, OnceLock}`, and `thiserror` structured error handling

## 🔍 Current Status

Cross platform compatibility is supported across Linux distros, macOS, and Windows. Automated CI/CD tests all pull requests and builds release installers for Windows (`.msi`, `.exe`), macOS (`.dmg`), and Linux (`.deb`, `.rpm`, `.AppImage`).

## 🏗️ Architecture

This is a Tauri v2 application with a **Rust backend** and **React + TypeScript frontend**:

### Backend (Rust)
- **Search Engine**: Multiple algorithms (Fast Fuzzy + ART Adaptive Radix Tree) with LRU caching
- **File System Operations**: Local file operations with real-time `notify` directory watcher
- **SFTP Integration**: Remote file system operations, background uploads/downloads
- **Command System**: Modular command handlers for different operations
- **Error Handling**: Centralized error management with `thiserror = "2"` and standardized error codes

### Frontend (React + TypeScript)
- **TypeScript Integration**: Strong contract types mirroring backend Rust structs
- **Provider Pattern**: Hierarchical context providers for state management
- **Real-Time Synchronization**: Live Tauri event listeners with debounced auto-reload
- **Modern UI**: Component-based architecture with custom hooks and dark mode support

## 🛠️ Installation

### Download Prebuilt Binaries

Pre-compiled, signed packages are available for download from the [Releases page](https://github.com/Artemedi/FileExplorer/releases):
- **Windows**: `.msi` (Windows Installer) and `.exe` (NSIS setup)
- **macOS**: `.dmg` disk image
- **Linux**: `.deb`, `.rpm`, and `.AppImage`

---

## Installation from source

### Prerequisites for installing from source

- [NodeJS](https://nodejs.org/) (stable version)
- [Rust](https://www.rust-lang.org/) (stable version)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites/) (version >2.4.0)
- [Cargo](https://doc.rust-lang.org/cargo/getting-started/installation.html) (comes with Rust)
- [Vite](https://vitejs.dev/guide/#scaffolding-your-first-vite-project) (comes with Tauri CLI)

Other required dependencies are installed automatically by the Tauri CLI. If they are not please
contact us.

### Install with compiling from source

Note that on macOS you need XCode installed with the build tools.

```bash
# Install Tauri CLI
cargo install tauri-cli # The version should be >2.4.0 if not already installed

# Build for production
cargo tauri build
```

Go into the build directory and run the created binary. The binary is located in
`FileExplorer/src-tauri/target/release/bundle/`. The name of the binary is `file-explorer` or

### 🐧 Linux

Under Linux the given command generates an `.deb`, `.rpm`, `AppImage` in the
`FileExplorer/src-tauri/target/release/bundle` folder. Select the one which fits your distribution.
Either run the AppImage, Binary or install the `.deb` or `.rpm` package.

#### For the `AppImage`

```bash
#Make sure the image is runnable
chmod +x yourapp-x.y.z.AppImage
#Run the image. After that it should behaving like a native application
./yourapp-x.y.z.AppImage
```

Recommended is to use the binary created in `FileExplorer/src-tauri/target/release/src-tauri`. Give
it executable permissions and then run it from the terminal. You can also put it into your user
binaries folder, e.g. `~/bin`, and add it to your PATH variable.

### 🍎 macOS

```bash
# Install Tauri CLI
cargo install tauri-cli # The version should be >2.4.0 if not already installed

# Build for production
cargo tauri build
```

Tauri creates an `.dmg` or `.app` bundle under the folder
`FileExplorer/src-tauri/target/release/bundle/macos/`. Recommended is to use the binary created in
`FileExplorer/src-tauri/target/release/src-tauri`. Give it executable permissions and then run it
from the terminal. You can also put it into your user binaries folder, e.g. `~/bin`, and add it to
your PATH variable.

### 🪟 Windows

This generates an installer for your system, which lays in
`FileExplorer/src-tauri/target/release/bundle/msi/`. There should be an `.exe` or `.msi` which is
called `file-explorer`. To install it you need to double click the file and install like any other
application. Then you can completely remove the `FileExplorer` folder.

### Development Setup

```bash
# Install Tauri CLI
cargo install tauri-cli # The version should be >2.4.0

# Build for production
cargo tauri build

# Run the development server
cargo tauri dev
```

### Testing and Development Commands

The project uses feature flags for different configurations:

```bash
# Run all tests including long-running ones
cargo test --features full

# Run with benchmark features
cargo test --features benchmarks

# Enable all logging during tests
cargo test --features log-all
```

Available feature combinations:
- `full` - All features including long tests, benchmarks, and file opening
- `log-search` - Enable search progress and error logging
- `log-index` - Enable indexing progress and error logging

## 📸 Images

<div align="center">
<img src="assets/screenshot_details.png" width="700px"/>

<img src="assets/screenshot_overview.png" width="700px"/>

<img src="assets/screenshot_terminal.png" width="700px"/>

<img src="assets/screenshot_settings.png" width="700px"/>
</div>

## 📄 History

The Explorer was started as a project from the youtuber
[Connaticus](https://www.youtube.com/@conaticus). He documented parts of his development journey
online in two Videos:
[I Made a FAST File Explorer](https://youtu.be/Z60f2g-COJY?si=PHWogkV1R_wD8dza) and
[How I RUINED My Rust Project](https://youtu.be/4wdAZQROc4A?si=9ksfN2TcxdDI41BD).

Lots of changes were made in the course of the InformatiCup from the year 2025. It is a competition
in Germany. The given task was to contribute to existing open source projects. The team members were
[Marco Brandt](https://github.com/CodeMarco05), [Daniel Schatz](https://github.com/xd1i0),
[Lauritz Wiebusch](https://github.com/wielauritz), [Sören Panten](https://github.com/SPKonig). The
repo can be found under [FileExplorer](https://github.com/CodeMarco05/FileExplorer).

## ⚡ Performance

This file explorer emphasizes extreme performance with benchmarks showing significant improvements
over native solutions (tested on 170,000 paths):

| Operation   | Fast File Explorer | Windows Explorer |
| ----------- |:------------------:| :--------------: |
| File search |       ~15ms        |   3min 45sec     |

### Technical Implementation
- **Multiple Search Algorithms**: Fast fuzzy search, ART (Adaptive Radix Tree)
- **LRU Caching**: Intelligent caching for search results
- **Rust Backend**: Memory-safe, zero-cost abstractions
- **Modular Architecture**: Command-based system with feature flags

## ⚙️ Configuration

The application uses several configuration files:

- `src-tauri/config/settings.json` - Application settings
- `src-tauri/config/meta_data.json` - Metadata configuration  
- `src-tauri/tauri.conf.json` - Tauri application configuration
- `package.json` - Frontend dependencies and scripts

## 🤝 Contributing

Contributions are welcome! Before contributing, please read our
[contributing guidelines](CONTRIBUTING.md).

## 📝 License

This project is licensed under the GNU General Public License v3.0 – see the LICENSE file for
details.

## 📬 Contact

Have questions or feedback? Open an issue on our GitHub repository!
