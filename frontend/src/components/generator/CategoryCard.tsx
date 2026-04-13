'use client'

import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SliderField } from '@/components/ui/slider'
import { SelectField, type SelectOption } from '@/components/ui/select'
import type { Category } from '@/lib/proportions'
import { getModelEndpoints } from '@/lib/api'
import { CATEGORY_COLORS, CATEGORY_COLOR_HEX } from './CategoryList'

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

const USE_GLOBAL_OPTION: SelectOption = { value: '', label: '— Global model —' }
const AUTO_PROVIDER_OPTION: SelectOption = { value: '', label: '— Auto —' }

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
  const colorHex = CATEGORY_COLOR_HEX[index % CATEGORY_COLOR_HEX.length]

  const [providerOptions, setProviderOptions] = useState<SelectOption[]>([])
  const [loadingProviders, setLoadingProviders] = useState(false)

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
            const key = e.provider_name || e.name
            if (!key || seen.has(key)) return false
            seen.add(key)
            return true
          })
          .map((e) => {
            const routingName = e.provider_name || e.name
            const parts: string[] = [routingName]
            if (e.latency != null) parts.push(`${Math.round(e.latency)}ms`)
            if (e.uptime_last_30m != null)
              parts.push(`${e.uptime_last_30m.toFixed(1)}% up`)
            return { value: routingName, label: parts.join(' · ') }
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
    <Card
      className="category-card border-l-[3px] overflow-hidden"
      style={{ borderLeftColor: colorHex, '--cat-color': colorHex } as React.CSSProperties}
    >
      <CardContent className="pt-3.5 pb-3.5 space-y-3">
        {/* Name row */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={category.name}
            onChange={(e) => onUpdate(category.id, { name: e.target.value })}
            maxLength={100}
            placeholder="Category name"
            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-semibold outline-none transition-colors placeholder:text-white/25 focus-visible:border-primary/50 focus-visible:bg-white/8 focus-visible:ring-2 focus-visible:ring-primary/20"
          />
          {canRemove && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onRemove(category.id)}
              title="Delete category"
              className="shrink-0 text-muted-foreground hover:text-destructive"
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
          placeholder='Description — e.g. "Q&A about TypeScript patterns"'
          className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none transition-colors text-foreground placeholder:text-white/25 focus-visible:border-primary/50 focus-visible:bg-white/8 focus-visible:ring-2 focus-visible:ring-primary/20"
        />

        {/* Model + Provider — always side by side */}
        {modelSelectOptions.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">Model</p>
              <SelectField
                value={category.model ?? ''}
                onChange={handleModelChange}
                options={modelSelectOptions}
                placeholder="Global"
              />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">Provider</p>
              {category.model ? (
                <SelectField
                  value={category.provider ?? ''}
                  onChange={handleProviderChange}
                  options={providerSelectOptions}
                  placeholder="Auto"
                  isLoading={loadingProviders}
                />
              ) : (
                <div className="flex h-[34px] items-center rounded-lg border border-white/8 bg-white/3 px-3 text-xs text-white/20 select-none">
                  select model first
                </div>
              )}
            </div>
          </div>
        )}

        {/* Share slider */}
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
