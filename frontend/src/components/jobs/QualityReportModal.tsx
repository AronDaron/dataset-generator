'use client'

import { useEffect, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import {
  X,
  Loader2,
  AlertCircle,
  BarChart3,
  Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getJobStats,
  type JobStats,
  type ScoreBucket,
} from '@/lib/api'

type ModalState = 'loading' | 'results' | 'error'

interface QualityReportModalProps {
  open: boolean
  onClose: () => void
  jobId: string
}

// ---- Helpers ----

function scoreBarColor(label: string): string {
  const num = parseInt(label, 10)
  if (isNaN(num)) return 'bg-violet-500/60'
  if (num >= 80) return 'bg-emerald-500/60'
  if (num >= 60) return 'bg-yellow-500/60'
  return 'bg-red-500/60'
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function buildCsv(stats: JobStats): string {
  const lines: string[] = []

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
            <span className="w-14 text-right font-mono text-xs text-muted-foreground">
              {b.label}
            </span>
            <div className="flex-1">
              <div
                className={cn('h-5 rounded', scoreBarColor(b.label))}
                style={{ width: `${Math.max(pct, 1)}%` }}
              />
            </div>
            <span className="w-16 text-right font-mono text-xs text-muted-foreground">
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
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
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
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2',
            'rounded-2xl shadow-2xl',
            'ring-1 ring-white/10',
          )}
          style={{
            background: 'oklch(0.13 0.026 232 / 0.97)',
            backdropFilter: 'blur(20px)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
            <div className="flex items-center gap-2.5">
              <BarChart3 className="size-4 text-violet-400" />
              <Dialog.Title className="text-base font-semibold">
                Quality Report
              </Dialog.Title>
              <span className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
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
                <Loader2 className="size-8 animate-spin text-violet-400" />
                <p className="text-sm text-muted-foreground">Loading statistics...</p>
              </div>
            )}

            {/* Error */}
            {state === 'error' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <AlertCircle className="size-10 text-red-400" />
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium">Failed to load report</p>
                  <p className="text-xs text-muted-foreground">{errorMessage}</p>
                </div>
              </div>
            )}

            {/* Results */}
            {state === 'results' && stats && (
              <div className="space-y-6">
                {/* Judge Score Distribution — only when judge was enabled */}
                {stats.judge_enabled && dist && (
                  <div className="rounded-xl border border-white/8 bg-white/3 p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <SectionHeader>Judge Score Distribution</SectionHeader>
                      <span className="rounded bg-white/8 px-2 py-0.5 font-mono text-xs text-muted-foreground">
                        Avg: {dist.avg_score}
                      </span>
                    </div>
                    <ScoreHistogram buckets={dist.buckets} maxCount={maxBucketCount} />
                    <div className="mt-3 flex gap-4 border-t border-white/6 pt-3 font-mono text-xs text-muted-foreground">
                      <span>Min: {dist.min_score}</span>
                      <span>Median: {dist.median_score}</span>
                      <span>Max: {dist.max_score}</span>
                      <span>Total: {dist.total}</span>
                    </div>
                  </div>
                )}

                {/* Token Length by Category — always shown */}
                <div className="rounded-xl border border-white/8 bg-white/3 p-5">
                  <SectionHeader>Token Length by Category</SectionHeader>
                  {stats.token_stats.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No examples found.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-white/6 text-xs uppercase tracking-wider text-muted-foreground">
                            <th className="pb-2 pr-4 font-medium">Category</th>
                            <th className="pb-2 pr-4 text-right font-medium">Examples</th>
                            <th className="pb-2 pr-4 text-right font-medium">Avg Tokens</th>
                            <th className="pb-2 pr-4 text-right font-medium">Min</th>
                            <th className="pb-2 text-right font-medium">Max</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.token_stats.map((t) => (
                            <tr key={t.category} className="border-b border-white/4 last:border-0">
                              <td className="py-2 pr-4 text-xs font-medium text-foreground">{t.category}</td>
                              <td className="py-2 pr-4 text-right font-mono text-xs text-foreground/80">{t.examples_count}</td>
                              <td className="py-2 pr-4 text-right font-mono text-xs text-foreground/80">{t.avg_tokens.toLocaleString('en-US')}</td>
                              <td className="py-2 pr-4 text-right font-mono text-xs text-muted-foreground">{t.min_tokens.toLocaleString('en-US')}</td>
                              <td className="py-2 text-right font-mono text-xs text-muted-foreground">{t.max_tokens.toLocaleString('en-US')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Generation Efficiency — only when judge was enabled */}
                {stats.judge_enabled && stats.generation_efficiency.length > 0 && (
                  <div className="rounded-xl border border-white/8 bg-white/3 p-5">
                    <SectionHeader>Generation Efficiency</SectionHeader>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-white/6 text-xs uppercase tracking-wider text-muted-foreground">
                            <th className="pb-2 pr-4 font-medium">Category</th>
                            <th className="pb-2 pr-4 text-right font-medium">Target</th>
                            <th className="pb-2 pr-4 text-right font-medium">Done</th>
                            <th className="pb-2 pr-4 text-right font-medium">Skipped</th>
                            <th className="pb-2 text-right font-medium">Success Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.generation_efficiency.map((e) => (
                            <tr key={e.category} className="border-b border-white/4 last:border-0">
                              <td className="py-2 pr-4 text-xs font-medium text-foreground">{e.category}</td>
                              <td className="py-2 pr-4 text-right font-mono text-xs text-foreground/80">{e.target}</td>
                              <td className="py-2 pr-4 text-right font-mono text-xs text-foreground/80">{e.completed}</td>
                              <td className="py-2 pr-4 text-right font-mono text-xs text-muted-foreground">{e.skipped}</td>
                              <td className={cn(
                                'py-2 text-right font-mono text-xs font-semibold',
                                e.success_rate >= 90 ? 'text-emerald-400' :
                                e.success_rate >= 70 ? 'text-yellow-400' : 'text-red-400',
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
          <div className="flex items-center justify-between border-t border-white/8 px-6 py-4">
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
