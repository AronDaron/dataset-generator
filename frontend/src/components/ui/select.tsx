'use client'

import { Select } from '@base-ui/react/select'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
  group?: string
  icon?: string
}

interface SelectFieldProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  isLoading?: boolean
  disabled?: boolean
  className?: string
}

export function SelectField({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  isLoading = false,
  disabled = false,
  className,
}: SelectFieldProps) {
  const selectedOption = options.find((o) => o.value === value)
  const selectedLabel = selectedOption?.label ?? placeholder
  const selectedIcon = selectedOption?.icon

  const hasGroups = options.some((o) => o.group)

  const grouped: Array<{ groupName: string; items: SelectOption[] }> = hasGroups
    ? Object.entries(
        options.reduce<Record<string, SelectOption[]>>((acc, opt) => {
          const g = opt.group ?? ''
          ;(acc[g] ??= []).push(opt)
          return acc
        }, {}),
      )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([groupName, items]) => ({ groupName, items }))
    : []

  return (
    <Select.Root
      value={value || null}
      onValueChange={(v) => onChange(v as string)}
      disabled={disabled || isLoading}
    >
      <Select.Trigger
        className={cn(
          'group inline-flex w-full items-center justify-between gap-2 rounded-lg',
          'border border-border bg-background px-3 py-1.5 text-sm text-foreground',
          'transition-colors duration-150',
          'outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
          'hover:bg-muted hover:border-line-strong',
          'aria-expanded:bg-muted aria-expanded:border-line-strong',
          'disabled:pointer-events-none disabled:opacity-40',
          className,
        )}
      >
        <span className={cn('flex min-w-0 items-center gap-1.5', !value && 'text-text-3')}>
          {selectedIcon && !isLoading && (
            <img src={selectedIcon} alt="" className="size-3.5 shrink-0 object-contain opacity-90" />
          )}
          <span className="truncate">{isLoading ? 'Loading…' : selectedLabel}</span>
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-text-3 transition-transform duration-200',
            'group-aria-expanded:rotate-180',
          )}
        />
      </Select.Trigger>

      <Select.Portal>
        <Select.Positioner sideOffset={5} className="z-[200]">
          <Select.Popup
            className={cn(
              'w-[var(--anchor-width)] min-w-[180px] overflow-hidden rounded-xl',
              'border border-border bg-popover text-popover-foreground',
              'shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7),0_8px_20px_rgba(0,0,0,0.35)]',
              'outline-none',
            )}
          >
            <Select.List className="max-h-64 overflow-y-auto p-1">
              {hasGroups
                ? grouped.map(({ groupName, items }) => (
                    <Select.Group key={groupName}>
                      {groupName && (
                        <Select.GroupLabel className="px-2 pt-2 pb-1 text-xs font-semibold uppercase tracking-widest text-text-3">
                          {groupName}
                        </Select.GroupLabel>
                      )}
                      {items.map((opt) => (
                        <SelectItem key={opt.value} opt={opt} />
                      ))}
                    </Select.Group>
                  ))
                : options.map((opt) => <SelectItem key={opt.value} opt={opt} />)}
              {options.length === 0 && !isLoading && (
                <div className="px-2 py-5 text-center text-xs text-text-3">
                  No options
                </div>
              )}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function SelectItem({ opt }: { opt: SelectOption }) {
  return (
    <Select.Item
      value={opt.value}
      title={opt.label}
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none',
        'transition-colors duration-100',
        'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
        'data-[selected]:text-primary',
      )}
    >
      {/* Fixed-width slot — prevents text from jumping when check appears */}
      <span className="flex w-3.5 shrink-0 items-center justify-center">
        <Select.ItemIndicator>
          <Check className="size-3 text-primary" />
        </Select.ItemIndicator>
      </span>
      {opt.icon && (
        <img src={opt.icon} alt="" className="size-3.5 shrink-0 object-contain opacity-80" />
      )}
      <Select.ItemText className="truncate">{opt.label}</Select.ItemText>
    </Select.Item>
  )
}
