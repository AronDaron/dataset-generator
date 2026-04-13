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
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">
        Export format
      </p>
      <div className="grid grid-cols-3 gap-1 rounded-xl border border-white/7 bg-black/25 p-1">
        {FORMATS.map((f) => {
          const active = value === f.value
          return (
            <button
              key={f.value}
              onClick={() => onChange(f.value)}
              className={cn(
                'flex flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-all duration-150 outline-none',
                'focus-visible:ring-2 focus-visible:ring-primary/50',
                active
                  ? [
                      'bg-primary/14 ring-1 ring-primary/30',
                      'shadow-[0_0_16px_oklch(0.65_0.22_292/0.18),inset_0_1px_0_oklch(1_0_0/0.07)]',
                    ]
                  : 'hover:bg-white/4 text-foreground/50 hover:text-foreground/75',
              )}
            >
              <span
                className={cn(
                  'text-sm font-semibold tracking-tight transition-colors',
                  active ? 'text-primary' : 'text-foreground/65',
                )}
              >
                {f.label}
              </span>
              <span
                className={cn(
                  'text-[11px] leading-tight transition-colors',
                  active ? 'text-primary/55' : 'text-muted-foreground/60',
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
