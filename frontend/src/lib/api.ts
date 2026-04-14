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
  judge_provider?: string
}

export interface ModelOption {
  id: string
  name: string
  pricing?: { prompt: string; completion: string }
}

export interface CategoryConfig {
  name: string
  description: string
  proportion: number
  model?: string
  provider?: string
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
  model_price_per_token?: number
  judge_price_per_token?: number
  judge_provider?: string
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
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') {
        message = body.detail
      } else if (Array.isArray(body?.detail)) {
        message = (body.detail as Array<{ msg: string }>).map((e) => e.msg).join(', ')
      }
    } catch {
      message = await res.text().catch(() => `HTTP ${res.status}`) || `HTTP ${res.status}`
    }
    throw new Error(message)
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
  const data = await request<{
    models: Array<{ id: string; name: string; pricing?: { prompt: string; completion: string } }>
  }>('/api/openrouter/models')
  return data.models.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    pricing: m.pricing,
  }))
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
  avg_score?: number | null
}

export interface ProgressJson {
  total_examples: number
  completed: number
  skipped: number
  current_stage: 'pending' | 'generating_topics' | 'generating_examples' | 'completed' | 'cancelled' | 'failed'
  current_category: string | null
  categories: Record<string, CategoryProgress>
  judge_stats: JudgeStats | null
  actual_cost?: number | null
  judge_cost?: number | null
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

export interface ModelEndpoint {
  name: string
  context_length?: number
  pricing?: { prompt: string; completion: string; request: string }
  provider_name?: string
  quantization?: string
  max_completion_tokens?: number | null
  uptime_last_30m?: number
  latency?: number | null
  throughput?: number | null
}

export async function getModelEndpoints(modelId: string): Promise<ModelEndpoint[]> {
  const data = await request<{ data?: { endpoints?: ModelEndpoint[] } }>(
    `/api/openrouter/models/${encodeURIComponent(modelId)}/endpoints`
  )
  return data?.data?.endpoints ?? []
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

export async function testConnection(): Promise<{ status: string }> {
  return request<{ status: string }>('/api/openrouter/test', { method: 'POST' })
}

export interface JobListItem {
  id: string
  status: string
  total_examples: number
  completed: number
  format: string
  model: string
  category_models: string[]
  created_at: string
  updated_at: string
  actual_cost?: number | null
  judge_cost?: number | null
}

export async function getJobs(): Promise<JobListItem[]> {
  return request<JobListItem[]>('/api/jobs')
}

export async function deleteJob(jobId: string): Promise<void> {
  await request(`/api/jobs/${jobId}`, { method: 'DELETE' })
}

// ---- Dataset preview types ----

export type ExampleItem = SSEExample

export interface JobDetail {
  id: string
  status: string
  config: JobConfig
  progress: ProgressJson | null
  created_at: string
  updated_at: string
}

export async function getJob(jobId: string): Promise<JobDetail> {
  return request<JobDetail>(`/api/jobs/${jobId}`)
}

export async function getJobExamples(
  jobId: string,
  limit = 50,
  offset = 0,
): Promise<ExampleItem[]> {
  return request<ExampleItem[]>(
    `/api/jobs/${jobId}/examples?limit=${limit}&offset=${offset}`,
  )
}
