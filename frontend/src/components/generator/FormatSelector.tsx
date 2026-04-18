'use client'

import { cn } from '@/lib/utils'

type ExportFormat = 'sharegpt' | 'alpaca' | 'chatml'

const FORMATS: { value: ExportFormat; label: string; description: string }[] = [
  {
    value: 'sharegpt',
    label: 'ShareGPT',
    description: 'Multi-turn human/gpt',
  },
  {
    value: 'alpaca',
    label: 'Alpaca',
    description: 'Instruction / Output',
  },
  {
    value: 'chatml',
    label: 'ChatML',
    description: 'Multi-turn user/assistant',
  },
]

interface FormatSelectorProps {
  value: ExportFormat
  onChange: (format: ExportFormat) => void
}

export function FormatSelector({ value, onChange }: FormatSelectorProps) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-text-3">
        Export format
      </p>
      <div className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-bg-0 p-1">
        {FORMATS.map((f) => {
          const active = value === f.value
          return (
            <button
              key={f.value}
              onClick={() => onChange(f.value)}
              className={cn(
                'flex flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 outline-none',
                'focus-visible:ring-2 focus-visible:ring-ring/40',
                active
                  ? 'bg-accent-soft'
                  : 'hover:bg-muted',
              )}
            >
              <span
                className={cn(
                  'text-sm font-semibold tracking-tight transition-colors',
                  active ? 'text-primary' : 'text-text-2',
                )}
              >
                {f.label}
              </span>
              <span
                className={cn(
                  'text-xs leading-tight transition-colors',
                  active ? 'text-primary/70' : 'text-text-3',
                )}
              >
                {f.description}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
