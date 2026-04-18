'use client'

import { useState } from 'react'
import { Trash2, AlertCircle, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { saveApiKey, deleteApiKey, testConnection } from '@/lib/api'

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
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null)
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
      setError(err instanceof Error ? err.message : 'Failed to save key')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      await testConnection()
      setTestResult('ok')
    } catch {
      setTestResult('fail')
    } finally {
      setTesting(false)
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
      setError(err instanceof Error ? err.message : 'Failed to delete key')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-text-3">
        OpenRouter API Key
      </p>

      {hasKey && !showInput ? (
        /* Connected state */
        <div className="flex items-center gap-3 rounded-lg border border-transparent bg-ok/10 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-ok shadow-[0_0_6px_var(--color-ok)]" />
            <span className="text-sm font-medium text-ok">Connected</span>
            <span className="truncate font-mono text-sm text-text-2">{keyPreview ?? '…'}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {testResult === 'ok' && (
              <span className="text-xs text-ok">OK ✓</span>
            )}
            {testResult === 'fail' && (
              <span className="text-xs text-destructive">Failed — check key</span>
            )}
            <Button variant="ghost" size="sm" onClick={handleTest} disabled={testing}>
              {testing ? 'Testing…' : 'Test'}
            </Button>
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
              {deleting ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        </div>
      ) : (
        /* Input state */
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="password"
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="sk-or-…"
              autoFocus
              className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-text-0 outline-none placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <Button onClick={handleSave} disabled={saving || !inputKey.trim()} size="sm">
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {hasKey && (
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
          Stored locally on your device — never sent anywhere else.
          You are responsible for complying with OpenRouter's terms of service.
        </span>
      </div>
    </div>
  )
}
