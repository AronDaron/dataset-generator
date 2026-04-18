'use client'

import { useState } from 'react'
import { Trash2, AlertCircle, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { saveHfToken, deleteHfToken } from '@/lib/api'

interface HfTokenSectionProps {
  hasToken: boolean
  tokenPreview: string | null
  onTokenChange: (hasToken: boolean, preview: string | null) => void
}

export function HfTokenSection({
  hasToken,
  tokenPreview,
  onTokenChange,
}: HfTokenSectionProps) {
  const [inputToken, setInputToken] = useState('')
  const [showInput, setShowInput] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!inputToken.trim()) return
    setSaving(true)
    setError(null)
    try {
      await saveHfToken(inputToken.trim())
      const preview = '...' + inputToken.trim().slice(-4)
      onTokenChange(true, preview)
      setInputToken('')
      setShowInput(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      await deleteHfToken()
      onTokenChange(false, null)
      setShowInput(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete token')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-text-3">
        HuggingFace Token
      </p>

      {hasToken && !showInput ? (
        <div className="flex items-center gap-3 rounded-lg border border-transparent bg-ok/10 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-ok shadow-[0_0_6px_var(--color-ok)]" />
            <span className="text-sm font-medium text-ok">Connected</span>
            <span className="truncate font-mono text-sm text-text-2">{tokenPreview ?? '...'}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setShowInput(true)}>
              Change
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              <Trash2 className="size-3.5" />
              {deleting ? 'Removing...' : 'Remove'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="password"
              value={inputToken}
              onChange={(e) => setInputToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="hf_..."
              autoFocus
              className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-text-0 outline-none placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <Button onClick={handleSave} disabled={saving || !inputToken.trim()} size="sm">
              {saving ? 'Saving...' : 'Save'}
            </Button>
            {hasToken && (
              <Button variant="ghost" size="sm" onClick={() => setShowInput(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2.5 text-xs text-text-3">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Stored locally on your device. Required for uploading datasets to HuggingFace Hub.
          Get your token at huggingface.co/settings/tokens.
        </span>
      </div>
    </div>
  )
}
