'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Copy, Eye, FolderOpen, Loader2, Trash2, AlertCircle, CheckCircle2, XCircle, Upload, Merge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getJobs, getHfToken, deleteJob, openDatasetsFolder, findDuplicates, mergeDatasets, type JobListItem, type MergeResponse } from '@/lib/api'
import { UploadHfModal } from '@/components/history/UploadHfModal'

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
        label: 'text-ok',
        icon: <CheckCircle2 className="size-4 text-ok" />,
      }
    case 'failed':
      return {
        dot: '',
        label: 'text-destructive',
        icon: <AlertCircle className="size-4 text-destructive" />,
      }
    case 'cancelled':
      return {
        dot: '',
        label: 'text-text-3',
        icon: <XCircle className="size-4 text-text-3" />,
      }
    case 'running':
    case 'cancelling':
      return {
        dot: 'bg-info animate-pulse',
        label: 'text-info',
        icon: null,
      }
    default:
      return {
        dot: 'bg-text-3',
        label: 'text-text-3',
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
      <span className="shrink-0 text-[11px] uppercase tracking-widest text-text-3">Per cat</span>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {visible.map((m, i) => (
          <span key={i} className={cn(
            'max-w-[160px] truncate font-mono text-xs',
            allSameAsGlobal ? 'text-text-3' : 'text-text-1',
          )}>
            {m}{i < visible.length - 1 || hidden.length > 0 ? ',' : ''}
          </span>
        ))}
        {hidden.length > 0 && (
          <span
            className="relative cursor-default font-mono text-xs text-text-3 underline decoration-dotted"
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
  onUpload: (id: string) => void
  selected: boolean
  onToggle: (id: string) => void
}

function JobRow({ job, onDelete, deletingId, openingFolderId, onOpenFolder, onUpload, selected, onToggle }: JobRowProps) {
  const [dedupState, setDedupState] = useState<'idle' | 'scanning' | 'done'>('idle')
  const [dedupCount, setDedupCount] = useState(0)

  const style = getStatusStyle(job.status)
  const isTerminal = ['completed', 'cancelled', 'failed'].includes(job.status)
  const totalCost = (job.actual_cost ?? 0) + (job.judge_cost ?? 0)

  async function handleCheckDuplicates() {
    setDedupState('scanning')
    try {
      const res = await findDuplicates(job.id, 0.85)
      setDedupCount(res.pairs.length)
      setDedupState('done')
    } catch {
      setDedupState('idle')
    }
  }

  return (
    <div className={cn(
      "flex flex-col gap-4 rounded-xl border px-5 py-5 transition-colors sm:flex-row sm:items-center sm:gap-5",
      selected
        ? "border-[color-mix(in_oklab,var(--color-primary)_35%,var(--color-border))] bg-accent-soft"
        : "border-border bg-card hover:border-line-strong",
    )}>
      {/* Checkbox for completed jobs */}
      {job.status === 'completed' && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(job.id)}
          className="size-4 shrink-0 cursor-pointer rounded accent-[oklch(0.72_0.17_145)]"
        />
      )}
      {/* Status + date */}
      <div className="flex min-w-[130px] shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          {style.icon ?? (
            style.dot ? <span className={cn('size-2.5 shrink-0 rounded-full', style.dot)} /> : null
          )}
          <span className={cn('text-sm font-semibold', style.label)}>
            {STATUS_LABELS[job.status] ?? job.status}
          </span>
          {job.is_merged && (
            <span className="inline-flex items-center gap-1 rounded-full border border-transparent bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              <Merge className="size-3" />
              Merged
            </span>
          )}
        </div>
        <span className="text-xs text-text-3">{formatDate(job.created_at)}</span>
      </div>

      {/* Model + metadata */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Global model */}
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-[11px] uppercase tracking-widest text-text-3">Global</span>
          <span className="max-w-[220px] truncate font-mono text-xs text-text-1">
            {job.model}
          </span>
        </div>
        {/* Per-category models */}
        <CategoryModels models={job.category_models} globalModel={job.model} />
        {/* Format + examples + cost */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider text-text-2">
            {job.format}
          </span>
          <span className="font-mono text-[11.5px] text-text-3 tabular-nums">
            {job.completed.toLocaleString('en-US')}&nbsp;/&nbsp;{job.total_examples.toLocaleString('en-US')} examples
          </span>
          {totalCost > 0 && (
            <span className="font-mono text-[11.5px] text-text-3 tabular-nums">
              {formatCost(totalCost)}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-2">
        {job.completed > 0 && (
          <Link href={`/jobs/${job.id}`}>
            <Button variant="outline" size="sm">
              <Eye className="size-3.5" />
              View
            </Button>
          </Link>
        )}
        {job.status === 'completed' && job.completed > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onUpload(job.id)}
          >
            <Upload className="size-3.5" />
            Upload to HF
          </Button>
        )}
        {job.status === 'completed' && job.completed >= 2 && dedupState === 'idle' && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleCheckDuplicates}
          >
            <Copy className="size-3.5" />
            Check duplicates
          </Button>
        )}
        {dedupState === 'scanning' && (
          <Button variant="outline" size="sm" className="gap-1.5" disabled>
            <Loader2 className="size-3.5 animate-spin" />
            Scanning...
          </Button>
        )}
        {dedupState === 'done' && (
          dedupCount > 0 ? (
            <Link href={`/jobs/${job.id}`}>
              <Button variant="outline" size="sm" className="gap-1.5 border-warn/40 text-warn hover:border-warn/60">
                <Copy className="size-3.5" />
                {dedupCount} duplicate{dedupCount !== 1 ? 's' : ''} found
              </Button>
            </Link>
          ) : (
            <Button variant="outline" size="sm" className="gap-1.5 border-ok/40 text-ok" disabled>
              <CheckCircle2 className="size-3.5" />
              No duplicates
            </Button>
          )
        )}
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
  const [uploadJobId, setUploadJobId] = useState<string | null>(null)
  const [hasHfToken, setHasHfToken] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [merging, setMerging] = useState(false)
  const [mergeResult, setMergeResult] = useState<MergeResponse | null>(null)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [shuffleOnMerge, setShuffleOnMerge] = useState(true)

  useEffect(() => {
    Promise.all([getJobs(), getHfToken()])
      .then(([jobList, hfStatus]) => {
        setJobs(jobList)
        setHasHfToken(hfStatus.has_token)
      })
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

  // Clear selection when filters change
  useEffect(() => {
    setSelectedIds(new Set())
    setMergeResult(null)
    setMergeError(null)
  }, [statusFilter, formatFilter])

  const selectedJobs = useMemo(
    () => filteredJobs.filter((j) => selectedIds.has(j.id)),
    [filteredJobs, selectedIds],
  )

  const mergeInfo = useMemo(() => {
    if (selectedJobs.length < 2) return { canMerge: false, formatMismatch: false }
    const allCompleted = selectedJobs.every((j) => j.status === 'completed')
    const formats = new Set(selectedJobs.map((j) => j.format))
    const sameFormat = formats.size === 1
    return {
      canMerge: allCompleted && sameFormat,
      formatMismatch: !sameFormat,
    }
  }, [selectedJobs])

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

  function handleToggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setMergeResult(null)
    setMergeError(null)
  }

  async function handleMerge() {
    setMerging(true)
    setMergeError(null)
    setMergeResult(null)
    try {
      const result = await mergeDatasets({ job_ids: [...selectedIds], shuffle: shuffleOnMerge })
      setMergeResult(result)
      setSelectedIds(new Set())
      // Refresh job list so the new merged job appears
      const refreshed = await getJobs()
      setJobs(refreshed)
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Merge failed')
    } finally {
      setMerging(false)
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
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-[1800px] items-center justify-between px-8">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="sm" className="gap-1.5">
                <ChevronLeft className="size-4" />
                Generator
              </Button>
            </Link>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="" className="size-9 rounded" />
              <span className="font-serif text-xl italic tracking-[-0.01em] text-text-0">History</span>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1800px] space-y-6 px-8 py-8">

        {/* Stats bar */}
        {!loading && !error && jobs.length > 0 && (
          <div className="flex flex-wrap gap-3">
            <div className="flex items-baseline gap-2.5 rounded-lg border border-border bg-card px-4 py-2.5">
              <span className="text-[11px] uppercase tracking-widest text-text-3">Total jobs</span>
              <span className="font-serif text-lg italic text-text-0 tabular-nums">{stats.jobCount}</span>
            </div>
            <div className="flex items-baseline gap-2.5 rounded-lg border border-border bg-card px-4 py-2.5">
              <span className="text-[11px] uppercase tracking-widest text-text-3">Examples generated</span>
              <span className="font-serif text-lg italic text-ok tabular-nums">
                {stats.totalCompleted.toLocaleString('en-US')}
              </span>
            </div>
            {stats.totalCost > 0 && (
              <div className="flex items-baseline gap-2.5 rounded-lg border border-border bg-card px-4 py-2.5">
                <span className="text-[11px] uppercase tracking-widest text-text-3">Total cost</span>
                <span className="font-mono text-sm text-text-1 tabular-nums">
                  {formatCost(stats.totalCost)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Filter bar */}
        {!loading && !error && jobs.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[11px] uppercase tracking-widest text-text-3">Filter</span>
            <div className="flex flex-wrap gap-2">
              {(['all', 'completed', 'running', 'failed', 'cancelled'] as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                    statusFilter === s
                      ? 'border-transparent bg-accent-soft text-primary'
                      : 'border-border bg-card text-text-2 hover:border-line-strong hover:bg-muted hover:text-text-0',
                  )}
                >
                  {s === 'all' ? 'All statuses' : STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            <div className="h-4 w-px bg-border" />
            <div className="flex flex-wrap gap-2">
              {(['all', 'sharegpt', 'alpaca', 'chatml'] as FormatFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFormatFilter(f)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 font-mono text-[11.5px] font-medium transition-colors',
                    formatFilter === f
                      ? 'border-transparent bg-accent-soft text-primary'
                      : 'border-border bg-card text-text-2 hover:border-line-strong hover:bg-muted hover:text-text-0',
                  )}
                >
                  {f === 'all' ? 'All formats' : f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Merge action bar */}
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[color-mix(in_oklab,var(--color-primary)_35%,var(--color-border))] bg-accent-soft px-5 py-3">
            <span className="text-sm font-medium text-text-0">
              {selectedIds.size} selected
            </span>
            <button
              onClick={() => { setSelectedIds(new Set()); setMergeResult(null); setMergeError(null) }}
              className="text-xs text-text-3 underline decoration-dotted hover:text-text-0"
            >
              Clear
            </button>
            <div className="h-4 w-px bg-border" />
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-text-2">
              <input
                type="checkbox"
                checked={shuffleOnMerge}
                onChange={(e) => setShuffleOnMerge(e.target.checked)}
                className="size-3.5 accent-[oklch(0.72_0.17_145)]"
              />
              Shuffle
            </label>
            <Button
              size="sm"
              onClick={handleMerge}
              disabled={!mergeInfo.canMerge || merging}
            >
              {merging ? (
                <><Loader2 className="size-3.5 animate-spin" /> Merging...</>
              ) : (
                'Merge datasets'
              )}
            </Button>
            {mergeInfo.formatMismatch && selectedIds.size >= 2 && (
              <span className="text-xs text-warn">Selected jobs have different formats</span>
            )}
          </div>
        )}

        {/* Merge result / error */}
        {mergeResult && (
          <div className="flex items-center gap-2 rounded-xl border border-transparent bg-ok/10 px-5 py-3 text-sm text-ok">
            <CheckCircle2 className="size-4 shrink-0" />
            Merged {mergeResult.total_examples.toLocaleString('en-US')} examples from {mergeResult.source_jobs} jobs
            <Link href={`/jobs/${mergeResult.job_id}`}>
              <Button variant="outline" size="sm" className="ml-2 h-7 gap-1 border-ok/40 text-ok hover:border-ok/60">
                <Eye className="size-3" />
                View
              </Button>
            </Link>
          </div>
        )}
        {mergeError && (
          <div className="flex items-center gap-2 rounded-xl border border-transparent bg-destructive/10 px-5 py-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {mergeError}
          </div>
        )}

        {/* Content */}
        {loading && (
          <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-text-3">
            Loading…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-transparent bg-destructive/10 px-5 py-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error}
          </div>
        )}

        {!loading && !error && jobs.length === 0 && (
          <div className="rounded-xl border border-dashed border-border py-16 text-center">
            <p className="text-sm text-text-3">No jobs yet.</p>
            <Link href="/">
              <Button variant="outline" size="sm" className="mt-4">
                Start generating
              </Button>
            </Link>
          </div>
        )}

        {!loading && !error && jobs.length > 0 && filteredJobs.length === 0 && (
          <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-text-3">
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
                onUpload={setUploadJobId}
                deletingId={deletingId}
                openingFolderId={openingFolderId}
                selected={selectedIds.has(job.id)}
                onToggle={handleToggle}
              />
            ))}
          </div>
        )}

      </div>

      {/* Upload to HuggingFace modal */}
      {uploadJobId && (
        <UploadHfModal
          open
          onClose={() => setUploadJobId(null)}
          jobId={uploadJobId}
          hasHfToken={hasHfToken}
        />
      )}
    </main>
  )
}
