'use client'

import { Button } from '@/components/ui/button'

type ExportFormat = 'sharegpt' | 'alpaca' | 'chatml'

const FORMATS: { value: ExportFormat; label: string; description: string }[] =
  [
    {
      value: 'sharegpt',
      label: 'ShareGPT',
      description: 'Multi-turn human/gpt conversations',
    },
    {
      value: 'alpaca',
      label: 'Alpaca',
      description: 'Instruction / Input / Output',
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
      <h2 className="text-base font-semibold">Export format</h2>
      <div className="flex gap-2 flex-wrap">
        {FORMATS.map((f) => (
          <button
            key={f.value}
            onClick={() => onChange(f.value)}
            className={`flex-1 min-w-[120px] rounded-lg border px-4 py-3 text-left transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
              value === f.value
                ? 'border-primary/42 bg-primary/55 text-primary-foreground shadow-md shadow-primary/14 backdrop-blur-md'
                : 'border-white/8 bg-white/5 hover:bg-white/10 backdrop-blur-sm'
            }`}
          >
            <div className="text-sm font-medium">{f.label}</div>
            <div
              className={`text-xs mt-0.5 ${
                value === f.value
                  ? 'text-primary-foreground/70'
                  : 'text-muted-foreground'
              }`}
            >
              {f.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
