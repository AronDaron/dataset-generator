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
