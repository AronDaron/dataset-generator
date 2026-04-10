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
      <h2 className="text-base font-semibold">Parametry generowania</h2>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Różnorodność odpowiedzi
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
            sublabel="Zbliżone do założeń ↔ Różnorodne"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Długość kontekstu (max tokenów na przykład)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SliderField
            value={maxTokens}
            onValueChange={onMaxTokensChange}
            min={512}
            max={8192}
            step={128}
            label="Max tokenów"
            displayValue={`${maxTokens.toLocaleString('pl-PL')} tokenów`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Rozmiar datasetu
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SliderField
            value={totalExamples}
            onValueChange={onTotalExamplesChange}
            min={10}
            max={10000}
            step={10}
            label="Liczba przykładów"
            displayValue={totalExamples.toLocaleString('pl-PL')}
          />
        </CardContent>
      </Card>
    </div>
  )
}
