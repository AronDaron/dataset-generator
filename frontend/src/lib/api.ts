// All fetch wrappers for the backend API.
// Every function throws an Error on non-ok responses.

export interface ApiKeyStatus {
  has_key: boolean
  key_preview: string | null
}

export interface GlobalConfig {
  delay_between_requests: number
  retry_count: number
  retry_cooldown: number
  default_model: string
  judge_enabled: boolean
  judge_model: string
  judge_threshold: number
  conversation_turns: number
  judge_criteria: string
}

export interface ModelOption {
  id: string
  name: string
}

export interface CategoryConfig {
  name: string
  description: string
  proportion: number
}

export interface JobConfig {
  categories: CategoryConfig[]
  total_examples: number
  temperature: number
  max_tokens: number
  model: string
  format: 'sharegpt' | 'alpaca' | 'chatml'
  delay_between_requests?: number
  judge_enabled?: boolean
  judge_model?: string
  judge_threshold?: number
  conversation_turns?: number
  judge_criteria?: string
}

export interface JobCreatedResponse {
  id: string
  status: string
}

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(path, options)
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`)
    throw new Error(text || `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function getApiKey(): Promise<ApiKeyStatus> {
  return request<ApiKeyStatus>('/api/settings/api-key')
}

export async function saveApiKey(key: string): Promise<void> {
  await request('/api/settings/api-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key }),
  })
}

export async function deleteApiKey(): Promise<void> {
  await request('/api/settings/api-key', { method: 'DELETE' })
}

export async function getConfig(): Promise<GlobalConfig> {
  return request<GlobalConfig>('/api/settings/config')
}

export async function putConfig(cfg: Partial<GlobalConfig>): Promise<void> {
  await request('/api/settings/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
}

export async function getModels(): Promise<ModelOption[]> {
  const data = await request<{ models: { id: string; name: string }[] }>(
    '/api/openrouter/models',
  )
  return data.models.map((m) => ({ id: m.id, name: m.name || m.id }))
}

export async function createJob(cfg: JobConfig): Promise<JobCreatedResponse> {
  return request<JobCreatedResponse>('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
}

// ---- SSE types ----

export interface CategoryProgress {
  target: number
  completed: number
  skipped: number
}

export interface JudgeStats {
  evaluated: number
  accepted: number
  rejected: number
}

export interface ProgressJson {
  total_examples: number
  completed: number
  skipped: number
  current_stage: 'pending' | 'generating_topics' | 'generating_examples' | 'completed' | 'cancelled' | 'failed'
  current_category: string | null
  categories: Record<string, CategoryProgress>
  judge_stats: JudgeStats | null
}

export interface SSEExample {
  id: string
  job_id: string
  content: Record<string, unknown>
  format: 'sharegpt' | 'alpaca' | 'chatml'
  tokens: number
  created_at: string
  judge_score: number | null
}

export interface SSEProgressPayload {
  status: string
  progress: ProgressJson | null
  examples: SSEExample[]
}

// ---- New API functions ----

export async function cancelJob(jobId: string): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' })
  // 409 = already terminal — swallow silently
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => `HTTP ${res.status}`)
    throw new Error(text || `HTTP ${res.status}`)
  }
}

export async function openDatasetsFolder(): Promise<void> {
  await request<{ path: string }>('/api/datasets/open-folder', { method: 'POST' })
}
