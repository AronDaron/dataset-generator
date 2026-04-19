#!/usr/bin/env bash
# Dataset Generator — AppImage builder (Faza 7.1)
#
# Prerequisites:
#   1. build_linux.sh already run (dist/DatasetGenerator/ must exist)
#   2. appimagetool in PATH or $APPIMAGETOOL set
#
# On a fresh system:
#   curl -sL -o ~/.local/bin/appimagetool \
#     https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
#   chmod +x ~/.local/bin/appimagetool
#
# Usage: ./scripts/build_appimage.sh
# Produces: DatasetGenerator-x86_64.AppImage in repo root.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d dist/DatasetGenerator ]; then
    echo "ERROR: dist/DatasetGenerator/ missing. Run ./scripts/build_linux.sh first." >&2
    exit 1
fi

APPIMAGETOOL="${APPIMAGETOOL:-appimagetool}"
if ! command -v "$APPIMAGETOOL" >/dev/null 2>&1; then
    # Try common locations
    for candidate in /tmp/appimagetool ~/.local/bin/appimagetool ./appimagetool; do
        if [ -x "$candidate" ]; then
            APPIMAGETOOL="$candidate"
            break
        fi
    done
fi
if ! command -v "$APPIMAGETOOL" >/dev/null 2>&1 && [ ! -x "$APPIMAGETOOL" ]; then
    echo "ERROR: appimagetool not found. See comment at top of this script." >&2
    exit 1
fi

# Detect FUSE (required for appimagetool to self-mount unless --appimage-extract-and-run).
APPIMAGETOOL_FLAGS=""
if ! ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
    APPIMAGETOOL_FLAGS="--appimage-extract-and-run"
fi

echo "[1/4] Preparing AppDir..."
rm -rf AppDir
mkdir -p AppDir/usr/bin AppDir/usr/share/applications AppDir/usr/share/icons/hicolor/256x256/apps
cp -a dist/DatasetGenerator/. AppDir/usr/bin/

echo "[2/4] Generating 256x256 icon..."
# backend/venv is produced by build_linux.sh
backend/venv/bin/python - <<'PY'
from PIL import Image
src = Image.open('docs/assets/logo.png').convert('RGBA')
src.thumbnail((256, 256), Image.LANCZOS)
canvas = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
canvas.paste(src, ((256 - src.width) // 2, (256 - src.height) // 2), src)
canvas.save('AppDir/DatasetGenerator.png')
canvas.save('AppDir/usr/share/icons/hicolor/256x256/apps/DatasetGenerator.png')
PY

echo "[3/4] Writing AppRun + .desktop..."
cat > AppDir/AppRun <<'EOF'
#!/bin/sh
APPDIR="$(dirname "$(readlink -f "$0")")"
cd "$APPDIR/usr/bin" || exit 1
exec ./DatasetGenerator "$@"
EOF
chmod +x AppDir/AppRun

cat > AppDir/DatasetGenerator.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Dataset Generator
Comment=No-code synthetic dataset generator for LLM fine-tuning
Exec=DatasetGenerator
Icon=DatasetGenerator
Terminal=false
Categories=Development;Utility;
EOF
cp AppDir/DatasetGenerator.desktop AppDir/usr/share/applications/

echo "[4/4] Building AppImage..."
rm -f DatasetGenerator-x86_64.AppImage
ARCH=x86_64 "$APPIMAGETOOL" $APPIMAGETOOL_FLAGS --no-appstream AppDir DatasetGenerator-x86_64.AppImage

SIZE_MB=$(du -m DatasetGenerator-x86_64.AppImage | cut -f1)
echo ""
echo "=== DONE ==="
echo "Output: DatasetGenerator-x86_64.AppImage (${SIZE_MB} MB)"
echo ""
echo "To test: chmod +x DatasetGenerator-x86_64.AppImage && ./DatasetGenerator-x86_64.AppImage"
