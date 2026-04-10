'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SelectField, type SelectOption } from '@/components/ui/select'
import { getModels } from '@/lib/api'

interface ConfigSectionProps {
  model: string
  delay: number
  retryCount: number
  onModelChange: (model: string) => void
  onDelayChange: (delay: number) => void
  onRetryChange: (retry: number) => void
  hasApiKey: boolean
}

export function ConfigSection({
  model,
  delay,
  retryCount,
  onModelChange,
  onDelayChange,
  onRetryChange,
  hasApiKey,
}: ConfigSectionProps) {
  const [models, setModels] = useState<SelectOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  useEffect(() => {
    if (!hasApiKey) return
    setLoadingModels(true)
    setModelsError(null)
    getModels()
      .then((list) =>
        setModels(list.map((m) => ({ value: m.id, label: m.name || m.id }))),
      )
      .catch(() => setModelsError('Nie udało się załadować modeli'))
      .finally(() => setLoadingModels(false))
  }, [hasApiKey])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ustawienia generowania</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Model selection */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Model</label>
          {!hasApiKey ? (
            <p className="text-sm text-muted-foreground">
              Ustaw klucz API, aby załadować dostępne modele.
            </p>
          ) : (
            <>
              <SelectField
                value={model}
                onChange={onModelChange}
                options={models}
                placeholder="Wybierz model..."
                isLoading={loadingModels}
              />
              {modelsError && (
                <p className="text-xs text-destructive">{modelsError}</p>
              )}
            </>
          )}
        </div>

        {/* Delay */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Opóźnienie między zapytaniami
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={60}
              value={delay}
              onChange={(e) =>
                onDelayChange(Math.max(0, Math.min(60, Number(e.target.value))))
              }
              className="w-20 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <span className="text-sm text-muted-foreground">sekund</span>
          </div>
        </div>

        {/* Retry count */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Liczba ponownych prób przy błędzie API
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={10}
              value={retryCount}
              onChange={(e) =>
                onRetryChange(Math.max(1, Math.min(10, Number(e.target.value))))
              }
              className="w-20 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <span className="text-sm text-muted-foreground">
              (cooldown 15s przy 429/500)
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
