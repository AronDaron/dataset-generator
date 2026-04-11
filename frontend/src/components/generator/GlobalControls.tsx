'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SliderField } from '@/components/ui/slider'

interface GlobalControlsProps {
  temperature: number
  maxTokens: number
  totalExamples: number
  onTemperatureChange: (v: number) => void
  onMaxTokensChange: (v: number) => void
  onTotalExamplesChange: (v: number) => void
}

export function GlobalControls({
  temperature,
  maxTokens,
  totalExamples,
  onTemperatureChange,
  onMaxTokensChange,
  onTotalExamplesChange,
}: GlobalControlsProps) {
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
    </div>
  )
}
