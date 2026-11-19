#!/bin/bash

# Post-build script for macOS - automatically applies launch fix
# This script is called after the Tauri build completes

echo "🔧 Running post-build macOS fixes..."

# Resolve paths relative to repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Get the target architecture
TARGET_ARCH="${CARGO_CFG_TARGET_ARCH:-aarch64}"
TARGET_OS="${CARGO_CFG_TARGET_OS:-macos}"

if [ "$TARGET_OS" != "macos" ]; then
    echo "ℹ️  Skipping macOS fixes for non-macOS build"
    exit 0
fi

CARGO_TOML="$ROOT_DIR/src-tauri/Cargo.toml"
TAURI_CONF="$ROOT_DIR/src-tauri/tauri.conf.json"

BIN_NAME="$(tr -d '\r' < "$CARGO_TOML" | awk '/^\[package\]/{in_pkg=1; next} /^\[/{in_pkg=0} in_pkg && /^name[[:space:]]*=/{gsub(/.*=[[:space:]]*"|".*/, ""); print; exit}')"
BIN_NAME="${BIN_NAME:-explr}"

APP_NAME="$(tr -d '\r' < "$TAURI_CONF" | sed -n 's/.*"productName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
APP_NAME="${APP_NAME:-Explr}"

APP_VERSION="$(tr -d '\r' < "$TAURI_CONF" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$APP_VERSION" ]; then
    APP_VERSION="$(tr -d '\r' < "$CARGO_TOML" | awk '/^\[package\]/{in_pkg=1; next} /^\[/{in_pkg=0} in_pkg && /^version[[:space:]]*=/{gsub(/.*=[[:space:]]*"|".*/, ""); print; exit}')"
fi

if [ -z "$APP_VERSION" ]; then
    echo "❌ Failed to determine application version from $TAURI_CONF or $CARGO_TOML"
    exit 1
fi

# Tauri outputs into repo root `target/`, not `src-tauri/target/`
BUILD_DIR="$ROOT_DIR/target/${TARGET_ARCH}-apple-darwin/release/bundle"
APP_PATH="$BUILD_DIR/macos/$APP_NAME.app"

# Resolve DMG path robustly across arch naming variations (x86_64 vs x64, aarch64 vs arm64)
DMG_DIR="$BUILD_DIR/dmg"

# Preferred pattern: suffix matches TARGET_ARCH exactly
DMG_PATH=""
for pattern in \
    "$DMG_DIR/${APP_NAME}_*_${TARGET_ARCH}.dmg" \
    "$DMG_DIR/${APP_NAME}_*_x64.dmg" \
    "$DMG_DIR/${APP_NAME}_*_arm64.dmg" \
    "$DMG_DIR/${APP_NAME}_*.dmg"; do
    for f in $pattern; do
        if [ -f "$f" ]; then
            DMG_PATH="$f"
            break 2
        fi
    done
done

echo "🔍 Checking for app bundle at: $APP_PATH"

# If the app bundle doesn't exist, extract it from DMG
if [ ! -d "$APP_PATH" ]; then
    echo "📦 App bundle not found, extracting from DMG..."
    
    if [ ! -f "$DMG_PATH" ]; then
        echo "❌ Neither app bundle nor DMG found. Build may have failed."
        exit 1
    fi
    
    # Mount DMG and copy app
    echo "🔗 Mounting DMG: $DMG_PATH"
    hdiutil attach "$DMG_PATH" -readonly -mountpoint "/tmp/fileexplorer_dmg" >/dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        # Create macos directory if it doesn't exist
        mkdir -p "$BUILD_DIR/macos"
        
        # Copy app from DMG
        cp -R "/tmp/fileexplorer_dmg/$APP_NAME.app" "$BUILD_DIR/macos/" 2>/dev/null
        
        # Unmount DMG
        hdiutil detach "/tmp/fileexplorer_dmg" >/dev/null 2>&1
        
        echo "✅ App extracted from DMG successfully"
    else
        echo "❌ Failed to mount DMG"
        exit 1
    fi
fi

# Apply macOS launch fix
echo "🛠️  Applying macOS launch fix..."

if [ ! -d "$APP_PATH" ]; then
    echo "❌ App not found: $APP_PATH"
    exit 1
fi

# 1. Rename original binary
MACOS_DIR="$APP_PATH/Contents/MacOS"
PLIST="$APP_PATH/Contents/Info.plist"
BINARY_NAME="$BIN_NAME"
if [ -z "$BINARY_NAME" ] || [ ! -f "$MACOS_DIR/$BINARY_NAME" ]; then
    PLIST_EXEC="$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$PLIST" 2>/dev/null || true)"
    if [ -n "$PLIST_EXEC" ] && [ -f "$MACOS_DIR/$PLIST_EXEC" ]; then
        BINARY_NAME="$PLIST_EXEC"
    fi
fi

if [ ! -f "$MACOS_DIR/$BINARY_NAME" ] && [ ! -f "$MACOS_DIR/${BINARY_NAME}-real" ]; then
    echo "❌ Executable '$BINARY_NAME' not found in $MACOS_DIR"
    exit 1
fi

if [ -f "$MACOS_DIR/$BINARY_NAME" ] && [ ! -f "$MACOS_DIR/${BINARY_NAME}-real" ]; then
    echo "📦 Renaming original binary ($BINARY_NAME)..."
    mv "$MACOS_DIR/$BINARY_NAME" "$MACOS_DIR/${BINARY_NAME}-real"
fi

# 2. Create wrapper script
echo "🛠️  Creating launch wrapper for $BINARY_NAME..."
cat > "$MACOS_DIR/$BINARY_NAME" << EOF
#!/bin/bash

# macOS Launch Services Fix - Simulates terminal environment
export TERM="xterm-256color"
export TERM_PROGRAM="Apple_Terminal"
export SHELL="/bin/zsh"
export XPC_FLAGS="0x0"
export XPC_SERVICE_NAME="0"
export __CFBundleIdentifier="com.apple.Terminal"

# Complete PATH
export PATH="/Library/Frameworks/Python.framework/Versions/3.11/bin:/opt/local/bin:/opt/local/sbin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:/Library/Apple/usr/bin"

cd "\$(dirname "\$0")"
exec ./${BINARY_NAME}-real "\$@"
EOF

# 3. Make wrapper executable
chmod +x "$MACOS_DIR/$BINARY_NAME"

# 4. Fix Info.plist
echo "⚙️  Updating Info.plist..."

# Remove problematic keys if present
/usr/libexec/PlistBuddy -c "Delete :LSRequiresCarbon" "$PLIST" 2>/dev/null || true

# Add required keys
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool false" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSBackgroundOnly bool false" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSPrincipalClass string NSApplication" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSApplicationCategoryType string public.app-category.utilities" "$PLIST" 2>/dev/null || true

# 5. Re-sign app
echo "🔏 Re-signing app..."
codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1

# 6. Create fixed DMG
mkdir -p "$BUILD_DIR/dmg"
FIXED_DMG_PATH="$BUILD_DIR/dmg/${APP_NAME}_fixed_${APP_VERSION}_${TARGET_ARCH}.dmg"
echo "📦 Creating fixed DMG..."

# Create temporary directory for DMG contents
TEMP_DIR=$(mktemp -d)
cp -R "$APP_PATH" "$TEMP_DIR/"

# Create DMG
hdiutil create -volname "$APP_NAME" -srcfolder "$TEMP_DIR" -ov -format UDZO "$FIXED_DMG_PATH" >/dev/null 2>&1

# Clean up
rm -rf "$TEMP_DIR"

echo "✅ Post-build macOS fixes completed successfully!"
echo "📱 Fixed app: $APP_PATH"
echo "📦 Fixed DMG: $FIXED_DMG_PATH"
echo ""
echo "🚀 The app will now properly show its frontend when launched from the DMG!"
