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
  onTemperatureChange: (v: number) => void
  onMaxTokensChange: (v: number) => void
  onTotalExamplesChange: (v: number) => void
  onConversationTurnsChange: (v: number) => void
}

export function GlobalControls({
  temperature,
  maxTokens,
  totalExamples,
  conversationTurns,
  format,
  onTemperatureChange,
  onMaxTokensChange,
  onTotalExamplesChange,
  onConversationTurnsChange,
}: GlobalControlsProps) {
  const isAlpaca = format === 'alpaca'

  return (
    <div>
      <p className="mb-2.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">
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
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Locked to 1 for Alpaca format
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
