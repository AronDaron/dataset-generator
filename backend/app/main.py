# Dataset Generator — synthetic dataset generation for LLM fine-tuning
# Copyright (C) 2026 Radosław Szmajda (AronDaron) <https://github.com/AronDaron>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import close_db, init_db
from app.routers import health
from app.routers import settings as settings_router
from app.routers import openrouter as openrouter_router
from app.routers import jobs as jobs_router
from app.routers import datasets as datasets_router

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s:%(name)s:%(message)s",
)

DESKTOP_MODE = os.getenv("DATASET_GEN_DESKTOP") == "1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    await close_db()


app = FastAPI(
    title="Dataset Generator API",
    version="0.1.0",
    description="Backend API for Dataset Generator desktop app",
    lifespan=lifespan,
    redirect_slashes=False,
)

# CORS only in dev — desktop mode serves the frontend same-origin.
if not DESKTOP_MODE:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

app.include_router(health.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api/settings")
app.include_router(openrouter_router.router, prefix="/api/openrouter")
app.include_router(jobs_router.router, prefix="/api/jobs")
app.include_router(datasets_router.router, prefix="/api/datasets")

# Static frontend mount. MUST come after the /api routers so they keep priority.
# Skipped silently when the build output is missing (e.g. on a fresh clone
# before `npm run build`), so the API still boots for dev work.
if settings.frontend_dir.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(settings.frontend_dir), html=True),
        name="frontend",
    )
