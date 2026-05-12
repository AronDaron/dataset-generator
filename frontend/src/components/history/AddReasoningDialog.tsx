'use client'

import { useEffect, useMemo, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { X, Loader2, AlertCircle, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SelectField, type SelectOption } from '@/components/ui/select'
import {
  addReasoning,
  getModels,
  getModelEndpoints,
  type JobListItem,
  type ModelOption,
  type ReasoningRequest,
} from '@/lib/api'
import { toGroupedOptions } from '@/lib/model-utils'
import { cn } from '@/lib/utils'

// Per-category selection — mirrors the gen UI's CategoryCard exactly:
// pick a model (globally grouped + iconned across all enabled providers) and
// optionally pin an OpenRouter upstream provider so the reasoning pass uses
// a specific physical backend instead of OpenRouter's default auto-route.
interface CategorySelection {
  model: string
  provider_route: string // empty string = auto-routing
}

interface AddReasoningDialogProps {
  open: boolean
  sourceJob: JobListItem
  sourceCategories: string[]
  onClose: () => void
  onSubmit: (req: ReasoningRequest) => Promise<void>
}

const AUTO_PROVIDER_OPTION: SelectOption = { value: '', label: '— Auto —' }

export function AddReasoningDialog({
  open,
  sourceJob,
  sourceCategories,
  onClose,
  onSubmit,
}: AddReasoningDialogProps) {
  const [format, setFormat] = useState<'inline' | 'separate'>('inline')

  // Model list is identical to what the gen page surfaces — one flat list
  // aggregated across every enabled provider, with the company prefix
  // (anthropic/, openai/, google/, …) driving the group + icon. The
  // `provider_id` of the picked model identifies the backend we route
  // through (OpenRouter / Ollama / LM Studio); no separate "provider"
  // select needed.
  const [modelList, setModelList] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  const [selections, setSelections] = useState<Record<string, CategorySelection>>({})

  // Routing options live per category because they depend on the picked
  // model's endpoints — same flow as CategoryCard in the gen UI.
  const [routingByCategory, setRoutingByCategory] = useState<Record<string, SelectOption[]>>({})
  const [routingLoading, setRoutingLoading] = useState<Set<string>>(new Set())

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // ---- Effects ----

  useEffect(() => {
    if (!open) return
    setModelsLoading(true)
    setModelsError(null)
    getModels()
      .then((list) => {
        setModelList(list)
        if (list.length === 0) {
          setModelsError('No models available — check that at least one provider is enabled.')
        }
      })
      .catch((e) => setModelsError(e instanceof Error ? e.message : 'Failed to load models'))
      .finally(() => setModelsLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    const seed: Record<string, CategorySelection> = {}
    for (const name of sourceCategories) {
      seed[name] = { model: '', provider_route: '' }
    }
    setSelections(seed)
    setRoutingByCategory({})
    setFormat('inline')
    setSubmitError(null)
  }, [open, sourceCategories])

  // Whenever a category's model changes, fetch its OpenRouter routing
  // candidates (latency + uptime annotated) — identical to CategoryCard.
  async function loadRoutingFor(catName: string, modelId: string) {
    if (!modelId) {
      setRoutingByCategory((prev) => ({ ...prev, [catName]: [] }))
      return
    }
    setRoutingLoading((s) => new Set(s).add(catName))
    try {
      const endpoints = await getModelEndpoints(modelId)
      const seen = new Set<string>()
      const opts: SelectOption[] = endpoints
        .filter((e) => {
          const key = e.provider_name || e.name
          if (!key || seen.has(key)) return false
          seen.add(key)
          return true
        })
        .map((e) => {
          const routingName = e.provider_name || e.name
          const parts: string[] = [routingName]
          if (e.latency != null) parts.push(`${Math.round(e.latency)}ms`)
          if (e.uptime_last_30m != null) parts.push(`${e.uptime_last_30m.toFixed(1)}% up`)
          return { value: routingName, label: parts.join(' · ') }
        })
      setRoutingByCategory((prev) => ({ ...prev, [catName]: opts }))
    } catch {
      setRoutingByCategory((prev) => ({ ...prev, [catName]: [] }))
    } finally {
      setRoutingLoading((s) => {
        const next = new Set(s)
        next.delete(catName)
        return next
      })
    }
  }

  function handleModelChange(catName: string, modelId: string) {
    setSelections((prev) => ({
      ...prev,
      [catName]: { model: modelId, provider_route: '' },
    }))
    void loadRoutingFor(catName, modelId)
  }

  function handleRouteChange(catName: string, route: string) {
    setSelections((prev) => ({
      ...prev,
      [catName]: { ...prev[catName], provider_route: route },
    }))
  }

  const modelOptions = useMemo(() => toGroupedOptions(modelList), [modelList])

  // Maps "openai/gpt-4" → "openrouter-default" so the request body can name
  // the actual backend that physically serves the model. Without this the
  // reasoning service would have to guess.
  const providerIdByModel = useMemo(() => {
    const m: Record<string, string | undefined> = {}
    for (const opt of modelList) m[opt.id] = opt.provider_id
    return m
  }, [modelList])

  const allFilled = sourceCategories.every((cat) => {
    const sel = selections[cat]
    return sel && sel.model && providerIdByModel[sel.model]
  })

  async function handleSubmit() {
    if (!allFilled || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onSubmit({
        format,
        categories: sourceCategories.map((name) => {
          const sel = selections[name]
          return {
            name,
            model: sel.model,
            provider_id: providerIdByModel[sel.model]!,
            // Empty string → undefined so the backend treats it as "no
            // pinned route" rather than literally routing to "".
            provider_route: sel.provider_route || undefined,
          }
        }),
      })
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to start reasoning pass')
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[4px]" />
        <Dialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2',
            'max-h-[90vh] overflow-hidden rounded-xl border border-border bg-card shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7),0_8px_20px_rgba(0,0,0,0.35)]',
            'flex flex-col',
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <Dialog.Title className="flex items-center gap-2 font-serif text-xl italic tracking-[-0.01em] text-text-0">
              <Sparkles className="size-4 text-primary" />
              Add Reasoning
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon" onClick={onClose} disabled={submitting}>
                  <X className="size-4" />
                </Button>
              }
            />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            <p className="text-xs text-text-3">
              Generates rationale prose for every example in this dataset using
              the model you pick per category. The original dataset is not
              modified — a new reasoning job is created with its own JSONL.
            </p>

            {/* Format */}
            <div className="space-y-2">
              <label className="text-[11px] font-medium uppercase tracking-widest text-text-3">
                Format
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setFormat('inline')}
                  className={cn(
                    'flex-1 rounded-lg border px-4 py-3 text-left text-sm transition-colors',
                    format === 'inline'
                      ? 'border-transparent bg-accent-soft text-primary'
                      : 'border-border bg-card text-text-2 hover:border-line-strong hover:bg-muted hover:text-text-0',
                  )}
                  disabled={submitting}
                >
                  <div className="font-semibold">Inline &lt;think&gt;</div>
                  <div className="mt-1 text-[11px] text-text-3">
                    Recommended. Reasoning is injected into the first assistant
                    turn — broadest trainer compatibility.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setFormat('separate')}
                  className={cn(
                    'flex-1 rounded-lg border px-4 py-3 text-left text-sm transition-colors',
                    format === 'separate'
                      ? 'border-transparent bg-accent-soft text-primary'
                      : 'border-border bg-card text-text-2 hover:border-line-strong hover:bg-muted hover:text-text-0',
                  )}
                  disabled={submitting}
                >
                  <div className="font-semibold">Separate field</div>
                  <div className="mt-1 text-[11px] text-text-3">
                    Adds a top-level <span className="font-mono">reasoning</span> key
                    next to the existing format. Needs trainer template config.
                  </div>
                </button>
              </div>
            </div>

            {/* Models loading state */}
            {modelsLoading && (
              <div className="flex items-center gap-2 text-sm text-text-3">
                <Loader2 className="size-3.5 animate-spin" /> Loading models…
              </div>
            )}

            {modelsError && (
              <div className="flex items-start gap-2 rounded-lg border border-transparent bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                {modelsError}
              </div>
            )}

            {/* Per-category model + routing selectors */}
            {!modelsLoading && !modelsError && (
              <div className="space-y-3">
                <label className="text-[11px] font-medium uppercase tracking-widest text-text-3">
                  Per-category reasoning model
                </label>
                <div className="space-y-2">
                  {sourceCategories.map((cat) => {
                    const sel = selections[cat] ?? { model: '', provider_route: '' }
                    const routes = routingByCategory[cat] ?? []
                    const routesLoading = routingLoading.has(cat)
                    const providerSelectOptions: SelectOption[] =
                      routes.length > 0 ? [AUTO_PROVIDER_OPTION, ...routes] : []
                    return (
                      <div
                        key={cat}
                        className="rounded-lg border border-border bg-background px-4 py-3 space-y-2"
                      >
                        <div className="text-sm font-semibold text-text-0">{cat}</div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1 min-w-0">
                            <p className="text-[10.5px] uppercase tracking-widest text-text-3">Model</p>
                            <SelectField
                              value={sel.model}
                              onChange={(v) => handleModelChange(cat, v)}
                              options={modelOptions}
                              placeholder="Pick model"
                              disabled={submitting}
                            />
                          </div>
                          <div className="space-y-1 min-w-0">
                            <p className="text-[10.5px] uppercase tracking-widest text-text-3">Provider</p>
                            {sel.model ? (
                              <SelectField
                                value={sel.provider_route}
                                onChange={(v) => handleRouteChange(cat, v)}
                                options={providerSelectOptions}
                                placeholder="Auto"
                                isLoading={routesLoading}
                                disabled={submitting}
                              />
                            ) : (
                              <div className="flex h-[34px] items-center rounded-lg border border-border bg-muted/40 px-3 text-xs text-text-4">
                                pick model first
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {submitError && (
              <div className="flex items-start gap-2 rounded-lg border border-transparent bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                {submitError}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-4">
            <span className="text-[11px] text-text-3">
              Source: <span className="font-mono">{sourceJob.completed.toLocaleString('en-US')}</span> examples
              · <span className="uppercase">{sourceJob.format}</span>
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!allFilled || submitting}>
                {submitting ? (
                  <><Loader2 className="size-3.5 animate-spin" /> Starting…</>
                ) : (
                  'Start reasoning pass'
                )}
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
