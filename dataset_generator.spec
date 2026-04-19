# PyInstaller spec — Dataset Generator (Faza 7)
# Build: `pyinstaller dataset_generator.spec --noconfirm`
# Requires: frontend/out/ already built (`cd frontend && npm run build`)
# On Windows, also requires docs/assets/logo.ico (run scripts/prepare_icon.py first).

# ruff: noqa  (PyInstaller injects Analysis/PYZ/EXE/COLLECT at runtime)

import sys
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
ROOT = Path(SPECPATH).resolve()

frontend_out = ROOT / "frontend" / "out"
if not frontend_out.exists():
    raise SystemExit(
        f"ERROR: frontend/out/ missing at {frontend_out}. "
        f"Run `cd frontend && npm run build` first."
    )

# Platform-specific icon. On Linux the .png path is accepted by most tooling;
# PyInstaller Windows needs a .ico, which scripts/prepare_icon.py generates.
if IS_WINDOWS:
    icon_path = ROOT / "docs" / "assets" / "logo.ico"
    if not icon_path.exists():
        raise SystemExit(
            f"ERROR: {icon_path} missing. "
            f"Run `python scripts/prepare_icon.py` first."
        )
else:
    icon_path = ROOT / "docs" / "assets" / "logo.png"

icon_arg = str(icon_path) if icon_path.exists() else None

hidden_imports = [
    # tiktoken needs its BPE loader module explicitly bundled — otherwise it
    # tries to download and fails in the frozen app.
    "tiktoken_ext",
    "tiktoken_ext.openai_public",
    # uvicorn loads these subpackages dynamically at server startup.
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    # aiosqlite is sometimes missed by static analysis.
    "aiosqlite",
]

# --- Linux GTK/WebKit extras ---------------------------------------------
# pywebview uses PyGObject to talk to GTK+WebKit2. PyInstaller's gi hook
# picks up Gtk-3.0 automatically but not WebKit2-4.1 (loaded lazily via
# gi.require_version('WebKit2', '4.1')). On Linux we probe the system for
# the typelib + the webkit .so files and add them explicitly. If these
# paths don't exist we skip silently — Windows build needs nothing here.
extra_binaries = []
extra_datas = []
if not IS_WINDOWS:
    _gir_dirs = [
        Path("/usr/lib/x86_64-linux-gnu/girepository-1.0"),
        Path("/usr/lib/girepository-1.0"),
    ]
    for _gir in _gir_dirs:
        for _name in ("WebKit2-4.1.typelib", "WebKit2WebExtension-4.1.typelib",
                      "WebKit2-4.0.typelib", "WebKit2WebExtension-4.0.typelib",
                      "Soup-3.0.typelib", "Soup-2.4.typelib",
                      "JavaScriptCore-4.1.typelib", "JavaScriptCore-4.0.typelib"):
            _p = _gir / _name
            if _p.exists():
                extra_datas.append((str(_p), "gi_typelibs"))

    _lib_dirs = [
        Path("/usr/lib/x86_64-linux-gnu"),
        Path("/usr/lib"),
    ]
    _lib_globs = [
        "libwebkit2gtk-4.1.so*",
        "libwebkit2gtk-4.0.so*",
        "libjavascriptcoregtk-4.1.so*",
        "libjavascriptcoregtk-4.0.so*",
        "libsoup-3.0.so*",
        "libsoup-2.4.so*",
    ]
    for _ld in _lib_dirs:
        if not _ld.exists():
            continue
        for _glob in _lib_globs:
            for _lib in _ld.glob(_glob):
                if _lib.is_file() and not _lib.is_symlink():
                    extra_binaries.append((str(_lib), "."))

    # WebKit2 runtime needs the injected-bundle helper in a specific subpath.
    for _base in _lib_dirs:
        for _ver in ("webkit2gtk-4.1", "webkit2gtk-4.0"):
            _ib = _base / _ver / "injected-bundle" / "libwebkit2gtkinjectedbundle.so"
            if _ib.exists():
                extra_binaries.append((str(_ib), f"{_ver}/injected-bundle"))
                hidden_imports.append("gi.repository.WebKit2")

excludes = [
    # Large libs we don't use; keep the bundle slim.
    "tkinter",
    "matplotlib",
    "scipy",
    "pandas",
    "PIL.ImageQt",
    "PyQt5",
    "PyQt6",
    "PySide2",
    "PySide6",
    "pytest",
]

a = Analysis(
    [str(ROOT / "desktop.py")],
    pathex=[str(ROOT / "backend")],
    binaries=extra_binaries,
    datas=[
        # Target path "out" matches get_frontend_dir() which returns
        # Path(sys._MEIPASS) / "out" in frozen builds.
        (str(frontend_out), "out"),
    ] + extra_datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)

# --- Filter out host system libs that cause ABI mismatches on target ------
# When the build host and target have different glibc/libstdc++ versions
# (e.g. Ubuntu 22.04 build → 24.04 target), bundled copies of these libs
# shadow the target's newer system libs and fail with CXXABI/GLIBCXX errors.
# Rule: let the dynamic linker resolve these from the target system.
if not IS_WINDOWS:
    # Skip any file whose basename starts with these prefixes (covers
    # libstdc++.so.6, libstdc++.so.6.0.30, libc.so.6, etc.).
    _skip_prefixes = (
        "libstdc++.so",
        "libgcc_s.so",
        "libc.so.",
        "libm.so.",
        "libpthread.so.",
        "libdl.so.",
        "librt.so.",
        "libresolv.so.",
        "libutil.so.",
    )
    def _is_host_lib(path: str) -> bool:
        base = Path(path).name
        return any(base.startswith(p) for p in _skip_prefixes)

    a.binaries = [entry for entry in a.binaries if not _is_host_lib(entry[0])]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="DatasetGenerator",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=icon_arg,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="DatasetGenerator",
)
