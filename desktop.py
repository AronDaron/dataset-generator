"""Desktop launcher: uvicorn in a daemon thread + a pywebview window.

Usage: `python desktop.py`.

Dev flow is unchanged (`npm run dev` + `uvicorn app.main:app`); this script is
for running the packaged-style desktop experience locally.
"""

from __future__ import annotations

import logging
import os
import socket
import sys
import threading
import time
from pathlib import Path

# Must be set BEFORE importing app.main — it's read at middleware registration time.
os.environ.setdefault("DATASET_GEN_DESKTOP", "1")

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))

# Route tiktoken's BPE cache into the user's data dir (writable) instead of
# defaulting into sys._MEIPASS (read-only in frozen builds).
from app.config import get_app_data_dir  # noqa: E402

os.environ.setdefault(
    "TIKTOKEN_CACHE_DIR", str(get_app_data_dir() / "tiktoken_cache")
)

import httpx  # noqa: E402
import uvicorn  # noqa: E402

from app.main import app  # noqa: E402  (after env + sys.path setup)


def find_free_port(start: int = 17842) -> int:
    """Return the first free TCP port at/above `start`."""
    for port in range(start, start + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port available in range {start}-{start + 99}")


def wait_for_ready(port: int, timeout: float = 10.0) -> bool:
    """Poll /api/health until 200 OK. Returns False on timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=0.5)
            if r.status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    return False


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    port = find_free_port()

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )
    server = uvicorn.Server(config)
    # Signals can only be installed in the main thread; we run in a daemon thread.
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]

    thread = threading.Thread(target=server.run, daemon=True, name="uvicorn")
    thread.start()

    if not wait_for_ready(port):
        raise RuntimeError(f"Backend did not become healthy within 10s on :{port}")

    # Headless mode for CI / sanity-check on machines without a GUI stack.
    # Deliberately NOT imported webview here — on headless Linux (no GTK/Qt)
    # `import webview` itself can fail, so we defer it to GUI mode only.
    if os.environ.get("DATASET_GEN_HEADLESS") == "1":
        print(f"[headless] FastAPI ready on http://127.0.0.1:{port}", flush=True)
        try:
            thread.join()
        except KeyboardInterrupt:
            server.should_exit = True
            thread.join(timeout=5)
        return

    import webview  # noqa: PLC0415 — deferred until we know we need a GUI

    window = webview.create_window(
        "Dataset Generator",
        f"http://127.0.0.1:{port}",
        width=1400,
        height=900,
        min_size=(1024, 700),
    )

    def _on_closed() -> None:
        server.should_exit = True

    window.events.closed += _on_closed

    webview.start()


if __name__ == "__main__":
    main()
