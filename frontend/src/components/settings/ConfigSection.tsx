'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SelectField, type SelectOption } from '@/components/ui/select'
import { SliderField } from '@/components/ui/slider'
import { getModels } from '@/lib/api'
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
  onJudgeEnabledChange: (enabled: boolean) => void
  onJudgeModelChange: (model: string) => void
  onJudgeThresholdChange: (threshold: number) => void
  onJudgeCriteriaChange: (criteria: string) => void
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
  onJudgeEnabledChange,
  onJudgeModelChange,
  onJudgeThresholdChange,
  onJudgeCriteriaChange,
}: ConfigSectionProps) {
  const [models, setModels] = useState<SelectOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  useEffect(() => {
    if (!hasApiKey) return
    setLoadingModels(true)
    setModelsError(null)
    getModels()
      .then((list) =>
        setModels(list.map((m) => ({ value: m.id, label: m.name || m.id }))),
      )
      .catch(() => setModelsError('Failed to load models'))
      .finally(() => setLoadingModels(false))
  }, [hasApiKey])

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
                onChange={onModelChange}
                options={models}
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
                  onChange={onJudgeModelChange}
                  options={models}
                  placeholder="Use generation model"
                  isLoading={loadingModels}
                />
              )}
            </div>

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
