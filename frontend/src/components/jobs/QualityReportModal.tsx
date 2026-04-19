'use client'

import { useEffect, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import {
  X,
  Loader2,
  AlertCircle,
  BarChart3,
  Download,
  Merge,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  downloadViaProxy,
  getJobStats,
  type JobStats,
  type RunSummary,
  type ScoreBucket,
} from '@/lib/api'
import { STATUS_LABELS, getStatusTone } from '@/lib/status-tone'

type ModalState = 'loading' | 'results' | 'error'

interface QualityReportModalProps {
  open: boolean
  onClose: () => void
  jobId: string
}

// ---- Helpers ----

function scoreBarColor(label: string): string {
  const num = parseInt(label, 10)
  if (isNaN(num)) return 'bg-primary/70'
  if (num >= 80) return 'bg-ok/70'
  if (num >= 60) return 'bg-warn/70'
  return 'bg-destructive/70'
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDurationSec(seconds: number | null): string {
  if (seconds == null || seconds < 0) return '—'
  if (seconds < 60) return `${seconds}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  return `${m}m ${s}s`
}

function downloadFile(content: string, filename: string, mimeType: string) {
  // Go through the backend proxy so pywebview/WebView2 triggers a native save
  // dialog. A plain Blob + a.click() is silently dropped in the desktop shell.
  downloadViaProxy(filename, mimeType, content)
}

function buildCsv(stats: JobStats): string {
  const lines: string[] = []

  if (stats.run_summary) {
    const r = stats.run_summary
    lines.push('# Run Summary')
    lines.push(`# Status: ${r.status}  Format: ${r.format}`)
    lines.push(`# Started: ${r.started_at}`)
    lines.push(`# Ended: ${r.ended_at ?? '-'}`)
    lines.push(`# Duration: ${formatDurationSec(r.duration_seconds)}`)
    lines.push(`# Examples: ${r.actual_examples} / ${r.total_examples}`)
    if (r.is_merged) {
      lines.push(`# Merged from: ${r.merged_from_count} jobs`)
    }
    lines.push('')
    lines.push('# Models per Category')
    lines.push('Category,Gen Model,Gen Provider,Judge Model,Judge Provider,Target,Completed')
    for (const c of r.categories) {
      lines.push([
        c.name,
        c.gen_model,
        c.gen_provider ?? '',
        c.judge_model ?? '',
        c.judge_provider ?? '',
        c.target,
        c.completed,
      ].join(','))
    }
    lines.push('')
  }

  if (stats.score_distribution) {
    const d = stats.score_distribution
    lines.push('# Score Distribution')
    lines.push(`# Avg: ${d.avg_score}  Median: ${d.median_score}  Min: ${d.min_score}  Max: ${d.max_score}`)
    lines.push('Score Range,Count')
    for (const b of d.buckets) {
      lines.push(`${b.label},${b.count}`)
    }
    lines.push('')
  }

  lines.push('# Token Length by Category')
  lines.push('Category,Examples,Avg Tokens,Min Tokens,Max Tokens')
  for (const t of stats.token_stats) {
    lines.push(`${t.category},${t.examples_count},${t.avg_tokens},${t.min_tokens},${t.max_tokens}`)
  }
  lines.push('')

  if (stats.generation_efficiency.length > 0) {
    lines.push('# Generation Efficiency')
    lines.push('Category,Target,Completed,Skipped,Success Rate %')
    for (const e of stats.generation_efficiency) {
      lines.push(`${e.category},${e.target},${e.completed},${e.skipped},${e.success_rate}`)
    }
  }

  return lines.join('\n')
}

// ---- Histogram ----

function ScoreHistogram({ buckets, maxCount }: { buckets: ScoreBucket[]; maxCount: number }) {
  return (
    <div className="space-y-1.5">
      {buckets.map((b) => {
        const pct = maxCount > 0 ? (b.count / maxCount) * 100 : 0
        return (
          <div key={b.label} className="flex items-center gap-3">
            <span className="w-6 shrink-0 font-mono text-xs text-text-3 tabular-nums">
              {b.label}
            </span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-2">
              <div
                className={cn('h-full rounded-full', scoreBarColor(b.label))}
                style={{ width: `${Math.max(pct, 1)}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right font-mono text-xs text-text-2 tabular-nums">
              {b.count}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ---- Section Header ----

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-text-3">
      {children}
    </h3>
  )
}

// ---- Run Summary ----

function ModelCell({ name, isDefault }: { name: string | null; isDefault: boolean }) {
  if (!name) return <span className="text-text-3">—</span>
  return (
    <span className="font-mono text-xs">
      {isDefault && <span className="text-text-3">(default) </span>}
      <span className="text-text-1">{name}</span>
    </span>
  )
}

function MetricCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <span className="text-[10.5px] font-semibold uppercase tracking-widest text-text-3">
        {label}
      </span>
      <div className="text-[12.5px]">{children}</div>
    </div>
  )
}

function RunSummarySection({ summary, judgeEnabled }: { summary: RunSummary; judgeEnabled: boolean }) {
  const tone = getStatusTone(summary.status)
  const statusLabel = STATUS_LABELS[summary.status] ?? summary.status

  return (
    <div className="rounded-xl border border-border bg-bg-0 p-5">
      <div className="mb-5 flex items-center justify-between">
        <SectionHeader>Run Summary</SectionHeader>
        {summary.is_merged && (
          <span className="inline-flex items-center gap-1 rounded-full border border-transparent bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            <Merge className="size-3" />
            Merged from {summary.merged_from_count}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-x-4 gap-y-5">
        <MetricCell label="Started">
          <span className="font-mono text-text-1">{formatTimestamp(summary.started_at)}</span>
        </MetricCell>
        <MetricCell label="Ended">
          {summary.ended_at ? (
            <span className="font-mono text-text-1">{formatTimestamp(summary.ended_at)}</span>
          ) : (
            <span className="font-mono text-text-3">—</span>
          )}
        </MetricCell>
        <MetricCell label="Duration">
          <span className="font-mono text-text-1">{formatDurationSec(summary.duration_seconds)}</span>
        </MetricCell>

        <MetricCell label="Status">
          <span className="inline-flex items-center gap-2">
            <span className={cn('size-2 rounded-full', tone.dot)} />
            <span className={cn('font-medium', tone.head)}>{statusLabel}</span>
          </span>
        </MetricCell>
        <MetricCell label="Format">
          <span className="font-mono uppercase tracking-wider text-text-1">{summary.format}</span>
        </MetricCell>
        <MetricCell label="Examples">
          <span className="font-mono text-text-1 tabular-nums">
            {summary.actual_examples.toLocaleString('en-US')} / {summary.total_examples.toLocaleString('en-US')}
          </span>
        </MetricCell>
      </div>

      {summary.categories.length > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-text-3">
            Models per Category
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-[10.5px] uppercase tracking-widest text-text-3">
                  <th className="pb-2 px-3 text-center font-medium">Category</th>
                  <th className="pb-2 px-3 text-center font-medium">Gen Model</th>
                  {judgeEnabled && <th className="pb-2 px-3 text-center font-medium">Judge Model</th>}
                </tr>
              </thead>
              <tbody>
                {summary.categories.map((c) => (
                  <tr key={c.name} className="border-b border-border last:border-0">
                    <td className="py-2 px-3 text-center text-xs font-medium text-text-0">{c.name}</td>
                    <td className="py-2 px-3 text-center">
                      <ModelCell name={c.gen_model} isDefault={c.gen_model_is_default} />
                    </td>
                    {judgeEnabled && (
                      <td className="py-2 px-3 text-center">
                        <ModelCell name={c.judge_model} isDefault={c.judge_model_is_default} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!judgeEnabled && (
            <p className="mt-3 text-[11px] italic text-text-3">Judge disabled for this job.</p>
          )}
        </div>
      )}
    </div>
  )
}

// ---- Main Modal ----

export function QualityReportModal({ open, onClose, jobId }: QualityReportModalProps) {
  const [state, setState] = useState<ModalState>('loading')
  const [stats, setStats] = useState<JobStats | null>(null)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    if (!open) return
    setState('loading')
    setStats(null)
    setErrorMessage('')

    getJobStats(jobId)
      .then((data) => {
        setStats(data)
        setState('results')
      })
      .catch((err) => {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load stats')
        setState('error')
      })
  }, [open, jobId])

  function handleClose() {
    onClose()
    setTimeout(() => {
      setState('loading')
      setStats(null)
      setErrorMessage('')
    }, 200)
  }

  function handleExportJson() {
    if (!stats) return
    downloadFile(JSON.stringify(stats, null, 2), `quality-report-${jobId.slice(0, 8)}.json`, 'application/json')
  }

  function handleExportCsv() {
    if (!stats) return
    downloadFile(buildCsv(stats), `quality-report-${jobId.slice(0, 8)}.csv`, 'text/csv')
  }

  const shortId = jobId.slice(0, 8)
  const dist = stats?.score_distribution
  const maxBucketCount = dist ? Math.max(...dist.buckets.map((b) => b.count), 1) : 1

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[4px]" />
        <Dialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-border bg-card shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7),0_8px_20px_rgba(0,0,0,0.35)]',
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <div className="flex items-center gap-2.5">
              <BarChart3 className="size-4 text-primary" />
              <Dialog.Title className="font-serif text-xl italic tracking-[-0.01em] text-text-0">
                Quality Report
              </Dialog.Title>
              <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-text-3">
                #{shortId}
              </span>
            </div>
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon" onClick={handleClose}>
                  <X className="size-4" />
                </Button>
              }
            />
          </div>

          {/* Content */}
          <div className="max-h-[75vh] overflow-y-auto px-6 py-5">
            {/* Loading */}
            {state === 'loading' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 className="size-8 animate-spin text-primary" />
                <p className="text-sm text-text-3">Loading statistics...</p>
              </div>
            )}

            {/* Error */}
            {state === 'error' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <AlertCircle className="size-10 text-destructive" />
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium text-text-0">Failed to load report</p>
                  <p className="text-xs text-text-3">{errorMessage}</p>
                </div>
              </div>
            )}

            {/* Results */}
            {state === 'results' && stats && (
              <div className="space-y-6">
                {/* Run Summary — always shown */}
                {stats.run_summary && (
                  <RunSummarySection summary={stats.run_summary} judgeEnabled={stats.judge_enabled} />
                )}

                {/* Judge Score Distribution — only when judge was enabled */}
                {stats.judge_enabled && dist && (
                  <div className="rounded-xl border border-border bg-bg-0 p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <SectionHeader>Judge Score Distribution</SectionHeader>
                      <span className="font-serif text-lg italic text-text-0 tabular-nums">
                        Avg&nbsp;{dist.avg_score}
                      </span>
                    </div>
                    <ScoreHistogram buckets={dist.buckets} maxCount={maxBucketCount} />
                    <div className="mt-3 flex flex-wrap gap-4 border-t border-border pt-3 font-mono text-xs text-text-3">
                      <span>Min: {dist.min_score}</span>
                      <span>Median: {dist.median_score}</span>
                      <span>Max: {dist.max_score}</span>
                      <span>Total: {dist.total}</span>
                    </div>
                  </div>
                )}

                {/* Token Length by Category — always shown */}
                <div className="rounded-xl border border-border bg-bg-0 p-5">
                  <SectionHeader>Token Length by Category</SectionHeader>
                  {stats.token_stats.length === 0 ? (
                    <p className="text-xs text-text-3">No examples found.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-border text-[11px] uppercase tracking-widest text-text-3">
                            <th className="pb-2 pr-4 font-medium">Category</th>
                            <th className="pb-2 pr-4 text-center font-medium">Examples</th>
                            <th className="pb-2 pr-4 text-center font-medium">Avg Tokens</th>
                            <th className="pb-2 pr-4 text-center font-medium">Min</th>
                            <th className="pb-2 text-center font-medium">Max</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.token_stats.map((t) => (
                            <tr key={t.category} className="border-b border-border last:border-0">
                              <td className="py-2 pr-4 text-xs font-medium text-text-0">{t.category}</td>
                              <td className="py-2 pr-4 text-center font-mono text-xs text-text-1">{t.examples_count}</td>
                              <td className="py-2 pr-4 text-center font-mono text-xs text-text-1">{t.avg_tokens.toLocaleString('en-US')}</td>
                              <td className="py-2 pr-4 text-center font-mono text-xs text-text-3">{t.min_tokens.toLocaleString('en-US')}</td>
                              <td className="py-2 text-center font-mono text-xs text-text-3">{t.max_tokens.toLocaleString('en-US')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Generation Efficiency — only when judge was enabled */}
                {stats.judge_enabled && stats.generation_efficiency.length > 0 && (
                  <div className="rounded-xl border border-border bg-bg-0 p-5">
                    <SectionHeader>Generation Efficiency</SectionHeader>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-border text-[11px] uppercase tracking-widest text-text-3">
                            <th className="pb-2 pr-4 font-medium">Category</th>
                            <th className="pb-2 pr-4 text-center font-medium">Target</th>
                            <th className="pb-2 pr-4 text-center font-medium">Done</th>
                            <th className="pb-2 pr-4 text-center font-medium">Skipped</th>
                            <th className="pb-2 text-center font-medium">Success Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.generation_efficiency.map((e) => (
                            <tr key={e.category} className="border-b border-border last:border-0">
                              <td className="py-2 pr-4 text-xs font-medium text-text-0">{e.category}</td>
                              <td className="py-2 pr-4 text-center font-mono text-xs text-text-1">{e.target}</td>
                              <td className="py-2 pr-4 text-center font-mono text-xs text-text-1">{e.completed}</td>
                              <td className="py-2 pr-4 text-center font-mono text-xs text-text-3">{e.skipped}</td>
                              <td className={cn(
                                'py-2 text-center font-mono text-xs font-semibold',
                                e.success_rate >= 90 ? 'text-ok' :
                                e.success_rate >= 70 ? 'text-warn' : 'text-destructive',
                              )}>
                                {e.success_rate}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border px-6 py-4">
            <div className="flex items-center gap-2">
              {state === 'results' && stats && (
                <>
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExportJson}>
                    <Download className="size-3.5" />
                    JSON
                  </Button>
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExportCsv}>
                    <Download className="size-3.5" />
                    CSV
                  </Button>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {state === 'error' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setState('loading')
                    getJobStats(jobId)
                      .then((data) => { setStats(data); setState('results') })
                      .catch((err) => {
                        setErrorMessage(err instanceof Error ? err.message : 'Failed to load stats')
                        setState('error')
                      })
                  }}
                >
                  Retry
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={handleClose}>
                Close
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
