'use client'

import { useEffect, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { X, Key, Cpu, Scale, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiKeySection } from './ApiKeySection'
import { HfTokenSection } from './HfTokenSection'
import { ConfigSection } from './ConfigSection'
import { SelectField, type SelectOption } from '@/components/ui/select'
import { getApiKey, getHfToken, getConfig, putConfig, getEmbeddingModels } from '@/lib/api'
import { cn } from '@/lib/utils'

type SettingsTab = 'keys' | 'generation' | 'judge' | 'dedup'

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'keys', label: 'API Keys', icon: <Key className="size-4" /> },
  { id: 'generation', label: 'Generation', icon: <Cpu className="size-4" /> },
  { id: 'judge', label: 'LLM Judge', icon: <Scale className="size-4" /> },
  { id: 'dedup', label: 'Dedup', icon: <Layers className="size-4" /> },
]

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
  const [activeTab, setActiveTab] = useState<SettingsTab>('keys')
  const [hasKey, setHasKey] = useState(false)
  const [keyPreview, setKeyPreview] = useState<string | null>(null)
  const [hasHfToken, setHasHfToken] = useState(false)
  const [hfTokenPreview, setHfTokenPreview] = useState<string | null>(null)
  const [delay, setDelay] = useState(2)
  const [retryCount, setRetryCount] = useState(3)
  const [retryCooldown, setRetryCooldown] = useState(15)
  const [localModel, setLocalModel] = useState(model)
  const [judgeEnabled, setJudgeEnabled] = useState(false)
  const [judgeModel, setJudgeModel] = useState('')
  const [judgeThreshold, setJudgeThreshold] = useState(80)
  const [judgeCriteria, setJudgeCriteria] = useState('relevance, coherence, naturalness, and educational value')
  const [judgeProvider, setJudgeProvider] = useState(judgeProviderProp)
  const [embeddingModel, setEmbeddingModel] = useState('openai/text-embedding-3-small')
  const [embeddingModelOptions, setEmbeddingModelOptions] = useState<SelectOption[]>([])
  const [loadingEmbeddingModels, setLoadingEmbeddingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  useEffect(() => {
    if (!open) return
    setSaveError(null)
    setSaveSuccess(false)
    setLocalModel(model)
    setJudgeProvider(judgeProviderProp)

    Promise.all([getApiKey(), getHfToken(), getConfig()])
      .then(([keyStatus, hfStatus, config]) => {
        setHasKey(keyStatus.has_key)
        setKeyPreview(keyStatus.key_preview)
        setHasHfToken(hfStatus.has_token)
        setHfTokenPreview(hfStatus.token_preview)
        setDelay(config.delay_between_requests)
        setRetryCount(config.retry_count)
        setRetryCooldown(config.retry_cooldown)
        setJudgeEnabled(config.judge_enabled)
        setJudgeModel(config.judge_model)
        setJudgeThreshold(config.judge_threshold)
        setJudgeCriteria(config.judge_criteria)
        if (config.embedding_model) setEmbeddingModel(config.embedding_model)
        if (config.default_model && !model) {
          setLocalModel(config.default_model)
        }
      })
      .catch(() => {})

    setLoadingEmbeddingModels(true)
    getEmbeddingModels()
      .then((list) => {
        setEmbeddingModelOptions(list.map((m) => ({ value: m.id, label: m.name })))
      })
      .catch(() => {})
      .finally(() => setLoadingEmbeddingModels(false))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

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
        embedding_model: embeddingModel,
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
            'fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2',
            'max-h-[90vh] overflow-hidden',
            'rounded-2xl shadow-2xl',
            'ring-1 ring-white/10',
            'flex flex-col',
          )}
          style={{
            background: 'oklch(0.13 0.026 232 / 0.97)',
            backdropFilter: 'blur(20px)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/8 px-6 py-4 shrink-0">
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

          {/* Body: sidebar + content */}
          <div className="flex flex-1 min-h-0">
            {/* Sidebar */}
            <nav className="w-44 shrink-0 border-r border-white/8 py-3 px-2 space-y-0.5">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors text-left',
                    activeTab === tab.id
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
                  )}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </nav>

            {/* Content */}
            <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5">
              {activeTab === 'keys' && (
                <div className="space-y-6">
                  <ApiKeySection
                    hasKey={hasKey}
                    keyPreview={keyPreview}
                    onKeyChange={(hk, preview) => {
                      setHasKey(hk)
                      setKeyPreview(preview)
                    }}
                  />
                  <div className="border-t border-border/50" />
                  <HfTokenSection
                    hasToken={hasHfToken}
                    tokenPreview={hfTokenPreview}
                    onTokenChange={(ht, preview) => {
                      setHasHfToken(ht)
                      setHfTokenPreview(preview)
                    }}
                  />
                </div>
              )}

              {activeTab === 'generation' && (
                <ConfigSection
                  section="generation"
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
              )}

              {activeTab === 'judge' && (
                <ConfigSection
                  section="judge"
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
              )}

              {activeTab === 'dedup' && (
                <div className="space-y-3.5">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70">
                    Deduplication
                  </p>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Embedding model</label>
                    <SelectField
                      value={embeddingModel}
                      onChange={setEmbeddingModel}
                      options={embeddingModelOptions}
                      placeholder="Select embedding model..."
                      isLoading={loadingEmbeddingModels}
                    />
                    <p className="text-xs text-muted-foreground">
                      Model used for semantic similarity detection when checking duplicates
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-white/8 px-6 py-4 shrink-0">
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
