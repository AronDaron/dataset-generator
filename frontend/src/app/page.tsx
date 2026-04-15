'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Settings2, Rocket, AlertCircle, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { CategoryList } from '@/components/generator/CategoryList'
import { GlobalControls } from '@/components/generator/GlobalControls'
import { FormatSelector } from '@/components/generator/FormatSelector'
import { type Category, toApiProportions } from '@/lib/proportions'
import { getApiKey, getConfig, getModels, createJob, type ModelOption } from '@/lib/api'
import { toGroupedOptions } from '@/lib/model-utils'
import { JobDashboard } from '@/components/generator/JobDashboard'

type ExportFormat = 'sharegpt' | 'alpaca' | 'chatml'

function validateCategories(cats: Category[]): string | null {
  for (const cat of cats) {
    if (!cat.name.trim()) return 'Every category must have a name.'
    if (cat.description.trim().length < 10)
      return `Category "${cat.name}" — description must be at least 10 characters.`
  }
  return null
}

export default function GeneratorPage() {
  const [categories, setCategories] = useState<Category[]>([])
  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(2048)
  const [totalExamples, setTotalExamples] = useState(100)
  const [format, setFormat] = useState<ExportFormat>('sharegpt')
  const [model, setModel] = useState('')
  const [judgeEnabled, setJudgeEnabled] = useState(false)
  const [judgeModel, setJudgeModel] = useState('')
  const [judgeThreshold, setJudgeThreshold] = useState(80)
  const [conversationTurns, setConversationTurns] = useState(2)
  const [judgeCriteria, setJudgeCriteria] = useState('relevance, coherence, naturalness, and educational value')
  const [judgeProvider, setJudgeProvider] = useState('')
  const [modelList, setModelList] = useState<ModelOption[]>([])
  const [modelPricing, setModelPricing] = useState<{ prompt: string; completion: string } | undefined>()
  const [judgePricing, setJudgePricing] = useState<{ prompt: string; completion: string } | undefined>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [createdJobId, setCreatedJobId] = useState<string | null>(null)
  const [activeJobThreshold, setActiveJobThreshold] = useState(80)

  // Persist active job across page reloads (e.g. HMR or accidental refresh)
  const SESSION_KEY = 'activeJobId'
  function updateJobId(id: string | null) {
    setCreatedJobId(id)
    if (id) sessionStorage.setItem(SESSION_KEY, id)
    else sessionStorage.removeItem(SESSION_KEY)
  }

  // Restore job id from sessionStorage on mount
  useEffect(() => {
    const saved = sessionStorage.getItem(SESSION_KEY)
    if (saved) setCreatedJobId(saved)
  }, [])

  useEffect(() => {
    Promise.all([getApiKey(), getConfig()])
      .then(([keyStatus, config]) => {
        if (config.default_model) setModel(config.default_model)
        setJudgeEnabled(config.judge_enabled)
        setJudgeModel(config.judge_model)
        setJudgeThreshold(config.judge_threshold)
        setConversationTurns(config.conversation_turns)
        setJudgeCriteria(config.judge_criteria)
        setJudgeProvider(config.judge_provider ?? '')
        if (!keyStatus.has_key) setSettingsOpen(true)
        else getModels().then((list) => {
          setModelList(list)
          if (config.default_model) setModelPricing(list.find((m) => m.id === config.default_model)?.pricing)
          if (config.judge_model) setJudgePricing(list.find((m) => m.id === config.judge_model)?.pricing)
        }).catch(() => {/* non-fatal */})
      })
      .catch(() => setSettingsOpen(true))
  }, [])

  const estimatedCost = useMemo(() => {
    if (categories.length === 0 || modelList.length === 0) return null
    const estPromptPerTurn = 400
    const estCompletionPerTurn = maxTokens * 0.6

    let cost = 0
    for (const cat of categories) {
      const effectiveModelId = cat.model || model
      const pricing = modelList.find((m) => m.id === effectiveModelId)?.pricing
      if (!pricing) continue
      const promptPrice = parseFloat(pricing.prompt)
      const completionPrice = parseFloat(pricing.completion)
      const catExamples = totalExamples * (cat.proportion / 100)
      cost += catExamples * conversationTurns * (
        estPromptPerTurn * promptPrice + estCompletionPerTurn * completionPrice
      )
    }
    if (judgeEnabled) {
      const effectiveJudgePricing = judgePricing ?? modelPricing
      if (effectiveJudgePricing) {
        cost += totalExamples * (
          400 * parseFloat(effectiveJudgePricing.prompt) +
          100 * parseFloat(effectiveJudgePricing.completion)
        )
      }
    }
    return cost > 0 ? cost : null
  }, [categories, model, modelList, totalExamples, maxTokens, conversationTurns, judgeEnabled, judgePricing, modelPricing])

  function isValid(): boolean {
    if (categories.length === 0) return false
    if (!model) return false
    return validateCategories(categories) === null
  }

  async function handleStart() {
    const validationError = validateCategories(categories)
    if (validationError) { setSubmitError(validationError); return }
    if (!model) { setSubmitError('Select a model in settings.'); return }
    if (categories.length === 0) { setSubmitError('Add at least one category.'); return }

    setIsSubmitting(true)
    setSubmitError(null)
    updateJobId(null)

    try {
      const proportionFloats = toApiProportions(categories)
      const result = await createJob({
        categories: categories.map((c, i) => {
          const effectiveModelId = c.model || model
          const pricing = modelList.find((m) => m.id === effectiveModelId)?.pricing
          return {
            name: c.name.trim(),
            description: c.description.trim(),
            proportion: proportionFloats[i],
            ...(c.model ? { model: c.model } : {}),
            ...(c.provider ? { provider: c.provider } : {}),
            prompt_price: pricing ? parseFloat(pricing.prompt) : 0,
            completion_price: pricing ? parseFloat(pricing.completion) : 0,
          }
        }),
        total_examples: totalExamples,
        temperature,
        max_tokens: maxTokens,
        model,
        format,
        judge_enabled: judgeEnabled,
        judge_model: judgeModel,
        judge_threshold: judgeThreshold,
        conversation_turns: conversationTurns,
        judge_criteria: judgeCriteria,
        ...(judgeProvider ? { judge_provider: judgeProvider } : {}),
        model_price_per_token: modelPricing
          ? (parseFloat(modelPricing.prompt) + parseFloat(modelPricing.completion)) / 2
          : 0,
        judge_price_per_token: judgePricing
          ? (parseFloat(judgePricing.prompt) + parseFloat(judgePricing.completion)) / 2
          : 0,
        judge_prompt_price: judgePricing ? parseFloat(judgePricing.prompt) : 0,
        judge_completion_price: judgePricing ? parseFloat(judgePricing.completion) : 0,
      })
      setActiveJobThreshold(judgeThreshold)
      updateJobId(result.id)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unknown error.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen bg-transparent">
      {/* Header */}
      <header className="sticky top-0 z-10 glass-header">
        <div className="mx-auto flex h-14 max-w-[1800px] items-center justify-between px-8">
          <div className="flex items-center gap-2">
            <Rocket className="size-5 text-primary" />
            <span className="text-base font-semibold">Dataset Generator</span>
          </div>
          <div className="flex items-center gap-3">
            {model && (
              <span className="hidden text-xs text-muted-foreground sm:block font-mono">
                {model}
              </span>
            )}
            <Link href="/history">
              <Button variant="outline" size="sm">
                <History className="size-4" />
                History
              </Button>
            </Link>
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="size-4" />
              Settings
            </Button>
          </div>
        </div>
      </header>

      {/* 2-column layout */}
      <div className="mx-auto grid max-w-[1800px] grid-cols-1 gap-6 px-8 py-8 xl:grid-cols-[1fr_400px]">

        {/* Left column — categories */}
        <div className="min-w-0">
          {!model && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
              <AlertCircle className="size-4 shrink-0" />
              Open <strong className="mx-1">Settings</strong> to enter your API key and select a model.
            </div>
          )}
          <CategoryList
            categories={categories}
            onChange={setCategories}
            modelOptions={toGroupedOptions(modelList)}
          />
        </div>

        {/* Right column — parameters (sticky on xl) */}
        <div className="space-y-5 xl:sticky xl:top-20 xl:self-start">
          {createdJobId ? (
            <JobDashboard jobId={createdJobId} onReset={() => updateJobId(null)} judgeThreshold={activeJobThreshold} />
          ) : (
            <>
              <GlobalControls
                temperature={temperature}
                maxTokens={maxTokens}
                totalExamples={totalExamples}
                conversationTurns={conversationTurns}
                format={format}
                onTemperatureChange={setTemperature}
                onMaxTokensChange={setMaxTokens}
                onTotalExamplesChange={setTotalExamples}
                onConversationTurnsChange={setConversationTurns}
              />

              <FormatSelector
                value={format}
                onChange={(f) => {
                  const next = f as ExportFormat
                  setFormat(next)
                  if (next === 'alpaca') setConversationTurns(1)
                }}
              />

              {/* Submit */}
              <div className="space-y-3">
                {submitError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    {submitError}
                  </div>
                )}
                <Button
                  onClick={handleStart}
                  disabled={isSubmitting || !isValid()}
                  size="lg"
                  className="w-full btn-cta"
                >
                  {isSubmitting ? 'Starting…' : 'Generate dataset'}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  {categories.length > 0 ? (
                    <>
                      {`${categories.length} ${categories.length === 1 ? 'category' : 'categories'} · ${totalExamples.toLocaleString('en-US')} examples · ${format.toUpperCase()}`}
                      {estimatedCost != null && (
                        <span> · est. ${estimatedCost < 0.001 ? estimatedCost.toFixed(5) : estimatedCost.toFixed(4)}</span>
                      )}
                    </>
                  ) : (
                    'Select categories from the list on the left'
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      <SettingsDialog
        open={settingsOpen}
        judgeProvider={judgeProvider}
        onModelPricingChange={setModelPricing}
        onJudgePricingChange={setJudgePricing}
        onJudgeProviderChange={setJudgeProvider}
        onClose={() => {
          setSettingsOpen(false)
          // Re-sync config from backend after settings saved
          getConfig().then((config) => {
            setJudgeEnabled(config.judge_enabled)
            setJudgeModel(config.judge_model)
            setJudgeThreshold(config.judge_threshold)
            setConversationTurns(config.conversation_turns)
            setJudgeCriteria(config.judge_criteria)
            setJudgeProvider(config.judge_provider ?? '')
          }).catch(() => {/* non-fatal */})
          // Re-fetch models if list is empty (e.g. after adding API key for the first time)
          if (modelList.length === 0) {
            getApiKey().then((status) => {
              if (status.has_key) getModels().then(setModelList).catch(() => {})
            }).catch(() => {})
          }
        }}
        model={model}
        onModelChange={setModel}
      />
    </main>
  )
}
