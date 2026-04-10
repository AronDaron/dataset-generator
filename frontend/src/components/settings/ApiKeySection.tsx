'use client'

import { useState } from 'react'
import { Key, Trash2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { saveApiKey, deleteApiKey } from '@/lib/api'

interface ApiKeySectionProps {
  hasKey: boolean
  keyPreview: string | null
  onKeyChange: (hasKey: boolean, preview: string | null) => void
}

export function ApiKeySection({
  hasKey,
  keyPreview,
  onKeyChange,
}: ApiKeySectionProps) {
  const [inputKey, setInputKey] = useState('')
  const [showInput, setShowInput] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!inputKey.trim()) return
    setSaving(true)
    setError(null)
    try {
      await saveApiKey(inputKey.trim())
      const preview = '...' + inputKey.trim().slice(-4)
      onKeyChange(true, preview)
      setInputKey('')
      setShowInput(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Błąd zapisu klucza')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      await deleteApiKey()
      onKeyChange(false, null)
      setShowInput(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Błąd usuwania klucza')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Key className="size-4" />
          Klucz API OpenRouter
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasKey && !showInput ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm bg-muted px-2 py-1 rounded">
              {keyPreview ?? '...????'}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowInput(true)}
            >
              Zmień
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              <Trash2 className="size-3.5" />
              {deleting ? 'Usuwanie...' : 'Usuń'}
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="password"
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="sk-or-..."
              className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <Button onClick={handleSave} disabled={saving || !inputKey.trim()} size="sm">
              {saving ? 'Zapisuję...' : 'Zapisz'}
            </Button>
            {hasKey && (
              <Button variant="ghost" size="sm" onClick={() => setShowInput(false)}>
                Anuluj
              </Button>
            )}
          </div>
        )}

        {error && (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="size-3.5" />
            {error}
          </p>
        )}

        <div className="flex items-start gap-1.5 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
          <span>
            Klucz API jest przechowywany lokalnie na Twoim urządzeniu i nigdy
            nie opuszcza Twojego komputera. Ponosisz odpowiedzialność za
            przestrzeganie regulaminu dostawców modeli na OpenRouter.
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
