from typing import Any

import aiosqlite
import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.database import get_db
from app.services.openrouter_client import OPENROUTER_BASE_URL, OpenRouterError, chat_completion, list_models
from app.utils import get_api_key as _get_api_key

router = APIRouter()


def _openrouter_error_to_http(e: OpenRouterError) -> HTTPException:
    if e.status_code == 401:
        return HTTPException(status_code=401, detail="Invalid OpenRouter API key")
    if e.status_code == 429:
        return HTTPException(status_code=429, detail="OpenRouter rate limit exceeded")
    if e.status_code >= 500:
        return HTTPException(status_code=502, detail=f"OpenRouter upstream error: {e}")
    return HTTPException(status_code=e.status_code, detail=str(e))


@router.get("/models")
async def get_models(db: aiosqlite.Connection = Depends(get_db)) -> dict[str, Any]:
    api_key = await _get_api_key(db)
    try:
        models = await list_models(api_key)
    except OpenRouterError as e:
        raise _openrouter_error_to_http(e)
    return {"models": models}


@router.get("/models/{model_id:path}/endpoints")
async def get_model_endpoints(model_id: str, db: aiosqlite.Connection = Depends(get_db)) -> Any:
    api_key = await _get_api_key(db)
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(
            f"{OPENROUTER_BASE_URL}/models/{model_id}/endpoints",
            headers={
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer": "http://localhost",
                "X-Title": "DatasetGenerator",
            },
        )
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return r.json()


@router.post("/test")
async def test_connection(db: aiosqlite.Connection = Depends(get_db)) -> dict[str, str]:
    api_key = await _get_api_key(db)
    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'default_model'"
    ) as cursor:
        row = await cursor.fetchone()
    model = row["value"] if row and row["value"] else "openai/gpt-4o-mini"
    try:
        await chat_completion(
            api_key=api_key,
            model=model,
            messages=[{"role": "user", "content": "Hi"}],
            max_tokens=1,
        )
    except OpenRouterError as e:
        raise _openrouter_error_to_http(e)
    return {"status": "ok"}
