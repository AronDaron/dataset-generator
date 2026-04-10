'use client'

import { useEffect, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiKeySection } from './ApiKeySection'
import { ConfigSection } from './ConfigSection'
import { getApiKey, getConfig, putConfig } from '@/lib/api'
import { cn } from '@/lib/utils'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  model: string
  onModelChange: (model: string) => void
}

export function SettingsDialog({
  open,
  onClose,
  model,
  onModelChange,
}: SettingsDialogProps) {
  const [hasKey, setHasKey] = useState(false)
  const [keyPreview, setKeyPreview] = useState<string | null>(null)
  const [delay, setDelay] = useState(2)
  const [retryCount, setRetryCount] = useState(3)
  const [retryCooldown, setRetryCooldown] = useState(15) // preserved, not exposed in UI
  const [localModel, setLocalModel] = useState(model)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Load current settings when dialog opens
  useEffect(() => {
    if (!open) return
    setSaveError(null)
    setSaveSuccess(false)
    setLocalModel(model)

    Promise.all([getApiKey(), getConfig()])
      .then(([keyStatus, config]) => {
        setHasKey(keyStatus.has_key)
        setKeyPreview(keyStatus.key_preview)
        setDelay(config.delay_between_requests)
        setRetryCount(config.retry_count)
        setRetryCooldown(config.retry_cooldown)
        if (config.default_model && !model) {
          setLocalModel(config.default_model)
        }
      })
      .catch(() => {
        // non-fatal: settings will be empty
      })
  }, [open]) // intentionally omit `model` — sync only on open

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      await putConfig({
        delay_between_requests: delay,
        retry_count: retryCount,
        retry_cooldown: retryCooldown,
        default_model: localModel,
      })
      onModelChange(localModel)
      setSaveSuccess(true)
      setTimeout(() => {
        setSaveSuccess(false)
        onClose()
      }, 800)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Błąd zapisu ustawień')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        />
        <Dialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
            'max-h-[90vh] overflow-y-auto',
            'rounded-xl bg-background ring-1 ring-border shadow-xl',
            'p-6',
          )}
        >
          {/* Header */}
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold">
              Ustawienia
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon">
                  <X className="size-4" />
                </Button>
              }
            />
          </div>

          {/* Content */}
          <div className="space-y-4">
            <ApiKeySection
              hasKey={hasKey}
              keyPreview={keyPreview}
              onKeyChange={(hk, preview) => {
                setHasKey(hk)
                setKeyPreview(preview)
              }}
            />
            <ConfigSection
              model={localModel}
              delay={delay}
              retryCount={retryCount}
              onModelChange={setLocalModel}
              onDelayChange={setDelay}
              onRetryChange={setRetryCount}
              hasApiKey={hasKey}
            />
          </div>

          {/* Footer */}
          <div className="mt-5 flex items-center justify-end gap-2">
            {saveError && (
              <p className="mr-auto text-sm text-destructive">{saveError}</p>
            )}
            {saveSuccess && (
              <p className="mr-auto text-sm text-green-600">Zapisano!</p>
            )}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Anuluj
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Zapisuję...' : 'Zapisz ustawienia'}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
