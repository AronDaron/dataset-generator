'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, FolderOpen, Trash2, Rocket, AlertCircle, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getJobs, deleteJob, openDatasetsFolder, type JobListItem } from '@/lib/api'

type StatusFilter = 'all' | 'completed' | 'running' | 'failed' | 'cancelled'
type FormatFilter = 'all' | 'sharegpt' | 'alpaca' | 'chatml'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatCost(value: number): string {
  return value < 0.001 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`
}

interface StatusStyle {
  dot: string
  label: string
  icon: React.ReactNode
}

function getStatusStyle(status: string): StatusStyle {
  switch (status) {
    case 'completed':
      return {
        dot: '',
        label: 'text-emerald-400',
        icon: <CheckCircle2 className="size-4 text-emerald-400" />,
      }
    case 'failed':
      return {
        dot: '',
        label: 'text-red-400',
        icon: <AlertCircle className="size-4 text-red-400" />,
      }
    case 'cancelled':
      return {
        dot: '',
        label: 'text-muted-foreground',
        icon: <XCircle className="size-4 text-muted-foreground" />,
      }
    case 'running':
    case 'cancelling':
      return {
        dot: 'bg-blue-400 animate-pulse',
        label: 'text-blue-400',
        icon: null,
      }
    default:
      return {
        dot: 'bg-muted-foreground',
        label: 'text-muted-foreground',
        icon: null,
      }
  }
}

const STATUS_LABELS: Record<string, string> = {
  pending:    'Pending',
  running:    'Running',
  cancelling: 'Cancelling…',
  cancelled:  'Cancelled',
  completed:  'Completed',
  failed:     'Failed',
}

const MAX_VISIBLE_MODELS = 3

function CategoryModels({ models, globalModel }: { models: string[]; globalModel: string }) {
  const visible = models.slice(0, MAX_VISIBLE_MODELS)
  const hidden = models.slice(MAX_VISIBLE_MODELS)
  const allSameAsGlobal = models.every((m) => m === globalModel)

  return (
    <div className="flex items-center gap-1.5">
      <span className="shrink-0 text-[10px] text-muted-foreground/60">Per cat:</span>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {visible.map((m, i) => (
          <span key={i} className={cn(
            'max-w-[160px] truncate font-mono text-xs',
            allSameAsGlobal ? 'text-muted-foreground/50' : 'text-foreground/70',
          )}>
            {m}{i < visible.length - 1 || hidden.length > 0 ? ',' : ''}
          </span>
        ))}
        {hidden.length > 0 && (
          <span
            className="relative cursor-default font-mono text-xs text-muted-foreground underline decoration-dotted"
            title={hidden.join('\n')}
          >
            +{hidden.length} more
          </span>
        )}
      </div>
    </div>
  )
}

interface JobRowProps {
  job: JobListItem
  onDelete: (id: string) => void
  deletingId: string | null
  openingFolderId: string | null
  onOpenFolder: (id: string) => void
}

function JobRow({ job, onDelete, deletingId, openingFolderId, onOpenFolder }: JobRowProps) {
  const style = getStatusStyle(job.status)
  const isTerminal = ['completed', 'cancelled', 'failed'].includes(job.status)
  const totalCost = (job.actual_cost ?? 0) + (job.judge_cost ?? 0)

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-white/8 bg-white/3 px-5 py-5 sm:flex-row sm:items-center sm:gap-5">
      {/* Status + date */}
      <div className="flex min-w-[130px] shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          {style.icon ?? (
            style.dot ? <span className={cn('size-2.5 shrink-0 rounded-full', style.dot)} /> : null
          )}
          <span className={cn('text-sm font-semibold', style.label)}>
            {STATUS_LABELS[job.status] ?? job.status}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{formatDate(job.created_at)}</span>
      </div>

      {/* Model + metadata */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Global model */}
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-[10px] text-muted-foreground/60">Global:</span>
          <span className="max-w-[220px] truncate font-mono text-xs text-foreground/80">
            {job.model}
          </span>
        </div>
        {/* Per-category models */}
        <CategoryModels models={job.category_models} globalModel={job.model} />
        {/* Format + examples + cost */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {job.format}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {job.completed.toLocaleString('en-US')}&nbsp;/&nbsp;{job.total_examples.toLocaleString('en-US')} examples
          </span>
          {totalCost > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatCost(totalCost)}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenFolder(job.id)}
          disabled={openingFolderId === job.id}
        >
          <FolderOpen className="size-3.5" />
          {openingFolderId === job.id ? 'Opening…' : 'Open folder'}
        </Button>
        {isTerminal && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onDelete(job.id)}
            disabled={deletingId === job.id}
          >
            <Trash2 className="size-3.5" />
            {deletingId === job.id ? 'Deleting…' : 'Delete'}
          </Button>
        )}
      </div>
    </div>
  )
}

export default function HistoryPage() {
  const [jobs, setJobs] = useState<JobListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [openingFolderId, setOpeningFolderId] = useState<string | null>(null)

  useEffect(() => {
    getJobs()
      .then(setJobs)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load jobs'))
      .finally(() => setLoading(false))
  }, [])

  const stats = useMemo(() => ({
    totalCompleted: jobs
      .filter((j) => j.status === 'completed')
      .reduce((s, j) => s + j.completed, 0),
    totalCost: jobs.reduce(
      (s, j) => s + (j.actual_cost ?? 0) + (j.judge_cost ?? 0),
      0,
    ),
    jobCount: jobs.length,
  }), [jobs])

  const filteredJobs = useMemo(() => {
    return jobs.filter((j) => {
      if (statusFilter !== 'all' && j.status !== statusFilter) return false
      if (formatFilter !== 'all' && j.format !== formatFilter) return false
      return true
    })
  }, [jobs, statusFilter, formatFilter])

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this job and all its examples? This cannot be undone.')) return
    setDeletingId(id)
    try {
      await deleteJob(id)
      setJobs((prev) => prev.filter((j) => j.id !== id))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleOpenFolder(id: string) {
    setOpeningFolderId(id)
    try {
      await openDatasetsFolder()
    } catch {
      /* non-fatal */
    } finally {
      setOpeningFolderId(null)
    }
  }

  return (
    <main className="min-h-screen bg-transparent">
      {/* Header */}
      <header className="sticky top-0 z-10 glass-header">
        <div className="mx-auto flex h-14 max-w-[1800px] items-center justify-between px-8">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="sm" className="gap-1.5">
                <ChevronLeft className="size-4" />
                Generator
              </Button>
            </Link>
            <div className="h-4 w-px bg-white/10" />
            <div className="flex items-center gap-2">
              <Rocket className="size-5 text-primary" />
              <span className="text-base font-semibold">History</span>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1800px] space-y-6 px-8 py-8">

        {/* Stats bar */}
        {!loading && !error && jobs.length > 0 && (
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/3 px-4 py-2.5">
              <span className="text-xs text-muted-foreground">Total jobs</span>
              <span className="font-mono text-sm font-semibold tabular-nums">{stats.jobCount}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/3 px-4 py-2.5">
              <span className="text-xs text-muted-foreground">Examples generated</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-emerald-400">
                {stats.totalCompleted.toLocaleString('en-US')}
              </span>
            </div>
            {stats.totalCost > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/3 px-4 py-2.5">
                <span className="text-xs text-muted-foreground">Total cost</span>
                <span className="font-mono text-sm font-semibold tabular-nums">
                  {formatCost(stats.totalCost)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Filter bar */}
        {!loading && !error && jobs.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">Filter:</span>
            <div className="flex flex-wrap gap-2">
              {(['all', 'completed', 'running', 'failed', 'cancelled'] as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={cn(
                    'rounded-md border px-3 py-1 text-xs font-medium transition-colors',
                    statusFilter === s
                      ? 'border-primary/50 bg-primary/15 text-primary'
                      : 'border-white/8 bg-white/3 text-muted-foreground hover:border-white/15 hover:text-foreground',
                  )}
                >
                  {s === 'all' ? 'All statuses' : STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            <div className="h-4 w-px bg-white/10" />
            <div className="flex flex-wrap gap-2">
              {(['all', 'sharegpt', 'alpaca', 'chatml'] as FormatFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFormatFilter(f)}
                  className={cn(
                    'rounded-md border px-3 py-1 font-mono text-xs font-medium transition-colors',
                    formatFilter === f
                      ? 'border-primary/50 bg-primary/15 text-primary'
                      : 'border-white/8 bg-white/3 text-muted-foreground hover:border-white/15 hover:text-foreground',
                  )}
                >
                  {f === 'all' ? 'All formats' : f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Content */}
        {loading && (
          <div className="rounded-xl border border-dashed border-white/10 py-16 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/8 px-5 py-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error}
          </div>
        )}

        {!loading && !error && jobs.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 py-16 text-center">
            <p className="text-sm text-muted-foreground">No jobs yet.</p>
            <Link href="/">
              <Button variant="outline" size="sm" className="mt-4">
                Start generating
              </Button>
            </Link>
          </div>
        )}

        {!loading && !error && jobs.length > 0 && filteredJobs.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 py-16 text-center text-sm text-muted-foreground">
            No jobs match the selected filters.
          </div>
        )}

        {!loading && !error && filteredJobs.length > 0 && (
          <div className="space-y-3">
            {filteredJobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                onDelete={handleDelete}
                onOpenFolder={handleOpenFolder}
                deletingId={deletingId}
                openingFolderId={openingFolderId}
              />
            ))}
          </div>
        )}

      </div>
    </main>
  )
}
