'use client'

import { useEffect, useState } from 'react'
import { SelectField, type SelectOption } from '@/components/ui/select'
import { SliderField } from '@/components/ui/slider'
import { getModels, getModelEndpoints, type ModelOption } from '@/lib/api'
import { toGroupedOptions } from '@/lib/model-utils'
import { cn } from '@/lib/utils'

interface ConfigSectionProps {
  section?: 'all' | 'generation' | 'judge'
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-widest text-text-3">
      {children}
    </p>
  )
}

const FIELD_LABEL = "text-[11px] font-medium uppercase tracking-widest text-text-3"
const INPUT_CLS = "w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-text-0 outline-none placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"

export function ConfigSection({
  section = 'all',
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
        if (model) onModelPricingChange?.(list.find((m) => m.id === model)?.pricing)
        if (judgeModel) onJudgePricingChange?.(list.find((m) => m.id === judgeModel)?.pricing)
      })
      .catch(() => setModelsError('Failed to load models'))
      .finally(() => setLoadingModels(false))
  }, [hasApiKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const modelOptions = toGroupedOptions(modelList)

  const handleModelChange = (value: string) => {
    onModelChange(value)
    onModelPricingChange?.(modelList.find((m) => m.id === value)?.pricing)
  }

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
    onJudgeProviderChange('')
  }

  const showGeneration = section === 'all' || section === 'generation'
  const showJudge = section === 'all' || section === 'judge'

  return (
    <div className="space-y-5">
      {/* ── Generation ──────────────────────────────── */}
      {showGeneration && (
      <div className="space-y-3.5">
        <SectionLabel>Generation</SectionLabel>

        {/* Model */}
        <div className="space-y-1.5">
          <label className={FIELD_LABEL}>Model</label>
          {!hasApiKey ? (
            <p className="text-sm text-text-3">Enter your API key to load available models.</p>
          ) : (
            <>
              <SelectField
                value={model}
                onChange={handleModelChange}
                options={modelOptions}
                placeholder="Select model..."
                isLoading={loadingModels}
              />
              {modelsError && <p className="text-xs text-destructive">{modelsError}</p>}
            </>
          )}
        </div>

        {/* Delay + Retry — side by side */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className={FIELD_LABEL}>
              Delay{' '}
              <span className="text-[10px] font-normal text-text-4">sec</span>
            </label>
            <input
              type="number"
              min={0}
              max={60}
              value={delay}
              onChange={(e) => onDelayChange(Math.max(0, Math.min(60, Number(e.target.value))))}
              className={INPUT_CLS}
            />
          </div>
          <div className="space-y-1.5">
            <label className={FIELD_LABEL}>
              Retries{' '}
              <span className="text-[10px] font-normal text-text-4">on error</span>
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={retryCount}
              onChange={(e) => onRetryChange(Math.max(1, Math.min(10, Number(e.target.value))))}
              className={INPUT_CLS}
            />
          </div>
        </div>
      </div>
      )}

      {/* Divider */}
      {showGeneration && showJudge && <div className="border-t border-border" />}

      {/* ── LLM Judge ───────────────────────────────── */}
      {showJudge && (
      <div className="space-y-3.5">
        {/* Toggle row */}
        <div className="flex items-center justify-between">
          <div>
            <SectionLabel>LLM Judge</SectionLabel>
            <p className="mt-0.5 text-xs text-text-3">Additional API cost applies</p>
          </div>
          <button
            role="switch"
            aria-checked={judgeEnabled}
            onClick={() => onJudgeEnabledChange(!judgeEnabled)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              judgeEnabled ? 'bg-primary' : 'bg-muted',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
          >
            <span
              className={cn(
                'pointer-events-none block size-4 rounded-full bg-text-0 shadow transition-transform',
                judgeEnabled ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </button>
        </div>

        {judgeEnabled && (
          <div className="space-y-3.5">
            {/* Judge model + provider — side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-1.5">
                <label className={FIELD_LABEL}>Judge model</label>
                {!hasApiKey ? (
                  <p className="text-xs text-text-3">API key required</p>
                ) : (
                  <SelectField
                    value={judgeModel}
                    onChange={handleJudgeModelChange}
                    options={modelOptions}
                    placeholder="Gen model"
                    isLoading={loadingModels}
                  />
                )}
              </div>
              <div className="min-w-0 space-y-1.5">
                <label className={FIELD_LABEL}>Provider</label>
                {judgeModel ? (
                  <SelectField
                    value={judgeProvider}
                    onChange={(val) => onJudgeProviderChange(val || '')}
                    options={[{ value: '', label: '— Auto —' }, ...judgeProviderOptions]}
                    placeholder="— Auto —"
                    isLoading={loadingJudgeProviders}
                  />
                ) : (
                  <div className="flex h-[34px] select-none items-center rounded-lg border border-border bg-muted/40 px-3 text-xs text-text-4">
                    select model first
                  </div>
                )}
              </div>
            </div>

            {/* Threshold */}
            <SliderField
              value={judgeThreshold}
              onValueChange={onJudgeThresholdChange}
              min={0}
              max={100}
              step={1}
              label="Min quality score"
              displayValue={`${judgeThreshold}/100`}
            />

            {/* Criteria */}
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Evaluation criteria</label>
              <textarea
                value={judgeCriteria}
                onChange={(e) => onJudgeCriteriaChange(e.target.value)}
                rows={2}
                placeholder="relevance, coherence, naturalness, educational value"
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-0 outline-none placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
              <p className="text-xs text-text-3">
                Comma-separated criteria sent to the judge model
              </p>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  )
}
