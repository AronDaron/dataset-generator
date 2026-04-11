'use client'

import { useEffect, useState } from 'react'
import { Settings2, Rocket, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { CategoryList } from '@/components/generator/CategoryList'
import { GlobalControls } from '@/components/generator/GlobalControls'
import { FormatSelector } from '@/components/generator/FormatSelector'
import { type Category, toApiProportions } from '@/lib/proportions'
import { getApiKey, getConfig, createJob } from '@/lib/api'
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [createdJobId, setCreatedJobId] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([getApiKey(), getConfig()])
      .then(([keyStatus, config]) => {
        if (config.default_model) setModel(config.default_model)
        setJudgeEnabled(config.judge_enabled)
        setJudgeModel(config.judge_model)
        setJudgeThreshold(config.judge_threshold)
        if (!keyStatus.has_key) setSettingsOpen(true)
      })
      .catch(() => setSettingsOpen(true))
  }, [])

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
    setCreatedJobId(null)

    try {
      const proportionFloats = toApiProportions(categories)
      const result = await createJob({
        categories: categories.map((c, i) => ({
          name: c.name.trim(),
          description: c.description.trim(),
          proportion: proportionFloats[i],
        })),
        total_examples: totalExamples,
        temperature,
        max_tokens: maxTokens,
        model,
        format,
        judge_enabled: judgeEnabled,
        judge_model: judgeModel,
        judge_threshold: judgeThreshold,
      })
      setCreatedJobId(result.id)
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
          <CategoryList categories={categories} onChange={setCategories} />
        </div>

        {/* Right column — parameters (sticky on xl) */}
        <div className="space-y-5 xl:sticky xl:top-20 xl:self-start">
          {createdJobId ? (
            <JobDashboard jobId={createdJobId} onReset={() => setCreatedJobId(null)} judgeThreshold={judgeThreshold} />
          ) : (
            <>
              <GlobalControls
                temperature={temperature}
                maxTokens={maxTokens}
                totalExamples={totalExamples}
                onTemperatureChange={setTemperature}
                onMaxTokensChange={setMaxTokens}
                onTotalExamplesChange={setTotalExamples}
              />

              <FormatSelector value={format} onChange={(f) => setFormat(f as ExportFormat)} />

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
                  className="w-full"
                >
                  {isSubmitting ? 'Starting...' : 'Generate dataset'}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  {categories.length > 0
                    ? `${categories.length} ${categories.length === 1 ? 'category' : 'categories'} · ${totalExamples.toLocaleString('en-US')} examples · ${format.toUpperCase()}`
                    : 'Select categories from the list on the left'}
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
          // Re-sync judge config from backend after settings saved
          getConfig().then((config) => {
            setJudgeEnabled(config.judge_enabled)
            setJudgeModel(config.judge_model)
            setJudgeThreshold(config.judge_threshold)
          }).catch(() => {/* non-fatal */})
        }}
        model={model}
        onModelChange={setModel}
      />
    </main>
  )
}
