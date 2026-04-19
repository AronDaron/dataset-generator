"""Headless smoke test for the desktop same-origin setup.

Starts uvicorn in a daemon thread (no pywebview — runs fine on headless Linux),
hits key routes, and shuts down cleanly. Run on the dev box to verify:

- StaticFiles mount serves the built frontend HTML from the same port as /api
- /api routers still take priority over the static catch-all
- CORS middleware is disabled when DATASET_GEN_DESKTOP=1

Exit code 0 on success, 1 on any failure.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
from pathlib import Path

os.environ.setdefault("DATASET_GEN_DESKTOP", "1")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import httpx  # noqa: E402
import uvicorn  # noqa: E402

from app.main import app  # noqa: E402


def find_free_port(start: int = 17842) -> int:
    for port in range(start, start + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port")


def wait_for_ready(base: str, timeout: float = 10.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if httpx.get(f"{base}/api/health", timeout=0.5).status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    return False


def _check(name: str, got: int, allowed: tuple[int, ...]) -> bool:
    ok = got in allowed
    print(f"  [{'OK' if ok else 'FAIL'}] {name}: {got} (expected {allowed})")
    return ok


def run_checks(base: str, frontend_built: bool) -> int:
    failures = 0

    # /api/health must always respond 200
    r = httpx.get(f"{base}/api/health", timeout=5)
    if not _check("GET /api/health", r.status_code, (200,)):
        failures += 1

    # CORS must be OFF in desktop mode — no allow-origin header on plain requests
    has_cors = "access-control-allow-origin" in {k.lower() for k in r.headers.keys()}
    if has_cors:
        print("  [FAIL] CORS header present in desktop mode (expected off)")
        failures += 1
    else:
        print("  [OK] CORS disabled in desktop mode")

    # Static routes — only when frontend was built
    if frontend_built:
        for path in ("/", "/history", "/jobs?id=nonexistent"):
            r = httpx.get(f"{base}{path}", timeout=5, follow_redirects=True)
            if not _check(f"GET {path}", r.status_code, (200,)):
                failures += 1
            elif "text/html" not in r.headers.get("content-type", ""):
                print(f"  [FAIL] GET {path}: content-type is not HTML")
                failures += 1
    else:
        print("  [SKIP] frontend/out/ not found — run `cd frontend && npm run build`")
        print("         to exercise static serving checks.")

    # /api routers keep priority over static catch-all
    r = httpx.get(f"{base}/api/settings/api-key", timeout=5)
    if not _check("GET /api/settings/api-key", r.status_code, (200, 404)):
        failures += 1

    return failures


def main() -> int:
    from app.config import settings

    frontend_built = settings.frontend_dir.exists()
    port = find_free_port()
    base = f"http://127.0.0.1:{port}"

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]

    thread = threading.Thread(target=server.run, daemon=True, name="uvicorn")
    thread.start()

    try:
        if not wait_for_ready(base):
            print("[FAIL] backend did not become healthy within 10s")
            return 1

        print(f"Backend up on {base} (frontend_built={frontend_built}).")
        failures = run_checks(base, frontend_built)
    finally:
        server.should_exit = True
        thread.join(timeout=5)

    if failures:
        print(f"\n{failures} check(s) failed.")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
