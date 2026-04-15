'use client'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000'

import { useEffect, useState } from 'react'
import { CheckCircle2, AlertCircle, XCircle, FolderOpen, RotateCcw, StopCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CATEGORY_COLORS } from './CategoryList'
import {
  cancelJob,
  openDatasetsFolder,
  type SSEProgressPayload,
  type SSEExample,
} from '@/lib/api'

const STATUS_LABELS: Record<string, string> = {
  pending:    'Pending',
  running:    'Running',
  cancelling: 'Cancelling…',
  cancelled:  'Cancelled',
  completed:  'Completed',
  failed:     'Failed',
}

const STAGE_LABELS: Record<string, string> = {
  pending:             'Awaiting start',
  generating_topics:   'Generating topics',
  generating_examples: 'Generating examples',
  judge_evaluating:    'Evaluating…',
  completed:           'Completed',
  cancelled:           'Cancelled',
  failed:              'Generation error',
}

interface StatusStyle {
  wrapper: string
  dot: string
  label: string
}

function getStatusStyle(status: string): StatusStyle {
  switch (status) {
    case 'completed':
      return {
        wrapper: 'border-emerald-500/25 bg-emerald-500/8 shadow-[0_0_16px_oklch(0.72_0.21_142/0.12)]',
        dot: '',
        label: 'text-emerald-400',
      }
    case 'failed':
      return {
        wrapper: 'border-red-500/25 bg-red-500/8 shadow-[0_0_16px_oklch(0.63_0.22_22/0.12)]',
        dot: '',
        label: 'text-red-400',
      }
    case 'cancelled':
      return {
        wrapper: 'border-border bg-white/3',
        dot: '',
        label: 'text-muted-foreground',
      }
    case 'cancelling':
      return {
        wrapper: 'border-amber-500/25 bg-amber-500/8',
        dot: 'bg-amber-400',
        label: 'text-amber-400',
      }
    case 'running':
      return {
        wrapper: 'border-blue-500/25 bg-blue-500/8 shadow-[0_0_16px_oklch(0.62_0.20_228/0.10)]',
        dot: 'bg-blue-400',
        label: 'text-blue-400',
      }
    default:
      return {
        wrapper: 'border-border bg-white/3',
        dot: 'bg-muted-foreground',
        label: 'text-muted-foreground',
      }
  }
}

function StatChip({
  label,
  value,
  variant = 'default',
}: {
  label: string
  value: string | number
  variant?: 'default' | 'success' | 'warn' | 'danger'
}) {
  const valueClass =
    variant === 'success' ? 'text-emerald-400' :
    variant === 'warn'    ? 'text-amber-400' :
    variant === 'danger'  ? 'text-red-400' :
    'text-foreground'

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-white/8 bg-white/4 px-2.5 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-mono font-semibold tabular-nums', valueClass)}>{value}</span>
    </span>
  )
}

function extractPreview(example: SSEExample): string {
  const c = example.content
  if (c == null || typeof c !== 'object' || Array.isArray(c)) return '(no preview)'
  const obj = c as Record<string, unknown>
  if (Array.isArray(obj.conversations)) {
    const first = (obj.conversations as Record<string, unknown>[])[0]
    if (first?.value) return String(first.value).slice(0, 120)
  }
  if (typeof obj.instruction === 'string') return obj.instruction.slice(0, 120)
  if (Array.isArray(obj.messages)) {
    const first = (obj.messages as Record<string, unknown>[])[0]
    if (first?.content) return String(first.content).slice(0, 120)
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') return v.slice(0, 120)
  }
  return '(no preview)'
}

interface JobDashboardProps {
  jobId: string
  onReset: () => void
  judgeThreshold?: number
}

export function JobDashboard({ jobId, onReset, judgeThreshold = 80 }: JobDashboardProps) {
  const [payload, setPayload] = useState<SSEProgressPayload | null>(null)
  const [sseError, setSseError] = useState<string | null>(null)
  const [isCancelling, setIsCancelling] = useState(false)
  const [isOpeningFolder, setIsOpeningFolder] = useState(false)

  useEffect(() => {
    const es = new EventSource(`${BACKEND_URL}/api/jobs/${jobId}/stream`)

    function handleEvent(e: MessageEvent) {
      try {
        const data = JSON.parse(e.data) as SSEProgressPayload
        setPayload(data)
        setSseError(null)
      } catch { /* ignore parse errors */ }
    }

    es.addEventListener('progress', handleEvent)
    es.addEventListener('done', (e) => { handleEvent(e); es.close() })
    es.onerror = () => { setSseError('Backend connection error.'); es.close() }

    return () => es.close()
  }, [jobId])

  async function handleCancel() {
    setIsCancelling(true)
    try { await cancelJob(jobId) } catch { /* non-fatal */ } finally { setIsCancelling(false) }
  }

  async function handleOpenFolder() {
    setIsOpeningFolder(true)
    try { await openDatasetsFolder() } catch { /* non-fatal */ } finally { setIsOpeningFolder(false) }
  }

  const status = payload?.status ?? 'pending'
  const progress = payload?.progress ?? null
  const examples = payload?.examples ?? []
  const isTerminal = ['completed', 'cancelled', 'failed'].includes(status)
  const isRunning  = ['pending', 'running', 'cancelling'].includes(status)
  const globalPct  = progress
    ? Math.min(100, Math.round((progress.completed / Math.max(1, progress.total_examples)) * 100))
    : 0
  const categoryEntries = progress ? Object.entries(progress.categories) : []
  const style = getStatusStyle(status)

  return (
    <div className="space-y-3">
      {/* Job ID */}
      <p className="font-mono text-[10px] text-muted-foreground/50 tracking-wider truncate">{jobId}</p>

      {/* SSE error */}
      {sseError && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1">{sseError}</span>
        </div>
      )}

      {/* Status pill */}
      <div className={cn('flex items-center justify-between rounded-xl border px-4 py-3', style.wrapper)}>
        <div className="flex items-center gap-2.5">
          {style.dot && (
            <span className={cn('size-2.5 shrink-0 rounded-full animate-pulse', style.dot)} />
          )}
          {status === 'completed' && <CheckCircle2 className="size-5 text-emerald-400" />}
          {status === 'failed'    && <AlertCircle  className="size-5 text-red-400" />}
          {status === 'cancelled' && <XCircle      className="size-5 text-muted-foreground" />}
          <span className={cn('font-semibold text-sm', style.label)}>
            {STATUS_LABELS[status] ?? status}
          </span>
        </div>
        {progress?.current_stage && (
          <span className="text-xs text-muted-foreground">
            {STAGE_LABELS[progress.current_stage] ?? progress.current_stage}
          </span>
        )}
      </div>

      {/* Progress section */}
      {progress && (
        <div className="rounded-xl border border-white/8 bg-white/3 p-4 space-y-3">
          {/* Bar + percentage */}
          <div className="flex items-center gap-3">
            <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-white/6">
              <div
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full transition-all duration-700',
                  isRunning && status !== 'cancelling' ? 'progress-running' : 'bg-gradient-to-r from-emerald-600 to-emerald-400',
                  status === 'cancelling' && 'bg-amber-500',
                  status === 'failed'    && 'bg-red-500',
                )}
                style={{ width: `${globalPct}%` }}
              />
            </div>
            <span className="font-mono text-sm font-semibold tabular-nums text-foreground w-10 text-right shrink-0">
              {globalPct}%
            </span>
          </div>

          {/* Total count */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Total examples</span>
            <span className="font-mono font-semibold text-foreground tabular-nums">
              {progress.completed}&nbsp;/&nbsp;{progress.total_examples}
            </span>
          </div>

          {/* Stat chips */}
          <div className="flex flex-wrap gap-1.5">
            <StatChip label="generated" value={progress.completed} />
            <StatChip label="skipped" value={progress.skipped} variant={progress.skipped > 0 ? 'warn' : 'default'} />
            {progress.judge_stats && (
              <>
                <StatChip label="evaluated" value={progress.judge_stats.evaluated} />
                <StatChip label="accepted"  value={progress.judge_stats.accepted}  variant="success" />
                <StatChip label="rejected"  value={progress.judge_stats.rejected}  variant={progress.judge_stats.rejected > 0 ? 'danger' : 'default'} />
                {progress.judge_stats.avg_score != null && (
                  <StatChip label="avg score" value={progress.judge_stats.avg_score} variant="success" />
                )}
              </>
            )}
          </div>

          {/* Cost breakdown (terminal only) */}
          {(progress.actual_cost != null || progress.judge_cost != null) && (
            <div className="flex flex-wrap gap-1.5 border-t border-white/6 pt-2.5">
              {progress.actual_cost != null && (
                <StatChip label="gen cost" value={`$${progress.actual_cost.toFixed(4)}`} />
              )}
              {progress.judge_cost != null && (
                <StatChip label="judge cost" value={`$${progress.judge_cost.toFixed(4)}`} />
              )}
            </div>
          )}
        </div>
      )}

      {/* Per-category progress */}
      {categoryEntries.length > 0 && (
        <div className="rounded-xl border border-white/8 bg-white/3 p-4 space-y-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            Categories
          </p>
          {categoryEntries.map(([name, cat], i) => {
            const catPct =
              cat.target > 0
                ? Math.min(100, Math.round((cat.completed / cat.target) * 100))
                : 0
            const colorClass = CATEGORY_COLORS[i % CATEGORY_COLORS.length]
            const isActive = isRunning && cat.completed < cat.target && progress?.current_stage === 'generating_examples'

            return (
              <div key={name}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={cn('size-2 shrink-0 rounded-full', colorClass)} />
                    <span className="truncate font-medium">{name}</span>
                    {isActive && (
                      <span className="size-1.5 shrink-0 rounded-full bg-blue-400 animate-pulse" />
                    )}
                  </div>
                  <span className="ml-2 shrink-0 font-mono tabular-nums text-muted-foreground">
                    {cat.completed}/{cat.target}
                  </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-white/6">
                  <div
                    className={cn('absolute inset-y-0 left-0 rounded-full transition-all duration-500', colorClass)}
                    style={{ width: `${catPct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Live examples feed */}
      {(examples.length > 0 || isRunning) && (
        <div className="rounded-xl border border-white/8 bg-white/3 p-4 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            Recent examples
          </p>
          {examples.length === 0 && isRunning && (
            <p className="text-xs text-muted-foreground italic">
              {progress?.current_stage === 'generating_topics'
                ? 'Generating topics — examples will appear here shortly…'
                : 'Waiting for first example…'}
            </p>
          )}
          <div className="space-y-1.5">
            {examples.map((ex) => (
              <div
                key={ex.id}
                className="rounded-lg border border-white/6 bg-white/3 px-3 py-2"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    {ex.format}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {ex.judge_score != null && (
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 font-mono text-xs font-semibold',
                          ex.judge_score >= judgeThreshold
                            ? 'bg-emerald-500/12 text-emerald-400'
                            : 'bg-amber-500/12 text-amber-400',
                        )}
                      >
                        {ex.judge_score}
                      </span>
                    )}
                    <span className="font-mono tabular-nums text-xs text-muted-foreground">
                      {ex.tokens} tok
                    </span>
                  </div>
                </div>
                <p className="line-clamp-2 break-words text-xs text-foreground/80">
                  {extractPreview(ex)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Loading placeholder */}
      {!payload && !sseError && (
        <div className="rounded-xl border border-dashed border-white/10 py-10 text-center text-sm text-muted-foreground">
          Connecting…
        </div>
      )}

      {/* Action buttons */}
      <div className="space-y-2 pt-1">
        {status === 'completed' && (
          <Button size="lg" className="w-full btn-cta" onClick={handleOpenFolder} disabled={isOpeningFolder}>
            <FolderOpen className="size-4" />
            {isOpeningFolder ? 'Opening…' : 'Open datasets folder'}
          </Button>
        )}
        {isTerminal && (
          <Button variant="outline" size="lg" className="w-full" onClick={onReset}>
            <RotateCcw className="size-4" />
            New generation
          </Button>
        )}
        {sseError && (
          <Button variant="outline" size="lg" className="w-full" onClick={onReset}>
            Back
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
            <StopCircle className="size-4" />
            {isCancelling ? 'Cancelling…' : 'Cancel generation'}
          </Button>
        )}
        {status === 'cancelling' && (
          <Button variant="destructive" size="lg" className="w-full" disabled>
            Cancelling…
          </Button>
        )}
      </div>
    </div>
  )
}
