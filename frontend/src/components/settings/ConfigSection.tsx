'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SelectField, type SelectOption } from '@/components/ui/select'
import { SliderField } from '@/components/ui/slider'
import { getModels, getModelEndpoints, type ModelOption } from '@/lib/api'
import { cn } from '@/lib/utils'

interface ConfigSectionProps {
  model: string
  delay: number
  retryCount: number
  onModelChange: (model: string) => void
  onDelayChange: (delay: number) => void
  onRetryChange: (retry: number) => void
  hasApiKey: boolean
  judgeEnabled: boolean
  judgeModel: string
  judgeThreshold: number
  judgeCriteria: string
  judgeProvider: string
  onJudgeEnabledChange: (enabled: boolean) => void
  onJudgeModelChange: (model: string) => void
  onJudgeThresholdChange: (threshold: number) => void
  onJudgeCriteriaChange: (criteria: string) => void
  onJudgeProviderChange: (provider: string) => void
  onModelPricingChange?: (pricing: { prompt: string; completion: string } | undefined) => void
  onJudgePricingChange?: (pricing: { prompt: string; completion: string } | undefined) => void
}

function toGroupedOptions(list: ModelOption[]): SelectOption[] {
  return [...list]
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    .map((m) => {
      const prefix = m.id.split('/')[0]
      return {
        value: m.id,
        label: m.name || m.id,
        group: prefix.charAt(0).toUpperCase() + prefix.slice(1),
      }
    })
}

export function ConfigSection({
  model,
  delay,
  retryCount,
  onModelChange,
  onDelayChange,
  onRetryChange,
  hasApiKey,
  judgeEnabled,
  judgeModel,
  judgeThreshold,
  judgeCriteria,
  judgeProvider,
  onJudgeEnabledChange,
  onJudgeModelChange,
  onJudgeThresholdChange,
  onJudgeCriteriaChange,
  onJudgeProviderChange,
  onModelPricingChange,
  onJudgePricingChange,
}: ConfigSectionProps) {
  const [modelList, setModelList] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [judgeProviderOptions, setJudgeProviderOptions] = useState<SelectOption[]>([])
  const [loadingJudgeProviders, setLoadingJudgeProviders] = useState(false)

  useEffect(() => {
    if (!hasApiKey) return
    setLoadingModels(true)
    setModelsError(null)
    getModels()
      .then((list) => {
        setModelList(list)
        // Fire pricing for already-selected models (config loaded before model list)
        if (model) {
          onModelPricingChange?.(list.find((m) => m.id === model)?.pricing)
        }
        if (judgeModel) {
          onJudgePricingChange?.(list.find((m) => m.id === judgeModel)?.pricing)
        }
      })
      .catch(() => setModelsError('Failed to load models'))
      .finally(() => setLoadingModels(false))
  }, [hasApiKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const modelOptions = toGroupedOptions(modelList)

  const handleModelChange = (value: string) => {
    onModelChange(value)
    onModelPricingChange?.(modelList.find((m) => m.id === value)?.pricing)
  }

  // Lazy-fetch judge providers when judge model changes
  useEffect(() => {
    if (!judgeModel) { setJudgeProviderOptions([]); return }
    let cancelled = false
    setLoadingJudgeProviders(true)
    getModelEndpoints(judgeModel)
      .then((endpoints) => {
        if (cancelled) return
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
        setJudgeProviderOptions(opts)
      })
      .catch(() => { if (!cancelled) setJudgeProviderOptions([]) })
      .finally(() => { if (!cancelled) setLoadingJudgeProviders(false) })
    return () => { cancelled = true }
  }, [judgeModel])

  const handleJudgeModelChange = (value: string) => {
    onJudgeModelChange(value)
    onJudgePricingChange?.(modelList.find((m) => m.id === value)?.pricing)
    onJudgeProviderChange('')  // reset provider when model changes
  }

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Generation settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Model selection */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Model</label>
          {!hasApiKey ? (
            <p className="text-sm text-muted-foreground">
              Set your API key to load available models.
            </p>
          ) : (
            <>
              <SelectField
                value={model}
                onChange={handleModelChange}
                options={modelOptions}
                placeholder="Select model..."
                isLoading={loadingModels}
              />
              {modelsError && (
                <p className="text-xs text-destructive">{modelsError}</p>
              )}
            </>
          )}
        </div>

        {/* Delay */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Delay between requests
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={60}
              value={delay}
              onChange={(e) =>
                onDelayChange(Math.max(0, Math.min(60, Number(e.target.value))))
              }
              className="w-20 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <span className="text-sm text-muted-foreground">seconds</span>
          </div>
        </div>

        {/* Retry count */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Retry attempts on API error
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={10}
              value={retryCount}
              onChange={(e) =>
                onRetryChange(Math.max(1, Math.min(10, Number(e.target.value))))
              }
              className="w-20 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <span className="text-sm text-muted-foreground">
              (15s cooldown on 429/500)
            </span>
          </div>
        </div>
      </CardContent>
    </Card>

    {/* LLM Judge card */}
    <Card>
      <CardHeader>
        <CardTitle className="text-base">LLM Judge</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Enable LLM Judge</p>
            <p className="text-xs text-muted-foreground">(generates additional cost)</p>
          </div>
          <button
            role="switch"
            aria-checked={judgeEnabled}
            onClick={() => onJudgeEnabledChange(!judgeEnabled)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              judgeEnabled ? 'bg-primary' : 'bg-muted',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            )}
          >
            <span
              className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform',
                judgeEnabled ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </button>
        </div>

        {/* Conditional sub-fields */}
        {judgeEnabled && (
          <>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Judge model</label>
              {!hasApiKey ? (
                <p className="text-sm text-muted-foreground">
                  Set your API key to load available models.
                </p>
              ) : (
                <SelectField
                  value={judgeModel}
                  onChange={handleJudgeModelChange}
                  options={modelOptions}
                  placeholder="Use generation model"
                  isLoading={loadingModels}
                />
              )}
            </div>

            {judgeModel && (loadingJudgeProviders || judgeProviderOptions.length > 0) && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Judge provider</label>
                <SelectField
                  value={judgeProvider}
                  onChange={(val) => onJudgeProviderChange(val || '')}
                  options={[{ value: '', label: '— Auto-select provider —' }, ...judgeProviderOptions]}
                  placeholder="— Auto-select provider —"
                  isLoading={loadingJudgeProviders}
                />
              </div>
            )}

            <SliderField
              value={judgeThreshold}
              onValueChange={onJudgeThresholdChange}
              min={0}
              max={100}
              step={1}
              label="Minimum quality score"
              displayValue={`${judgeThreshold}/100`}
            />

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Judge evaluation criteria</label>
              <textarea
                value={judgeCriteria}
                onChange={(e) => onJudgeCriteriaChange(e.target.value)}
                rows={3}
                placeholder="relevance, coherence, naturalness, and educational value"
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated list of criteria sent to the judge model
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
    </>
  )
}
