'use client'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000'

import { useEffect, useState } from 'react'
import { AlertCircle, FolderOpen, RotateCcw, StopCircle, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CATEGORY_COLORS } from './CategoryList'
import {
  cancelJob,
  openDatasetsFolder,
  type SSEProgressPayload,
} from '@/lib/api'
import { QualityReportModal } from '@/components/jobs/QualityReportModal'

const TIMING_KEY = (id: string) => `jobTiming:${id}`

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

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

interface StatusTone {
  head: string
  dot: string
  status: string
  barClass: string
}

function getStatusTone(status: string, isRunning: boolean): StatusTone {
  switch (status) {
    case 'completed':
      return {
        head: 'text-primary',
        dot: 'bg-primary shadow-[0_0_8px_var(--color-primary)]',
        status: 'text-ok',
        barClass: 'bg-gradient-to-r from-[oklch(0.50_0.14_145)] to-primary',
      }
    case 'failed':
      return {
        head: 'text-destructive',
        dot: 'bg-destructive shadow-[0_0_6px_var(--color-destructive)]',
        status: 'text-destructive',
        barClass: 'bg-destructive',
      }
    case 'cancelled':
      return {
        head: 'text-text-2',
        dot: 'bg-text-3',
        status: 'text-text-3',
        barClass: 'bg-text-4',
      }
    case 'cancelling':
      return {
        head: 'text-warn',
        dot: 'bg-warn animate-pulse',
        status: 'text-warn',
        barClass: 'bg-warn',
      }
    case 'running':
      return {
        head: 'text-info',
        dot: 'bg-info animate-pulse shadow-[0_0_6px_var(--color-info)]',
        status: 'text-info',
        barClass: isRunning ? 'progress-running' : 'bg-gradient-to-r from-[oklch(0.50_0.14_145)] to-primary',
      }
    default:
      return {
        head: 'text-text-2',
        dot: 'bg-text-3',
        status: 'text-text-3',
        barClass: 'bg-text-4',
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
    variant === 'success' ? 'text-ok' :
    variant === 'warn'    ? 'text-warn' :
    variant === 'danger'  ? 'text-destructive' :
    'text-text-0'

  return (
    <span className="flex w-full items-center justify-center gap-1.5 rounded-full border border-border bg-bg-0 px-2.5 py-1 text-[11.5px]">
      <span className="text-text-3">{label}</span>
      <span className={cn('font-mono font-semibold tabular-nums', valueClass)}>{value}</span>
    </span>
  )
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
  const [reportOpen, setReportOpen] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  const [tick, setTick] = useState<number>(Date.now())

  // Restore timing from sessionStorage on mount
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(TIMING_KEY(jobId))
      if (!raw) return
      const t = JSON.parse(raw) as { startedAt?: number; endedAt?: number }
      if (t.startedAt) setStartedAt(t.startedAt)
      if (t.endedAt) setEndedAt(t.endedAt)
    } catch { /* ignore */ }
  }, [jobId])

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

  // Track start/end timestamps based on status transitions
  useEffect(() => {
    if (!payload) return
    const status = payload.status
    const terminal = ['completed', 'cancelled', 'failed'].includes(status)
    const active = ['pending', 'running', 'cancelling'].includes(status)

    const now = Date.now()
    let nextStart = startedAt
    let nextEnd = endedAt
    if (active && nextStart == null) nextStart = now
    if (terminal && nextEnd == null) {
      nextEnd = now
      if (nextStart == null) nextStart = now
    }
    if (nextStart !== startedAt) setStartedAt(nextStart)
    if (nextEnd !== endedAt) setEndedAt(nextEnd)
    if (nextStart !== startedAt || nextEnd !== endedAt) {
      try {
        sessionStorage.setItem(
          TIMING_KEY(jobId),
          JSON.stringify({ startedAt: nextStart, endedAt: nextEnd }),
        )
      } catch { /* ignore */ }
    }
  }, [payload, jobId, startedAt, endedAt])

  // Tick every second while running to refresh ETA/elapsed
  useEffect(() => {
    if (endedAt != null) return
    const id = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [endedAt])

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
  const tone = getStatusTone(status, isRunning)
  const stageLabel = progress?.current_stage
    ? STAGE_LABELS[progress.current_stage] ?? progress.current_stage
    : null
  const categoryEntries = progress ? Object.entries(progress.categories) : []

  const elapsedMs = startedAt != null ? (endedAt ?? tick) - startedAt : null
  const etaMs =
    isRunning && startedAt != null && progress && progress.completed > 0 && progress.completed < progress.total_examples
      ? ((progress.total_examples - progress.completed) / progress.completed) * (tick - startedAt)
      : null

  return (
    <div className="space-y-3">
      {/* Job ID */}
      <p className="font-mono text-xs text-text-3 tracking-wider truncate">{jobId}</p>

      {/* SSE error */}
      {sseError && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1">{sseError}</span>
        </div>
      )}

      {/* Editorial summary card — status + progress in one */}
      {progress && (
        <div className="summary rounded-xl p-5">
          {/* Top row: status label | stage */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={cn('size-2 rounded-full', tone.dot)} />
              <span className={cn('text-[11px] font-semibold uppercase tracking-widest', tone.head)}>
                {STATUS_LABELS[status] ?? status}
              </span>
            </div>
            {stageLabel && (
              <span className="text-[11px] uppercase tracking-widest text-text-3">
                {stageLabel}
              </span>
            )}
          </div>

          {/* Big italic % + secondary status */}
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-serif text-5xl italic leading-none text-text-0 tabular-nums">
              {globalPct}%
            </span>
            <span className={cn('font-mono text-sm', tone.status)}>
              {isRunning ? 'running' : status}
            </span>
          </div>

          {/* Progress bar (no category segments) */}
          <div className="mt-4 relative h-1.5 overflow-hidden rounded-full bg-bg-2">
            <div
              className={cn('absolute inset-y-0 left-0 rounded-full transition-all duration-700', tone.barClass)}
              style={{ width: `${globalPct}%` }}
            />
          </div>

          {/* Total examples + timing */}
          <dl className="mt-4 space-y-1.5 text-[13px]">
            <div className="flex items-center justify-between">
              <dt className="text-text-2">Total examples</dt>
              <dd className="font-mono text-text-0 tabular-nums">
                {progress.completed.toLocaleString('en-US')}&nbsp;/&nbsp;{progress.total_examples.toLocaleString('en-US')}
              </dd>
            </div>
            {isRunning && etaMs != null && (
              <div className="flex items-center justify-between">
                <dt className="text-text-2">ETA</dt>
                <dd className="font-mono text-info tabular-nums">{formatDuration(etaMs)}</dd>
              </div>
            )}
            {isTerminal && elapsedMs != null && elapsedMs > 0 && (
              <div className="flex items-center justify-between">
                <dt className="text-text-2">Duration</dt>
                <dd className="font-mono text-text-0 tabular-nums">{formatDuration(elapsedMs)}</dd>
              </div>
            )}
          </dl>

          {/* Chips — uniform grid 3 cols */}
          <div className="mt-4 grid grid-cols-3 gap-1.5 border-t border-border pt-4">
            <StatChip label="generated" value={progress.completed} />
            {progress.skipped > 0 && (
              <StatChip label="skipped" value={progress.skipped} variant="warn" />
            )}
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

          {/* Cost row — 2 cols separately */}
          {(progress.actual_cost != null || progress.judge_cost != null) && (
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
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
        <div className="rounded-xl border border-border bg-card p-4 space-y-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-text-3">
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
                    <span className="truncate font-medium text-text-1">{name}</span>
                    {isActive && (
                      <span className="size-1.5 shrink-0 rounded-full bg-info animate-pulse" />
                    )}
                  </div>
                  <span className="ml-2 shrink-0 font-mono tabular-nums text-text-3">
                    {cat.completed}/{cat.target}
                  </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-bg-2">
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
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-text-3">
            Recent examples
          </p>
          {examples.length === 0 && isRunning && (
            <p className="text-xs text-text-3 italic">
              {progress?.current_stage === 'generating_topics'
                ? 'Generating topics — examples will appear here shortly…'
                : 'Waiting for first example…'}
            </p>
          )}
          <div className="space-y-1.5">
            {examples.map((ex) => (
              <div
                key={ex.id}
                className="rounded-lg border border-border bg-bg-0 px-3 py-2"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-text-1 truncate">
                    {ex.category || 'Unknown'}
                  </span>
                  <span className="font-mono text-xs text-text-3 truncate max-w-[180px]">
                    {ex.model ? ex.model.split('/').pop() : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs uppercase tracking-wider text-text-3">
                    {ex.format}
                  </span>
                  {ex.judge_score != null && (
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 font-mono text-xs font-semibold',
                        ex.judge_score >= judgeThreshold
                          ? 'bg-ok/10 text-ok'
                          : 'bg-warn/10 text-warn',
                      )}
                    >
                      {ex.judge_score}
                    </span>
                  )}
                  <span className="font-mono tabular-nums text-xs text-text-3">
                    {ex.tokens} tok
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Loading placeholder */}
      {!payload && !sseError && (
        <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-text-3">
          Connecting…
        </div>
      )}

      {/* Action buttons */}
      <div className="space-y-2 pt-1">
        {status === 'completed' && (
          <>
            <Button variant="outline" size="lg" className="w-full gap-1.5" onClick={() => setReportOpen(true)}>
              <BarChart3 className="size-4" />
              Quality Report
            </Button>
            <Button size="lg" className="w-full" onClick={handleOpenFolder} disabled={isOpeningFolder}>
              <FolderOpen className="size-4" />
              {isOpeningFolder ? 'Opening…' : 'Open datasets folder'}
            </Button>
          </>
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
      <QualityReportModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        jobId={jobId}
      />
    </div>
  )
}
