'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Cloud, Cpu, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  type AutoDetectCandidate,
  type Provider,
  type ProviderKind,
  autoDetectProviders,
  createProvider,
  deleteProvider,
  getProviderDefaultBaseUrl,
  getProviders,
  testProvider,
  updateProvider,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const KIND_LABEL: Record<ProviderKind, string> = {
  openrouter: 'OpenRouter',
  openai_compat: 'Local / OpenAI-compat',
}

const KIND_ICON: Record<ProviderKind, React.ReactNode> = {
  openrouter: <Cloud className="size-3.5" />,
  openai_compat: <Cpu className="size-3.5" />,
}

interface AddDraft {
  kind: ProviderKind
  name: string
  base_url: string
  api_key: string
  set_default: boolean
}

const EMPTY_DRAFT: AddDraft = {
  kind: 'openai_compat',
  name: '',
  base_url: '',
  api_key: '',
  set_default: false,
}

interface ProvidersSectionProps {
  onProvidersChanged?: () => void
}

export function ProvidersSection({ onProvidersChanged }: ProvidersSectionProps = {}) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<AddDraft>(EMPTY_DRAFT)
  const [savingAdd, setSavingAdd] = useState(false)

  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>(
    {},
  )

  const [scanning, setScanning] = useState(false)
  const [scanResults, setScanResults] = useState<AutoDetectCandidate[] | null>(null)

  // Per-row "edit api key" state — single ID at a time keeps state simple.
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editKeyValue, setEditKeyValue] = useState('')

  async function load(): Promise<Provider[]> {
    setLoading(true)
    try {
      const fresh = await getProviders()
      setProviders(fresh)
      setError(null)
      return fresh
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load providers')
      return []
    } finally {
      setLoading(false)
    }
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000)
  }

  function notifyChanged() {
    onProvidersChanged?.()
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleStartAdd(kind: ProviderKind) {
    let base_url = ''
    try {
      base_url = await getProviderDefaultBaseUrl(kind)
    } catch {
      base_url = kind === 'openrouter'
        ? 'https://openrouter.ai/api/v1'
        : 'http://127.0.0.1:11434/v1'
    }
    setDraft({ ...EMPTY_DRAFT, kind, base_url })
    setAdding(true)
  }

  async function handleSaveAdd() {
    if (!draft.name.trim() || !draft.base_url.trim()) return
    setSavingAdd(true)
    setError(null)
    try {
      await createProvider({
        kind: draft.kind,
        name: draft.name.trim(),
        base_url: draft.base_url.trim(),
        api_key: draft.api_key.trim() || null,
        enabled: true,
        set_default: draft.set_default,
      })
      setDraft(EMPTY_DRAFT)
      setAdding(false)
      await load()
      notifyChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add provider')
    } finally {
      setSavingAdd(false)
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await updateProvider(id, { set_default: true })
      await load()
      notifyChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set default')
    }
  }

  async function handleToggleEnabled(p: Provider) {
    const wasDisablingDefault = p.is_default && p.enabled
    try {
      await updateProvider(p.id, { enabled: !p.enabled })
      const fresh = await load()
      notifyChanged()
      if (wasDisablingDefault) {
        const newDefault = fresh.find((x) => x.is_default && x.id !== p.id)
        if (newDefault) {
          showToast(`Default switched to ${newDefault.name}`)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle provider')
    }
  }

  async function handleSaveKey(id: string) {
    try {
      await updateProvider(id, { api_key: editKeyValue.trim() })
      setEditingKey(null)
      setEditKeyValue('')
      await load()
      notifyChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update API key')
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteProvider(id)
      await load()
      notifyChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete provider')
    }
  }

  async function handleTest(id: string) {
    setTesting(id)
    try {
      const result = await testProvider(id)
      setTestResults((prev) => ({
        ...prev,
        [id]: result.ok
          ? { ok: true, message: `${result.models_count} models available` }
          : { ok: false, message: result.error ?? 'Test failed' },
      }))
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, message: err instanceof Error ? err.message : 'Test failed' },
      }))
    } finally {
      setTesting(null)
    }
  }

  async function handleScan() {
    setScanning(true)
    try {
      const data = await autoDetectProviders()
      setScanResults(data.candidates)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-detect failed')
    } finally {
      setScanning(false)
    }
  }

  async function handleAddDetected(c: AutoDetectCandidate) {
    try {
      await createProvider({
        kind: 'openai_compat',
        name: `${c.label} (local)`,
        base_url: c.base_url,
        enabled: true,
      })
      setScanResults((prev) => prev?.filter((x) => x.base_url !== c.base_url) ?? null)
      await load()
      notifyChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add provider')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-text-3">
          LLM Providers
        </p>
        <Button variant="ghost" size="sm" onClick={handleScan} disabled={scanning}>
          <Search className="size-3.5" />
          {scanning ? 'Scanning…' : 'Auto-detect local'}
        </Button>
      </div>

      {scanResults && (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          {scanResults.length === 0 ? (
            <p className="text-xs text-text-3">
              No local LLM endpoints found. Start Ollama (port 11434) or LM Studio
              (port 1234), then scan again.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-medium text-text-2">
                Found {scanResults.length} local endpoint(s):
              </p>
              {scanResults.map((c) => (
                <div
                  key={c.base_url}
                  className="flex items-center justify-between gap-2 rounded-lg bg-background px-3 py-2"
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-text-0">{c.label}</span>
                    <span className="ml-2 truncate font-mono text-xs text-text-3">
                      {c.base_url} · {c.models_count} models
                    </span>
                  </div>
                  <Button size="sm" onClick={() => handleAddDetected(c)}>
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-3">Loading providers…</p>
      ) : (
        <div className="space-y-2">
          {providers.map((p) => {
            const test = testResults[p.id]
            const isEditing = editingKey === p.id
            return (
              <div
                key={p.id}
                className={cn(
                  'rounded-lg border bg-background px-4 py-3',
                  p.enabled ? 'border-border' : 'border-dashed border-border/60 opacity-70',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className={cn(
                        'flex size-7 shrink-0 items-center justify-center rounded-md',
                        p.kind === 'openrouter' ? 'bg-accent-soft text-primary' : 'bg-muted text-text-2',
                      )}
                    >
                      {KIND_ICON[p.kind]}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-0">{p.name}</span>
                        {p.is_default && (
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                            Default
                          </span>
                        )}
                      </div>
                      <p className="truncate font-mono text-xs text-text-3">
                        {KIND_LABEL[p.kind]} · {p.base_url}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!p.is_default && p.enabled && (
                      <Button variant="ghost" size="sm" onClick={() => handleSetDefault(p.id)}>
                        Set default
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTest(p.id)}
                      disabled={testing === p.id}
                    >
                      {testing === p.id ? 'Testing…' : 'Test'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleEnabled(p)}
                    >
                      {p.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    {!p.is_default && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(p.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* API key row */}
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-widest text-text-3">
                    API key
                  </span>
                  {isEditing ? (
                    <>
                      <input
                        type="password"
                        value={editKeyValue}
                        onChange={(e) => setEditKeyValue(e.target.value)}
                        placeholder={p.kind === 'openrouter' ? 'sk-or-v1-…' : '(leave blank if not required)'}
                        className="flex-1 rounded-lg border border-border bg-background px-3 py-1 text-sm text-text-0 outline-none placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                        autoFocus
                      />
                      <Button size="sm" onClick={() => handleSaveKey(p.id)}>
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingKey(null)
                          setEditKeyValue('')
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="font-mono text-sm text-text-2">
                        {p.has_api_key ? p.api_key_preview : '— none —'}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingKey(p.id)
                          setEditKeyValue('')
                        }}
                      >
                        {p.has_api_key ? 'Change' : 'Add'}
                      </Button>
                    </>
                  )}
                </div>

                {test && (
                  <p
                    className={cn(
                      'mt-2 flex items-center gap-1.5 text-xs',
                      test.ok ? 'text-ok' : 'text-destructive',
                    )}
                  >
                    {test.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
                    {test.message}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add provider */}
      {adding ? (
        <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-xs font-semibold text-text-2">Add {KIND_LABEL[draft.kind]}</p>
          <div className="space-y-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Display name (e.g. Local Ollama)"
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-text-0 outline-none placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <input
              value={draft.base_url}
              onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
              placeholder="Base URL (must end in /v1 for OpenAI-compat)"
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-sm text-text-0 outline-none placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <input
              type="password"
              value={draft.api_key}
              onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
              placeholder={draft.kind === 'openrouter' ? 'API key (required)' : 'API key (optional, leave blank for Ollama)'}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-text-0 outline-none placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <label className="flex items-center gap-2 text-sm text-text-2">
              <input
                type="checkbox"
                checked={draft.set_default}
                onChange={(e) => setDraft({ ...draft, set_default: e.target.checked })}
              />
              Make this the default provider
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveAdd} disabled={savingAdd}>
              {savingAdd ? 'Adding…' : 'Add provider'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => handleStartAdd('openai_compat')}>
            <Plus className="size-3.5" />
            Add local (Ollama / LM Studio / custom)
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handleStartAdd('openrouter')}>
            <Plus className="size-3.5" />
            Add OpenRouter
          </Button>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </p>
      )}

      {toast && (
        <p className="flex items-center gap-1.5 rounded-lg border border-border bg-accent-soft px-3 py-2 text-sm text-primary">
          <CheckCircle2 className="size-3.5 shrink-0" />
          {toast}
        </p>
      )}
    </div>
  )
}
