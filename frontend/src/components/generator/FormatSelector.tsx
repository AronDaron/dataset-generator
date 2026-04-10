'use client'

import { Button } from '@/components/ui/button'

type ExportFormat = 'sharegpt' | 'alpaca' | 'chatml'

const FORMATS: { value: ExportFormat; label: string; description: string }[] =
  [
    {
      value: 'sharegpt',
      label: 'ShareGPT',
      description: 'Wieloturowe rozmowy human/gpt',
    },
    {
      value: 'alpaca',
      label: 'Alpaca',
      description: 'Instruction / Input / Output',
    },
    {
      value: 'chatml',
      label: 'ChatML',
      description: 'Wieloturowe user/assistant',
    },
  ]

interface FormatSelectorProps {
  value: ExportFormat
  onChange: (format: ExportFormat) => void
}

export function FormatSelector({ value, onChange }: FormatSelectorProps) {
  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold">Format eksportu</h2>
      <div className="flex gap-2 flex-wrap">
        {FORMATS.map((f) => (
          <button
            key={f.value}
            onClick={() => onChange(f.value)}
            className={`flex-1 min-w-[120px] rounded-lg border px-4 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
              value === f.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background hover:bg-muted'
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
