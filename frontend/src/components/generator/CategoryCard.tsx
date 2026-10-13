'use client'

import { Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SliderField } from '@/components/ui/slider'
import { SelectField, type SelectOption } from '@/components/ui/select'
import type { Category } from '@/lib/proportions'
import { useProviderOptions } from '@/hooks/useProviderOptions'
import { CATEGORY_COLORS, CATEGORY_COLOR_HEX } from './CategoryList'

interface CategoryCardProps {
  category: Category
  index: number
  totalCategories: number
  canRemove: boolean
  modelOptions?: SelectOption[]
  judgeEnabled?: boolean
  cleanupEnabled?: boolean
  onUpdate: (id: string, patch: Partial<Omit<Category, 'id'>>) => void
  onRemove: (id: string) => void
  onProportionChange: (id: string, value: number) => void
}

const USE_GLOBAL_OPTION: SelectOption = { value: '', label: '— Global model —' }
const USE_GLOBAL_JUDGE_OPTION: SelectOption = { value: '', label: '— Global judge —' }
const USE_GLOBAL_CLEANUP_OPTION: SelectOption = { value: '', label: '— Global cleanup —' }
const AUTO_PROVIDER_OPTION: SelectOption = { value: '', label: '— Auto —' }

export function CategoryCard({
  category,
  index,
  totalCategories,
  canRemove,
  modelOptions = [],
  judgeEnabled = false,
  cleanupEnabled = false,
  onUpdate,
  onRemove,
  onProportionChange,
}: CategoryCardProps) {
  const maxProportion = 100 - (totalCategories - 1)
  const colorHex = CATEGORY_COLOR_HEX[index % CATEGORY_COLOR_HEX.length]

  const { options: providerOptions, loading: loadingProviders } =
    useProviderOptions(category.model)
  const { options: judgeProviderOptions, loading: loadingJudgeProviders } =
    useProviderOptions(category.judgeModel)
  const { options: cleanupProviderOptions, loading: loadingCleanupProviders } =
    useProviderOptions(category.cleanupModel)

  function handleModelChange(val: string) {
    onUpdate(category.id, { model: val || undefined, provider: undefined })
  }

  function handleProviderChange(val: string) {
    onUpdate(category.id, { provider: val || undefined })
  }

  function handleJudgeModelChange(val: string) {
    onUpdate(category.id, { judgeModel: val || undefined, judgeProvider: undefined })
  }

  function handleJudgeProviderChange(val: string) {
    onUpdate(category.id, { judgeProvider: val || undefined })
  }

  function handleCleanupModelChange(val: string) {
    onUpdate(category.id, { cleanupModel: val || undefined, cleanupProvider: undefined })
  }

  function handleCleanupProviderChange(val: string) {
    onUpdate(category.id, { cleanupProvider: val || undefined })
  }

  const modelSelectOptions: SelectOption[] =
    modelOptions.length > 0 ? [USE_GLOBAL_OPTION, ...modelOptions] : []

  const providerSelectOptions: SelectOption[] =
    providerOptions.length > 0 ? [AUTO_PROVIDER_OPTION, ...providerOptions] : []

  const judgeModelSelectOptions: SelectOption[] =
    modelOptions.length > 0 ? [USE_GLOBAL_JUDGE_OPTION, ...modelOptions] : []

  const judgeProviderSelectOptions: SelectOption[] =
    judgeProviderOptions.length > 0 ? [AUTO_PROVIDER_OPTION, ...judgeProviderOptions] : []

  const cleanupModelSelectOptions: SelectOption[] =
    modelOptions.length > 0 ? [USE_GLOBAL_CLEANUP_OPTION, ...modelOptions] : []

  const cleanupProviderSelectOptions: SelectOption[] =
    cleanupProviderOptions.length > 0 ? [AUTO_PROVIDER_OPTION, ...cleanupProviderOptions] : []

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
            className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-semibold text-text-0 outline-none transition-colors placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
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
          rows={3}
          placeholder='Description — e.g. "Q&A about TypeScript patterns"'
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        />

        {/* Model + Provider — always side by side */}
        {modelSelectOptions.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] uppercase tracking-widest font-medium text-text-3">Model</p>
              <SelectField
                value={category.model ?? ''}
                onChange={handleModelChange}
                options={modelSelectOptions}
                placeholder="Global"
              />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] uppercase tracking-widest font-medium text-text-3">Provider</p>
              {category.model ? (
                <SelectField
                  value={category.provider ?? ''}
                  onChange={handleProviderChange}
                  options={providerSelectOptions}
                  placeholder="Auto"
                  isLoading={loadingProviders}
                />
              ) : (
                <div className="flex h-[34px] items-center rounded-lg border border-border bg-muted/40 px-3 text-xs text-text-4 select-none">
                  select model first
                </div>
              )}
            </div>
          </div>
        )}

        {/* Cleanup model + provider (only when cleanup is enabled globally) */}
        {cleanupEnabled && cleanupModelSelectOptions.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] uppercase tracking-widest font-medium text-text-3">Cleanup model</p>
              <SelectField
                value={category.cleanupModel ?? ''}
                onChange={handleCleanupModelChange}
                options={cleanupModelSelectOptions}
                placeholder="Global cleanup"
              />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] uppercase tracking-widest font-medium text-text-3">Cleanup provider</p>
              {category.cleanupModel ? (
                <SelectField
                  value={category.cleanupProvider ?? ''}
                  onChange={handleCleanupProviderChange}
                  options={cleanupProviderSelectOptions}
                  placeholder="Auto"
                  isLoading={loadingCleanupProviders}
                />
              ) : (
                <div className="flex h-[34px] select-none items-center rounded-lg border border-border bg-muted/40 px-3 text-xs text-text-4">
                  select cleanup model first
                </div>
              )}
            </div>
          </div>
        )}

        {/* Judge model + provider (only when judge is enabled globally) */}


        {judgeEnabled && judgeModelSelectOptions.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] uppercase tracking-widest font-medium text-text-3">Judge model</p>
              <SelectField
                value={category.judgeModel ?? ''}
                onChange={handleJudgeModelChange}
                options={judgeModelSelectOptions}
                placeholder="Global judge"
              />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] uppercase tracking-widest font-medium text-text-3">Judge provider</p>
              {category.judgeModel ? (
                <SelectField
                  value={category.judgeProvider ?? ''}
                  onChange={handleJudgeProviderChange}
                  options={judgeProviderSelectOptions}
                  placeholder="Auto"
                  isLoading={loadingJudgeProviders}
                />
              ) : (
                <div className="flex h-[34px] select-none items-center rounded-lg border border-border bg-muted/40 px-3 text-xs text-text-4">
                  select judge model first
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
