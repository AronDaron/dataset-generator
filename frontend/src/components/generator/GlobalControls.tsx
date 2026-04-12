'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SliderField } from '@/components/ui/slider'

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
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Generation parameters</h2>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Response diversity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SliderField
            value={temperature}
            onValueChange={onTemperatureChange}
            min={0}
            max={1.5}
            step={0.05}
            label="Temperatura"
            displayValue={temperature.toFixed(2)}
            sublabel="Closer to instructions ↔ More diverse"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Context length (max tokens per example)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SliderField
            value={maxTokens}
            onValueChange={onMaxTokensChange}
            min={512}
            max={8192}
            step={128}
            label="Max tokens"
            displayValue={`${maxTokens.toLocaleString('en-US')} tokens`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Dataset size
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SliderField
            value={totalExamples}
            onValueChange={onTotalExamplesChange}
            min={10}
            max={10000}
            step={10}
            label="Number of examples"
            displayValue={totalExamples.toLocaleString('en-US')}
          />
        </CardContent>
      </Card>

      <Card className={isAlpaca ? 'opacity-50' : ''}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Conversation turns
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SliderField
            value={conversationTurns}
            onValueChange={onConversationTurnsChange}
            min={1}
            max={5}
            step={1}
            label={TURNS_LABEL[conversationTurns] ?? ''}
            displayValue={String(conversationTurns)}
            disabled={isAlpaca}
          />
          <p className="text-xs text-muted-foreground mt-2">
            {isAlpaca
              ? 'Alpaca supports single Q&A only — conversation turns locked to 1'
              : 'More turns = longer examples · each extra turn adds ~300–500 tokens'}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
