from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class CategoryConfig(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str = Field(..., min_length=10, max_length=1000)
    proportion: float = Field(..., gt=0.0, le=1.0)
    model: str | None = None
    provider: str | None = None
    prompt_price: float = 0.0
    completion_price: float = 0.0
    judge_model: str | None = None
    judge_provider: str | None = None
    judge_prompt_price: float = 0.0
    judge_completion_price: float = 0.0


class JobConfig(BaseModel):
    categories: List[CategoryConfig] = Field(..., min_length=1, max_length=10)
    total_examples: int = Field(..., ge=10, le=10000)
    temperature: float = Field(..., ge=0.0, le=1.5)
    max_tokens: int = Field(..., ge=512, le=8192)
    model: str = Field(..., min_length=1)
    format: Literal["sharegpt", "alpaca", "chatml"]
    delay_between_requests: Optional[float] = Field(default=None, ge=0.0, le=60.0)
    retry_count: int = Field(default=3, ge=1, le=10)
    retry_cooldown: int = Field(default=15, ge=1, le=120)
    judge_enabled: bool = False
    judge_model: Optional[str] = None
    judge_threshold: int = Field(default=80, ge=0, le=100)
    conversation_turns: int = Field(default=2, ge=1, le=5)
    judge_criteria: str = Field(default="relevance, coherence, naturalness, and educational value")
    model_price_per_token: float = 0.0  # deprecated — kept for old jobs backward compat
    judge_price_per_token: float = 0.0  # deprecated — kept for old jobs backward compat
    judge_prompt_price: float = 0.0
    judge_completion_price: float = 0.0
    judge_provider: str | None = None

    @model_validator(mode="after")
    def proportions_sum_to_one(self) -> "JobConfig":
        total = sum(c.proportion for c in self.categories)
        if abs(total - 1.0) > 0.01:
            raise ValueError(f"Proportions must sum to 1.0, got {total:.4f}")
        return self

    @model_validator(mode="after")
    def alpaca_forces_single_turn(self) -> "JobConfig":
        if self.format == "alpaca":
            self.conversation_turns = 1
        return self


class CategoryProgress(BaseModel):
    target: int
    completed: int
    skipped: int


class JudgeStats(BaseModel):
    evaluated: int = 0
    accepted: int = 0
    rejected: int = 0
    avg_score: float | None = None


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
    actual_cost: Optional[float] = None
    judge_cost: Optional[float] = None


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
    category_models: List[str] = Field(default_factory=list)
    created_at: str
    updated_at: str
    actual_cost: float | None = None
    judge_cost: float | None = None


class ExampleResponse(BaseModel):
    id: str
    job_id: str
    content: Dict[str, Any]
    format: str
    tokens: int
    created_at: str
    judge_score: Optional[int] = None
    category: str = ""
    model: str = ""


# ---- Deduplication ----


class DuplicateRequest(BaseModel):
    threshold: float = Field(default=0.85, ge=0.5, le=1.0)


class DuplicatePairResponse(BaseModel):
    example_id_a: str
    example_id_b: str
    similarity: float
    preview_a: str
    preview_b: str
    content_a: Dict[str, Any]
    content_b: Dict[str, Any]
    format_a: str
    format_b: str
    tokens_a: int
    tokens_b: int
    judge_score_a: Optional[int] = None
    judge_score_b: Optional[int] = None


class DuplicatesResponse(BaseModel):
    pairs: List[DuplicatePairResponse]
    total_examples: int


# ---- Quality Report ----


class ScoreBucket(BaseModel):
    label: str
    count: int


class ScoreDistribution(BaseModel):
    buckets: List[ScoreBucket]
    total: int
    min_score: int
    max_score: int
    avg_score: float
    median_score: int


class TokenStatsByCategory(BaseModel):
    category: str
    examples_count: int
    avg_tokens: float
    min_tokens: int
    max_tokens: int


class GenerationEfficiency(BaseModel):
    category: str
    target: int
    completed: int
    skipped: int
    success_rate: float


class JobStatsResponse(BaseModel):
    job_id: str
    judge_enabled: bool
    score_distribution: Optional[ScoreDistribution] = None
    token_stats: List[TokenStatsByCategory]
    generation_efficiency: List[GenerationEfficiency]


# ---- Merge ----


class MergeRequest(BaseModel):
    job_ids: List[str] = Field(..., min_length=2)
    shuffle: bool = True


class MergeResponse(BaseModel):
    path: str
    total_examples: int
    source_jobs: int
