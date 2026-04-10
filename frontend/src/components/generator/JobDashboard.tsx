'use client'

import { useEffect, useState } from 'react'
import { CheckCircle, AlertCircle, XCircle, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { CATEGORY_COLORS } from './CategoryList'
import {
  cancelJob,
  openDatasetsFolder,
  type SSEProgressPayload,
  type SSEExample,
} from '@/lib/api'

const STATUS_LABELS: Record<string, string> = {
  pending:    'Oczekuje',
  running:    'Generowanie',
  cancelling: 'Anulowanie…',
  cancelled:  'Anulowano',
  completed:  'Ukończono',
  failed:     'Błąd',
}

const STAGE_LABELS: Record<string, string> = {
  pending:              'Oczekuje na start',
  generating_topics:    'Generowanie tematów',
  generating_examples:  'Generowanie przykładów',
  completed:            'Zakończono',
  cancelled:            'Anulowano',
  failed:               'Błąd generowania',
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed':  return 'text-green-400'
    case 'failed':     return 'text-destructive'
    case 'cancelled':  return 'text-muted-foreground'
    case 'cancelling': return 'text-amber-400'
    case 'running':    return 'text-blue-400'
    default:           return 'text-muted-foreground'
  }
}

function extractPreview(example: SSEExample): string {
  const c = example.content
  // ShareGPT: { conversations: [{ from, value }, ...] }
  if (Array.isArray((c as Record<string, unknown>).conversations)) {
    const first = ((c as Record<string, unknown>).conversations as Record<string, unknown>[])[0]
    if (first?.value) return String(first.value).slice(0, 120)
  }
  // Alpaca: { instruction, input, output }
  if (typeof (c as Record<string, unknown>).instruction === 'string') {
    return String((c as Record<string, unknown>).instruction).slice(0, 120)
  }
  // ChatML: { messages: [{ role, content }, ...] }
  if (Array.isArray((c as Record<string, unknown>).messages)) {
    const first = ((c as Record<string, unknown>).messages as Record<string, unknown>[])[0]
    if (first?.content) return String(first.content).slice(0, 120)
  }
  // Fallback: first string value found
  for (const v of Object.values(c)) {
    if (typeof v === 'string') return v.slice(0, 120)
  }
  return '(brak podglądu)'
}

interface JobDashboardProps {
  jobId: string
  onReset: () => void
}

export function JobDashboard({ jobId, onReset }: JobDashboardProps) {
  const [payload, setPayload] = useState<SSEProgressPayload | null>(null)
  const [sseError, setSseError] = useState<string | null>(null)
  const [isCancelling, setIsCancelling] = useState(false)
  const [isOpeningFolder, setIsOpeningFolder] = useState(false)

  useEffect(() => {
    const es = new EventSource(`http://localhost:8000/api/jobs/${jobId}/stream`)

    function handleEvent(e: MessageEvent) {
      try {
        const data = JSON.parse(e.data) as SSEProgressPayload
        setPayload(data)
        setSseError(null)
      } catch {
        // ignore parse errors
      }
    }

    es.addEventListener('progress', handleEvent)
    es.addEventListener('done', (e) => {
      handleEvent(e)
      es.close()
    })

    es.onerror = () => {
      setSseError('Błąd połączenia z backendem.')
      es.close()
    }

    return () => {
      es.close()
    }
  }, [jobId])

  async function handleCancel() {
    setIsCancelling(true)
    try {
      await cancelJob(jobId)
    } catch (err) {
      console.error('Cancel failed:', err)
    } finally {
      setIsCancelling(false)
    }
  }

  async function handleOpenFolder() {
    setIsOpeningFolder(true)
    try {
      await openDatasetsFolder()
    } catch {
      // Non-fatal — OS may still open the folder; backend logs the error
    } finally {
      setIsOpeningFolder(false)
    }
  }

  const status = payload?.status ?? 'pending'
  const progress = payload?.progress ?? null
  const examples = payload?.examples ?? []
  const isTerminal = ['completed', 'cancelled', 'failed'].includes(status)
  const isRunning = ['pending', 'running', 'cancelling'].includes(status)
  const globalPct = progress
    ? Math.min(100, Math.round((progress.completed / Math.max(1, progress.total_examples)) * 100))
    : 0
  const categoryEntries = progress ? Object.entries(progress.categories) : []

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold">Dashboard postępu</h2>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">{jobId}</p>
      </div>

      {/* SSE error banner */}
      {sseError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1">{sseError}</span>
        </div>
      )}

      {/* Status card */}
      <Card>
        <CardContent className="py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {isRunning && status !== 'cancelling' && (
                <span className="size-2 animate-pulse rounded-full bg-blue-400" />
              )}
              {status === 'cancelling' && (
                <span className="size-2 animate-pulse rounded-full bg-amber-400" />
              )}
              {status === 'completed' && <CheckCircle className="size-4 text-green-400" />}
              {status === 'failed'    && <AlertCircle className="size-4 text-destructive" />}
              {status === 'cancelled' && <XCircle className="size-4 text-muted-foreground" />}
              <span className={`text-sm font-medium ${statusColor(status)}`}>
                {STATUS_LABELS[status] ?? status}
              </span>
            </div>
            {progress?.current_stage && (
              <span className="text-xs text-muted-foreground">
                {STAGE_LABELS[progress.current_stage] ?? progress.current_stage}
              </span>
            )}
          </div>
          {progress?.current_category && isRunning && (
            <p className="mt-1 text-xs text-muted-foreground">
              Kategoria:{' '}
              <span className="font-medium text-foreground">{progress.current_category}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {/* Global progress */}
      <Card>
        <CardContent className="space-y-2 py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Łączny postęp</span>
            <span className="tabular-nums text-muted-foreground">
              {progress?.completed ?? 0}&nbsp;/&nbsp;{progress?.total_examples ?? '—'}
            </span>
          </div>
          <div className="relative h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all duration-500"
              style={{ width: `${globalPct}%` }}
            />
          </div>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>
              Wygenerowano:{' '}
              <span className="font-medium text-foreground">{progress?.completed ?? 0}</span>
            </span>
            <span>
              Pominięto:{' '}
              <span className="font-medium text-foreground">{progress?.skipped ?? 0}</span>
            </span>
            <span className="ml-auto tabular-nums">{globalPct}%</span>
          </div>
        </CardContent>
      </Card>

      {/* Per-category progress */}
      {categoryEntries.length > 0 && (
        <Card>
          <CardContent className="space-y-3 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Postęp kategorii
            </p>
            {categoryEntries.map(([name, cat], i) => {
              const catPct =
                cat.target > 0
                  ? Math.min(100, Math.round((cat.completed / cat.target) * 100))
                  : 0
              const colorClass = CATEGORY_COLORS[i % CATEGORY_COLORS.length]
              return (
                <div key={name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={`size-2 shrink-0 rounded-full ${colorClass}`} />
                      <span className="truncate font-medium">{name}</span>
                      {progress?.current_category === name && isRunning && (
                        <span className="shrink-0 text-blue-400">•</span>
                      )}
                    </div>
                    <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">
                      {cat.completed}/{cat.target}
                    </span>
                  </div>
                  <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${colorClass}`}
                      style={{ width: `${catPct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Live feed */}
      {examples.length > 0 && (
        <Card>
          <CardContent className="space-y-2 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Ostatnie przykłady
            </p>
            <div className="space-y-1.5">
              {examples.map((ex) => (
                <div
                  key={ex.id}
                  className="rounded-md border border-border bg-muted/30 px-3 py-2"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-mono text-xs uppercase text-muted-foreground">
                      {ex.format}
                    </span>
                    <span className="tabular-nums text-xs text-muted-foreground">
                      {ex.tokens} tok.
                    </span>
                  </div>
                  <p className="line-clamp-2 break-words text-xs text-foreground">
                    {extractPreview(ex)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {!payload && !sseError && (
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          Ładowanie danych…
        </div>
      )}

      {/* Action buttons */}
      <div className="space-y-2">
        {status === 'completed' && (
          <Button
            size="lg"
            className="w-full"
            onClick={handleOpenFolder}
            disabled={isOpeningFolder}
          >
            <FolderOpen className="size-4" />
            {isOpeningFolder ? 'Otwieranie…' : 'Otwórz folder z datasetami'}
          </Button>
        )}

        {isTerminal && (
          <Button variant="outline" size="lg" className="w-full" onClick={onReset}>
            Nowe generowanie
          </Button>
        )}

        {sseError && (
          <Button variant="outline" size="lg" className="w-full" onClick={onReset}>
            Powrót
          </Button>
        )}

        {(status === 'pending' || status === 'running') && (
          <Button
            variant="destructive"
            size="lg"
            className="w-full"
            onClick={handleCancel}
            disabled={isCancelling}
          >
            {isCancelling ? 'Anulowanie…' : 'Anuluj generowanie'}
          </Button>
        )}

        {status === 'cancelling' && (
          <Button variant="destructive" size="lg" className="w-full" disabled>
            Anulowanie…
          </Button>
        )}
      </div>
    </div>
  )
}
