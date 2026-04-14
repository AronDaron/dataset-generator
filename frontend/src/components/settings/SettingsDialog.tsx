'use client'

import { useEffect, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiKeySection } from './ApiKeySection'
import { ConfigSection } from './ConfigSection'
import { getApiKey, getConfig, putConfig } from '@/lib/api'
import { cn } from '@/lib/utils'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  model: string
  judgeProvider?: string
  onModelChange: (model: string) => void
  onJudgeProviderChange?: (provider: string) => void
  onModelPricingChange?: (pricing: { prompt: string; completion: string } | undefined) => void
  onJudgePricingChange?: (pricing: { prompt: string; completion: string } | undefined) => void
}

export function SettingsDialog({
  open,
  onClose,
  model,
  judgeProvider: judgeProviderProp = '',
  onModelChange,
  onJudgeProviderChange,
  onModelPricingChange,
  onJudgePricingChange,
}: SettingsDialogProps) {
  const [hasKey, setHasKey] = useState(false)
  const [keyPreview, setKeyPreview] = useState<string | null>(null)
  const [delay, setDelay] = useState(2)
  const [retryCount, setRetryCount] = useState(3)
  const [retryCooldown, setRetryCooldown] = useState(15) // preserved, not exposed in UI
  const [localModel, setLocalModel] = useState(model)
  const [judgeEnabled, setJudgeEnabled] = useState(false)
  const [judgeModel, setJudgeModel] = useState('')
  const [judgeThreshold, setJudgeThreshold] = useState(80)
  const [judgeCriteria, setJudgeCriteria] = useState('relevance, coherence, naturalness, and educational value')
  const [judgeProvider, setJudgeProvider] = useState(judgeProviderProp)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Load current settings when dialog opens
  useEffect(() => {
    if (!open) return
    setSaveError(null)
    setSaveSuccess(false)
    setLocalModel(model)
    setJudgeProvider(judgeProviderProp)

    Promise.all([getApiKey(), getConfig()])
      .then(([keyStatus, config]) => {
        setHasKey(keyStatus.has_key)
        setKeyPreview(keyStatus.key_preview)
        setDelay(config.delay_between_requests)
        setRetryCount(config.retry_count)
        setRetryCooldown(config.retry_cooldown)
        setJudgeEnabled(config.judge_enabled)
        setJudgeModel(config.judge_model)
        setJudgeThreshold(config.judge_threshold)
        setJudgeCriteria(config.judge_criteria)
        if (config.default_model && !model) {
          setLocalModel(config.default_model)
        }
      })
      .catch(() => {
        // non-fatal: settings will be empty
      })
  }, [open]) // intentionally omit `model` — sync only on open

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      await putConfig({
        delay_between_requests: delay,
        retry_count: retryCount,
        retry_cooldown: retryCooldown,
        default_model: localModel,
        judge_enabled: judgeEnabled,
        judge_model: judgeModel,
        judge_threshold: judgeThreshold,
        judge_criteria: judgeCriteria,
        judge_provider: judgeProvider,
      })
      onModelChange(localModel)
      onJudgeProviderChange?.(judgeProvider)
      setSaveSuccess(true)
      setTimeout(() => {
        setSaveSuccess(false)
        onClose()
      }, 800)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        />
        <Dialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
            'max-h-[90vh] overflow-y-auto',
            'rounded-2xl shadow-2xl',
            'ring-1 ring-white/10',
          )}
          style={{
            background: 'oklch(0.13 0.026 232 / 0.97)',
            backdropFilter: 'blur(20px)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
            <Dialog.Title className="text-base font-semibold">
              Settings
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon">
                  <X className="size-4" />
                </Button>
              }
            />
          </div>

          {/* Content */}
          <div className="space-y-5 px-6 py-5">
            <ApiKeySection
              hasKey={hasKey}
              keyPreview={keyPreview}
              onKeyChange={(hk, preview) => {
                setHasKey(hk)
                setKeyPreview(preview)
              }}
            />
            <ConfigSection
              model={localModel}
              delay={delay}
              retryCount={retryCount}
              onModelChange={setLocalModel}
              onDelayChange={setDelay}
              onRetryChange={setRetryCount}
              hasApiKey={hasKey}
              judgeEnabled={judgeEnabled}
              judgeModel={judgeModel}
              judgeThreshold={judgeThreshold}
              judgeCriteria={judgeCriteria}
              judgeProvider={judgeProvider}
              onJudgeEnabledChange={setJudgeEnabled}
              onJudgeModelChange={setJudgeModel}
              onJudgeThresholdChange={setJudgeThreshold}
              onJudgeCriteriaChange={setJudgeCriteria}
              onJudgeProviderChange={setJudgeProvider}
              onModelPricingChange={onModelPricingChange}
              onJudgePricingChange={onJudgePricingChange}
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-white/8 px-6 py-4">
            {saveError && (
              <p className="mr-auto text-sm text-destructive">{saveError}</p>
            )}
            {saveSuccess && (
              <p className="mr-auto text-sm text-green-600">Saved!</p>
            )}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save settings'}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
