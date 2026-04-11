'use client'

import { Select } from '@base-ui/react/select'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
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
  const selectedLabel =
    options.find((o) => o.value === value)?.label ?? placeholder

  return (
    <Select.Root
      value={value || null}
      onValueChange={(v) => onChange(v as string)}
      disabled={disabled || isLoading}
    >
      <Select.Trigger
        className={cn(
          'inline-flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm',
          'outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:opacity-50',
          'aria-expanded:border-ring',
          className,
        )}
      >
        <span className={cn('truncate', !value && 'text-muted-foreground')}>
          {isLoading ? 'Loading models...' : selectedLabel}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </Select.Trigger>

      <Select.Portal>
        <Select.Positioner sideOffset={4} className="z-[200]">
          <Select.Popup
            className={cn(
              'w-[var(--anchor-width)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg',
              'outline-none',
            )}
          >
            <Select.List className="max-h-60 overflow-y-auto p-1">
              {options.map((opt) => (
                <Select.Item
                  key={opt.value}
                  value={opt.value}
                  className={cn(
                    'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none',
                    'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
                    'data-[selected]:font-medium',
                  )}
                >
                  <Select.ItemIndicator className="flex size-4 items-center justify-center">
                    <Check className="size-3" />
                  </Select.ItemIndicator>
                  <Select.ItemText>{opt.label}</Select.ItemText>
                </Select.Item>
              ))}
              {options.length === 0 && !isLoading && (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
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
