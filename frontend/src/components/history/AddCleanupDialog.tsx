'use client'

import { useEffect, useMemo, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { X, Loader2, AlertCircle, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SelectField, type SelectOption } from '@/components/ui/select'
import {
  getConfig,
  getModels,
  getModelEndpoints,
  type CleanupJobRequest,
  type JobListItem,
  type ModelOption,
} from '@/lib/api'
import { toGroupedOptions } from '@/lib/model-utils'
import { cn } from '@/lib/utils'

interface AddCleanupDialogProps {
  open: boolean
  sourceJob: JobListItem
  onClose: () => void
  onSubmit: (req: CleanupJobRequest) => Promise<void>
}

const AUTO_PROVIDER_OPTION: SelectOption = { value: '', label: '— Auto —' }

export function AddCleanupDialog({
  open,
  sourceJob,
  onClose,
  onSubmit,
}: AddCleanupDialogProps) {
  // One model for the whole dataset — cleanup is a normalizer, not a
  // per-category authoring step, so the per-category override the API accepts
  // is not worth a second column of selects here.
  const [modelList, setModelList] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  const [model, setModel] = useState('')
  const [providerRoute, setProviderRoute] = useState('')
  const [routes, setRoutes] = useState<SelectOption[]>([])
  const [routesLoading, setRoutesLoading] = useState(false)

  const [rules, setRules] = useState('')
  const [rulesLoading, setRulesLoading] = useState(false)

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

  // Seed the rules from the saved global cleanup rules — the same text the
  // inline stage uses, so a post-process pass starts from what the user
  // already tuned in Settings.
  useEffect(() => {
    if (!open) return
    setModel('')
    setProviderRoute('')
    setRoutes([])
    setSubmitError(null)
    setRulesLoading(true)
    getConfig()
      .then((cfg) => {
        setRules(cfg.cleanup_rules ?? '')
        if (cfg.cleanup_model) setModel(cfg.cleanup_model)
      })
      .catch(() => setRules(''))
      .finally(() => setRulesLoading(false))
  }, [open])

  async function loadRoutingFor(modelId: string) {
    if (!modelId) {
      setRoutes([])
      return
    }
    setRoutesLoading(true)
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
      setRoutes(opts)
    } catch {
      setRoutes([])
    } finally {
      setRoutesLoading(false)
    }
  }

  function handleModelChange(modelId: string) {
    setModel(modelId)
    setProviderRoute('')
    void loadRoutingFor(modelId)
  }

  const modelOptions = useMemo(() => toGroupedOptions(modelList), [modelList])

  const selectedModel = useMemo(
    () => modelList.find((m) => m.id === model),
    [modelList, model],
  )

  const providerSelectOptions: SelectOption[] =
    routes.length > 0 ? [AUTO_PROVIDER_OPTION, ...routes] : []

  const canSubmit = Boolean(model && selectedModel?.provider_id && rules.trim()) && !submitting

  async function handleSubmit() {
    if (!canSubmit || !selectedModel?.provider_id) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onSubmit({
        model,
        provider_id: selectedModel.provider_id,
        // Empty string → undefined so the backend reads it as "no pinned route".
        provider_route: providerRoute || undefined,
        cleanup_rules: rules,
        prompt_price: selectedModel.pricing ? parseFloat(selectedModel.pricing.prompt) : 0,
        completion_price: selectedModel.pricing ? parseFloat(selectedModel.pricing.completion) : 0,
      })
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to start cleanup pass')
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
              <Wand2 className="size-4 text-primary" />
              Add Cleanup
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
              Runs the cleanup stage over every example in this dataset — the
              model deletes format defects (LaTeX, emoji, unclosed fences,
              flattering openers) without rewriting content. The original
              dataset is not modified: a new job is created with its own JSONL,
              so a bad cleanup model costs one deleted job.
            </p>

            {/* Model */}
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

            {!modelsLoading && !modelsError && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5 min-w-0">
                  <label className="text-[11px] font-medium uppercase tracking-widest text-text-3">
                    Cleanup model
                  </label>
                  <SelectField
                    value={model}
                    onChange={handleModelChange}
                    options={modelOptions}
                    placeholder="Pick model"
                    disabled={submitting}
                  />
                </div>
                <div className="space-y-1.5 min-w-0">
                  <label className="text-[11px] font-medium uppercase tracking-widest text-text-3">
                    Provider
                  </label>
                  {model ? (
                    <SelectField
                      value={providerRoute}
                      onChange={setProviderRoute}
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
            )}

            {/* Rules */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium uppercase tracking-widest text-text-3">
                Cleanup rules
              </label>
              <textarea
                value={rules}
                onChange={(e) => setRules(e.target.value)}
                disabled={submitting || rulesLoading}
                rows={8}
                spellCheck={false}
                placeholder={rulesLoading ? 'Loading rules…' : 'One rule per line'}
                className={cn(
                  'w-full resize-y rounded-lg border border-border bg-background px-3 py-2',
                  'font-mono text-xs leading-relaxed text-text-1 outline-none',
                  'placeholder:text-text-4 focus:border-line-strong',
                )}
              />
              <p className="text-[11px] text-text-3">
                One rule per line. Every rule must describe something to delete
                or minimally reformat — a rule that asks for a rewrite gets
                reverted by the acceptance gates.
              </p>
            </div>

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
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {submitting ? (
                  <><Loader2 className="size-3.5 animate-spin" /> Starting…</>
                ) : (
                  'Start cleanup pass'
                )}
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
