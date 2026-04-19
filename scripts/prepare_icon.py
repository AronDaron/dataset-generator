"""Convert docs/assets/logo.png to docs/assets/logo.ico for Windows builds.

PyInstaller on Windows requires a multi-resolution ICO file for the --icon flag.
Run before `pyinstaller dataset_generator.spec` on Windows. No-op elsewhere.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "assets" / "logo.png"
DEST = ROOT / "docs" / "assets" / "logo.ico"
SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: source icon not found: {SRC}", file=sys.stderr)
        return 1
    img = Image.open(SRC).convert("RGBA")
    img.save(DEST, format="ICO", sizes=SIZES)
    print(f"Wrote {DEST} ({', '.join(f'{w}x{h}' for w, h in SIZES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
