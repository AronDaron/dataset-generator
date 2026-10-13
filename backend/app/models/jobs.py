from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator

from app.services.prompt_builder import DEFAULT_CLEANUP_RULES


class CategoryConfig(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str = Field(..., min_length=10, max_length=1000)
    proportion: float = Field(..., gt=0.0, le=1.0)
    model: str | None = None
    provider: str | None = None  # OpenRouter routing string ("DeepSeek" etc.)
    provider_id: str | None = None  # FK → providers.id; None = use job-level default
    prompt_price: float = 0.0
    completion_price: float = 0.0
    judge_model: str | None = None
    judge_provider: str | None = None
    judge_provider_id: str | None = None
    judge_prompt_price: float = 0.0
    judge_completion_price: float = 0.0
    # Cleanup stage (generation -> cleanup -> judge). Mirrors the judge block:
    # None means "fall back to the job-level cleanup settings".
    cleanup_model: str | None = None
    cleanup_provider: str | None = None
    cleanup_provider_id: str | None = None
    cleanup_prompt_price: float = 0.0
    cleanup_completion_price: float = 0.0


class JobConfig(BaseModel):
    categories: List[CategoryConfig] = Field(..., min_length=1, max_length=64)
    # Upper bound matches MAX_MERGE_EXAMPLES so merged jobs (which can reach
    # 500k) can still be deserialized. User-facing create_job enforces a
    # tighter cap (10_000) explicitly in the endpoint.
    total_examples: int = Field(..., ge=10, le=500_000)
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
    provider_id: str | None = None  # default LLM provider for this job
    judge_provider_id: str | None = None  # default judge LLM provider for this job
    # Cleanup stage. `cleanup_enabled` is a per-run switch owned by the
    # generator draft on the frontend (like `temperature`), NOT a global
    # setting — closing the settings dialog must not flip it.
    cleanup_enabled: bool = False
    cleanup_model: Optional[str] = None
    cleanup_rules: str = Field(default=DEFAULT_CLEANUP_RULES)
    cleanup_provider: str | None = None
    cleanup_provider_id: str | None = None
    cleanup_prompt_price: float = 0.0
    cleanup_completion_price: float = 0.0

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


class CleanupStats(BaseModel):
    """Outcome tally of the cleanup stage, aggregated over the whole job.

    Cleanup never rejects an example, so none of these counters shrinks the
    dataset — they only describe what the stage did to the content.
    """

    # Examples that entered the stage (the denominator for the rest).
    processed: int = 0
    # Examples whose content actually changed.
    modified: int = 0
    # Examples the model returned verbatim — nothing to fix.
    unchanged: int = 0
    # Examples where at least one slot was rolled back by an acceptance gate.
    # Not exclusive with `modified`: other slots of the same example may have
    # been cleaned successfully.
    reverted: int = 0
    # Examples where the stage could not run at all (API error or broken
    # response contract). The original content is kept.
    failed: int = 0


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
        "interrupted",
        "merging_copying",
        "merging_exporting",
        "merging_computing_stats",
        "reasoning_copying",
        "reasoning_generating",
        "reasoning_exporting",
        "reasoning_computing_stats",
        "cleanup_copying",
        "cleanup_processing",
        "cleanup_exporting",
        "cleanup_computing_stats",
    ]
    current_category: Optional[str] = None
    categories: Dict[str, CategoryProgress]
    judge_stats: Optional[JudgeStats] = None
    cleanup_stats: Optional[CleanupStats] = None
    actual_cost: Optional[float] = None
    judge_cost: Optional[float] = None
    cleanup_cost: Optional[float] = None
    reasoning_cost: Optional[float] = None


class JobResponse(BaseModel):
    id: str
    status: str
    config: JobConfig
    progress: Optional[ProgressJson] = None
    created_at: str
    updated_at: str
    parent_job_id: Optional[str] = None
    reasoning_format: Optional[Literal["inline", "separate", "reasoning_content"]] = None


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
    is_merged: bool = False
    # True for a cleanup post-process pass (a cleaned copy of another
    # dataset). Derived from the config marker, not a column.
    is_cleanup_post: bool = False
    parent_job_id: str | None = None
    reasoning_format: Literal["inline", "separate", "reasoning_content"] | None = None
    reasoning_models: List[str] = Field(default_factory=list)


class ResumableJobsResponse(BaseModel):
    jobs: List[JobListItem]
    interrupted_count: int


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
    # Per-turn rationales (one entry per assistant turn in `content`). None
    # for non-reasoning jobs and for examples skipped during the reasoning
    # pass. Frontend renders each entry as a `<think>`-style block before
    # the matching assistant turn.
    reasoning: Optional[List[str]] = None
    reasoning_model_used: Optional[str] = None


# ---- Deduplication ----


class DuplicateRequest(BaseModel):
    threshold: float = Field(default=0.85, ge=0.5, le=1.0)


class BulkDeleteExamplesRequest(BaseModel):
    # Examples to delete from this job (dedup's "Remove all lower-scored").
    # IDs that are unknown or belong to another job are skipped, not an
    # error — a duplicate list scanned before another delete can go stale.
    # Upper bound matches JobConfig.total_examples.
    example_ids: List[str] = Field(..., min_length=1, max_length=500_000)


class BulkDeleteExamplesResponse(BaseModel):
    deleted: int
    remaining: int


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


class CategoryRunInfo(BaseModel):
    name: str
    gen_model: str
    gen_provider: Optional[str] = None
    gen_model_is_default: bool
    judge_model: Optional[str] = None
    judge_provider: Optional[str] = None
    judge_model_is_default: bool = False
    target: int
    completed: int
    # Populated only on reasoning jobs (post-process pass). Names the model
    # that produced the per-turn rationales for this category — useful for
    # HF model card transparency since reasoning often uses a different
    # (e.g. cheaper / neutral) model than the gen pass.
    reasoning_model: Optional[str] = None
    reasoning_provider: Optional[str] = None


class RunSummary(BaseModel):
    started_at: str
    ended_at: Optional[str] = None
    duration_seconds: Optional[int] = None
    status: str
    format: str
    total_examples: int
    actual_examples: int
    is_merged: bool = False
    merged_from_count: int = 0
    categories: List[CategoryRunInfo]


class JobStatsResponse(BaseModel):
    job_id: str
    judge_enabled: bool
    run_summary: Optional[RunSummary] = None
    score_distribution: Optional[ScoreDistribution] = None
    token_stats: List[TokenStatsByCategory]
    generation_efficiency: List[GenerationEfficiency]


# ---- Merge ----


class MergeRequest(BaseModel):
    job_ids: List[str] = Field(..., min_length=2)
    shuffle: bool = True


class MergeResponse(BaseModel):
    job_id: str
    path: str
    total_examples: int
    source_jobs: int


# ---- Reasoning post-process ----


class ReasoningCategoryConfig(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    model: str = Field(..., min_length=1, max_length=200)
    provider_id: str = Field(..., min_length=1)
    # OpenRouter-style routing string (e.g. "Anthropic", "DeepSeek"). Pinned
    # so the reasoning pass goes through a specific upstream provider on
    # OpenRouter for deterministic latency / pricing / quality. Mirrors the
    # gen pipeline's `CategoryConfig.provider`. Silently ignored for backends
    # whose `capabilities.supports_provider_routing` is False (Ollama, LM Studio).
    provider_route: str | None = None


class ReasoningRequest(BaseModel):
    # Inline = `<think>...</think>` injected at the start of the first assistant
    # turn at export time. Separate = top-level `reasoning` field in JSONL.
    # reasoning_content = OpenAI-style `messages` with a per-assistant-message
    # `reasoning_content` field (what Gemma 4 / Qwen 3.5+ templates render as
    # their thought channel). Chosen per-pass and frozen on the job; merge
    # rejects mixed formats.
    format: Literal["inline", "separate", "reasoning_content"]
    # One entry per source category — every category must be covered. Schema
    # enforces 1..64 to match JobConfig.categories.
    categories: List[ReasoningCategoryConfig] = Field(..., min_length=1, max_length=64)
    temperature: float = Field(default=0.5, ge=0.0, le=1.5)
    # None (default) = no budget of our own; the call only carries the
    # runaway guard (reasoning_service.REASONING_RUNAWAY_TOKEN_GUARD, 32k).
    # Thinking models spend a model- and example-dependent share of any cap
    # on their thought channel (gemma-4-26B-A4B: ~6k tokens before 1.3k chars
    # of prose), so a tight cap only ever starves them. Prose length is
    # bounded by the prompt and the prose validator instead. Kept optional
    # for callers that do want a specific hard stop.
    max_tokens: Optional[int] = Field(default=None, ge=1024, le=65536)


class ReasoningResponse(BaseModel):
    job_id: str
    parent_job_id: str
    total_examples: int


# ---- Cleanup post-process ----


class CleanupCategoryOverride(BaseModel):
    """Optional per-category override of the job-level cleanup model.

    Only the fields that are set override the request defaults, so a caller
    that wants one model everywhere sends no overrides at all. Mirrors how
    ``CategoryConfig.cleanup_*`` overrides ``JobConfig.cleanup_*`` in the
    inline pipeline.
    """

    name: str = Field(..., min_length=1, max_length=100)
    model: str | None = Field(default=None, max_length=200)
    provider_id: str | None = None
    # OpenRouter-style routing string ("DeepSeek", "Anthropic"). Ignored by
    # backends whose `capabilities.supports_provider_routing` is False.
    provider_route: str | None = None


class CleanupJobRequest(BaseModel):
    """Body of POST /api/jobs/{id}/add-cleanup.

    There is no ``max_tokens`` field on purpose: the per-call budget is
    derived from the payload by ``prompt_builder.cleanup_max_tokens`` and is
    deliberately not capped by a user value (a reasoning model spends the same
    completion budget on its thinking block as on the answer, and cleanup only
    ever echoes back text that already exists).
    """

    model: str = Field(..., min_length=1, max_length=200)
    provider_id: str = Field(..., min_length=1)
    provider_route: str | None = None
    cleanup_rules: str = Field(default=DEFAULT_CLEANUP_RULES, min_length=1)
    # Per-1-token prices of the cleanup model, used to fill in
    # `progress.cleanup_cost`. 0.0 (local backends) simply reports no spend.
    prompt_price: float = Field(default=0.0, ge=0.0)
    completion_price: float = Field(default=0.0, ge=0.0)
    categories: List[CleanupCategoryOverride] = Field(default_factory=list, max_length=64)


class CleanupJobResponse(BaseModel):
    job_id: str
    parent_job_id: str
    total_examples: int
