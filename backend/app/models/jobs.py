from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class CategoryConfig(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str = Field(..., min_length=10, max_length=1000)
    proportion: float = Field(..., gt=0.0, le=1.0)


class JobConfig(BaseModel):
    categories: List[CategoryConfig] = Field(..., min_length=1, max_length=10)
    total_examples: int = Field(..., ge=10, le=10000)
    temperature: float = Field(..., ge=0.0, le=1.5)
    max_tokens: int = Field(..., ge=512, le=8192)
    model: str = Field(..., min_length=1)
    format: Literal["sharegpt", "alpaca", "chatml"]
    delay_between_requests: Optional[float] = Field(default=None, ge=0.0, le=60.0)
    judge_enabled: bool = False
    judge_model: str = ""
    judge_threshold: int = Field(default=80, ge=0, le=100)

    @model_validator(mode="after")
    def proportions_sum_to_one(self) -> "JobConfig":
        total = sum(c.proportion for c in self.categories)
        if abs(total - 1.0) > 0.01:
            raise ValueError(f"Proportions must sum to 1.0, got {total:.4f}")
        return self


class CategoryProgress(BaseModel):
    target: int
    completed: int
    skipped: int


class JudgeStats(BaseModel):
    evaluated: int = 0
    accepted: int = 0
    rejected: int = 0


class ProgressJson(BaseModel):
    total_examples: int
    completed: int
    skipped: int
    current_stage: Literal[
        "pending",
        "generating_topics",
        "generating_examples",
        "completed",
        "cancelled",
        "failed",
    ]
    current_category: Optional[str] = None
    categories: Dict[str, CategoryProgress]
    judge_stats: Optional[JudgeStats] = None


class JobResponse(BaseModel):
    id: str
    status: str
    config: JobConfig
    progress: Optional[ProgressJson] = None
    created_at: str
    updated_at: str


class JobListItem(BaseModel):
    id: str
    status: str
    total_examples: int
    completed: int
    format: str
    model: str
    created_at: str
    updated_at: str


class ExampleResponse(BaseModel):
    id: str
    job_id: str
    content: Dict[str, Any]
    format: str
    tokens: int
    created_at: str
    judge_score: Optional[int] = None
