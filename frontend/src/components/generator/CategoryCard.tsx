'use client'

import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SliderField } from '@/components/ui/slider'
import { SelectField, type SelectOption } from '@/components/ui/select'
import type { Category } from '@/lib/proportions'
import { getModelEndpoints } from '@/lib/api'
import { CATEGORY_COLORS } from './CategoryList'

interface CategoryCardProps {
  category: Category
  index: number
  totalCategories: number
  canRemove: boolean
  modelOptions?: SelectOption[]
  onUpdate: (id: string, patch: Partial<Omit<Category, 'id'>>) => void
  onRemove: (id: string) => void
  onProportionChange: (id: string, value: number) => void
}

const USE_GLOBAL_OPTION: SelectOption = { value: '', label: '— Use global model —' }
const AUTO_PROVIDER_OPTION: SelectOption = { value: '', label: '— Auto-select provider —' }

export function CategoryCard({
  category,
  index,
  totalCategories,
  canRemove,
  modelOptions = [],
  onUpdate,
  onRemove,
  onProportionChange,
}: CategoryCardProps) {
  const maxProportion = 100 - (totalCategories - 1)
  const color = CATEGORY_COLORS[index % CATEGORY_COLORS.length]

  const [providerOptions, setProviderOptions] = useState<SelectOption[]>([])
  const [loadingProviders, setLoadingProviders] = useState(false)

  // Lazy-fetch providers whenever the per-category model changes
  useEffect(() => {
    const modelId = category.model
    if (!modelId) {
      setProviderOptions([])
      return
    }
    let cancelled = false
    setLoadingProviders(true)
    getModelEndpoints(modelId)
      .then((endpoints) => {
        if (cancelled) return
        const seen = new Set<string>()
        const opts: SelectOption[] = endpoints
          .filter((e) => {
            if (!e.name || seen.has(e.name)) return false
            seen.add(e.name)
            return true
          })
          .map((e) => {
            const displayName = e.provider_name || e.name
            const parts: string[] = [displayName]
            if (e.latency != null) parts.push(`${Math.round(e.latency)}ms`)
            if (e.uptime_last_30m != null)
              parts.push(`${e.uptime_last_30m.toFixed(1)}% up`)
            return { value: e.name, label: parts.join(' · ') }
          })
        setProviderOptions(opts)
      })
      .catch(() => {
        if (!cancelled) setProviderOptions([])
      })
      .finally(() => {
        if (!cancelled) setLoadingProviders(false)
      })
    return () => {
      cancelled = true
    }
  }, [category.model])

  function handleModelChange(val: string) {
    // Reset provider when model changes
    onUpdate(category.id, { model: val || undefined, provider: undefined })
  }

  function handleProviderChange(val: string) {
    onUpdate(category.id, { provider: val || undefined })
  }

  const modelSelectOptions: SelectOption[] =
    modelOptions.length > 0 ? [USE_GLOBAL_OPTION, ...modelOptions] : []

  const providerSelectOptions: SelectOption[] =
    providerOptions.length > 0 ? [AUTO_PROVIDER_OPTION, ...providerOptions] : []

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        {/* Header row */}
        <div className="flex items-center gap-2">
          <span className={`size-2.5 rounded-full shrink-0 ${color}`} />
          <input
            type="text"
            value={category.name}
            onChange={(e) => onUpdate(category.id, { name: e.target.value })}
            maxLength={100}
            placeholder="Category name"
            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-medium outline-none transition-colors placeholder:text-white/25 focus-visible:border-primary/50 focus-visible:bg-white/8 focus-visible:ring-2 focus-visible:ring-primary/20"
          />
          {canRemove && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onRemove(category.id)}
              title="Delete category"
              className="text-muted-foreground hover:text-destructive shrink-0"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>

        {/* Description */}
        <textarea
          value={category.description}
          onChange={(e) => onUpdate(category.id, { description: e.target.value })}
          maxLength={1000}
          rows={2}
          placeholder="Category description (min. 10 characters) — e.g. &quot;Q&amp;A about TypeScript programming&quot;"
          className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none transition-colors text-foreground placeholder:text-white/25 focus-visible:border-primary/50 focus-visible:bg-white/8 focus-visible:ring-2 focus-visible:ring-primary/20"
        />

        {/* Model override (optional) */}
        {modelSelectOptions.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Model override</p>
            <SelectField
              value={category.model ?? ''}
              onChange={handleModelChange}
              options={modelSelectOptions}
              placeholder="— Use global model —"
            />
          </div>
        )}

        {/* Provider picker — lazy, appears after model is chosen */}
        {category.model && (loadingProviders || providerSelectOptions.length > 0) && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Provider</p>
            <SelectField
              value={category.provider ?? ''}
              onChange={handleProviderChange}
              options={providerSelectOptions}
              placeholder="— Auto-select provider —"
              isLoading={loadingProviders}
            />
          </div>
        )}

        {/* Proportion slider */}
        <SliderField
          value={category.proportion}
          onValueChange={(v) => onProportionChange(category.id, v)}
          min={1}
          max={maxProportion}
          step={1}
          label="Share"
          displayValue={`${category.proportion}%`}
        />
      </CardContent>
    </Card>
  )
}
