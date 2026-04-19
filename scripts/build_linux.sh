#!/usr/bin/env bash
# Dataset Generator — Linux build script (Faza 7)
#
# Usage (from repo root):
#   ./scripts/build_linux.sh
#
# NOTE: pywebview on Linux needs GTK bindings. On Ubuntu/Debian:
#   sudo apt-get install python3-gi gir1.2-webkit2-4.0 python3-venv nodejs npm
# Then inside the venv (the script does this automatically):
#   pip install 'pywebview[gtk]'
#
# Produces: DatasetGenerator-linux-x64.tar.gz in the repo root.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo ""
echo "=== Dataset Generator — Linux build ==="
echo ""

# --- 1/6 Frontend static export ---
echo "[1/6] Building frontend (npm run build)..."
pushd frontend > /dev/null
if [ ! -d node_modules ]; then
    npm ci
fi
npm run build
popd > /dev/null
[ -d frontend/out ] || { echo "ERROR: frontend/out was not produced" >&2; exit 1; }

# --- 2/6 Python venv ---
echo "[2/6] Preparing Python venv..."
if [ ! -d backend/venv ]; then
    python3 -m venv backend/venv
fi
backend/venv/bin/pip install --upgrade pip --quiet
backend/venv/bin/pip install -r backend/requirements.txt --quiet

# pywebview GTK extras — only needed for the GUI window, harmless to include
# if the system GTK libs are present; will fail here if they are not.
if ! backend/venv/bin/python -c "import webview.platforms.gtk" 2>/dev/null; then
    echo "    Installing pywebview[gtk] extras..."
    backend/venv/bin/pip install 'pywebview[gtk]' --quiet || \
        echo "    WARN: pywebview[gtk] install failed — binary will still build but window may not open. Install gir1.2-webkit2-4.0 on the target machine."
fi

# --- 3/6 Icon (Linux uses PNG directly, no conversion needed) ---
echo "[3/6] Icon: using docs/assets/logo.png as-is."

# --- 4/6 Clean previous builds ---
echo "[4/6] Cleaning previous build artefacts..."
rm -rf dist build

# --- 5/6 PyInstaller ---
echo "[5/6] Running PyInstaller (this takes a few minutes)..."
backend/venv/bin/pyinstaller dataset_generator.spec --noconfirm
[ -f dist/DatasetGenerator/DatasetGenerator ] || {
    echo "ERROR: expected dist/DatasetGenerator/DatasetGenerator was not produced" >&2
    exit 1
}

# --- 6/6 Package as tar.gz ---
echo "[6/6] Compressing to tar.gz..."
TAR_NAME="DatasetGenerator-linux-x64.tar.gz"
rm -f "$TAR_NAME"
tar -czf "$TAR_NAME" -C dist DatasetGenerator

SIZE_MB=$(du -m "$TAR_NAME" | cut -f1)
echo ""
echo "=== DONE ==="
echo "Output: $TAR_NAME (${SIZE_MB} MB)"
echo ""
echo "To test:"
echo "  1. Extract: tar -xzf $TAR_NAME"
echo "  2. Run: ./DatasetGenerator/DatasetGenerator"
echo ""
