'use client'

import { Card, CardContent } from '@/components/ui/card'
import { SliderField } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

const TURNS_LABEL: Record<number, string> = {
  1: 'Single Q&A',
  2: 'One follow-up',
  3: 'Short exchange',
  4: 'Long conversation',
  5: 'Extended conversation',
}

interface GlobalControlsProps {
  temperature: number
  maxTokens: number
  totalExamples: number
  conversationTurns: number
  format: string
  cleanupEnabled: boolean
  onTemperatureChange: (v: number) => void
  onMaxTokensChange: (v: number) => void
  onTotalExamplesChange: (v: number) => void
  onConversationTurnsChange: (v: number) => void
  onCleanupEnabledChange: (v: boolean) => void
}

export function GlobalControls({
  temperature,
  maxTokens,
  totalExamples,
  conversationTurns,
  format,
  cleanupEnabled,
  onTemperatureChange,
  onMaxTokensChange,
  onTotalExamplesChange,
  onConversationTurnsChange,
  onCleanupEnabledChange,
}: GlobalControlsProps) {
  const isAlpaca = format === 'alpaca'

  return (
    <div>
      <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-widest text-text-3">
        Parameters
      </p>
      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border/40">
            {/* Temperature */}
            <div className="px-4 py-3.5">
              <SliderField
                value={temperature}
                onValueChange={onTemperatureChange}
                min={0}
                max={1.5}
                step={0.05}
                label="Temperature"
                displayValue={temperature.toFixed(2)}
                sublabel="Precise ↔ Creative"
              />
            </div>

            {/* Max tokens */}
            <div className="px-4 py-3.5">
              <SliderField
                value={maxTokens}
                onValueChange={onMaxTokensChange}
                min={512}
                max={8192}
                step={128}
                label="Max tokens"
                displayValue={maxTokens.toLocaleString('en-US')}
                hint="Target for output content. The actual API budget is 2× this value — the overflow absorbs reasoning tokens (<think> blocks) so content still fits. Non-reasoning models naturally stop near this target."
              />
            </div>

            {/* Total examples */}
            <div className="px-4 py-3.5">
              <SliderField
                value={totalExamples}
                onValueChange={onTotalExamplesChange}
                min={10}
                max={10000}
                step={10}
                label="Examples"
                displayValue={totalExamples.toLocaleString('en-US')}
              />
            </div>

            {/* Conversation turns */}
            <div className={cn('px-4 py-3.5', isAlpaca && 'opacity-50')}>
              <SliderField
                value={conversationTurns}
                onValueChange={onConversationTurnsChange}
                min={1}
                max={5}
                step={1}
                label="Turns"
                displayValue={`${conversationTurns} — ${TURNS_LABEL[conversationTurns] ?? ''}`}
                disabled={isAlpaca}
              />
              {isAlpaca && (
                <p className="mt-1.5 text-xs text-text-3">
                  Locked to 1 for Alpaca format
                </p>
              )}
            </div>

            {/* Cleanup — per-run switch, not a slider, so the whole row toggles */}
            <button
              type="button"
              aria-pressed={cleanupEnabled}
              onClick={() => onCleanupEnabledChange(!cleanupEnabled)}
              className="flex w-full items-center justify-between px-4 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text-0">Cleanup</span>
                <span className="mt-0.5 block text-xs text-text-3">
                  Removes format defects · extra API cost
                </span>
              </span>
              <span
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors',
                  cleanupEnabled ? 'bg-primary' : 'bg-muted',
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none block size-4 rounded-full bg-text-0 shadow transition-transform',
                    cleanupEnabled ? 'translate-x-4' : 'translate-x-0',
                  )}
                />
              </span>
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
