'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Popover } from '@base-ui/react/popover'
import { Info, Loader2, RotateCcw, Eye, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { resumeJob, dismissJob, type JobListItem } from '@/lib/api'
import { STATUS_LABELS, getStatusTone } from '@/lib/status-tone'

interface NotificationsPopoverProps {
  jobs: JobListItem[]
  hasNew: boolean
  onOpen: () => void
  onResumed: (jobId: string) => void
  onDismissed: (jobId: string) => void
}

export function NotificationsPopover({ jobs, hasNew, onOpen, onResumed, onDismissed }: NotificationsPopoverProps) {
  const [open, setOpen] = useState(false)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Popover shows only unexpected interruptions. User-cancelled jobs live in /history.
  const visibleJobs = jobs.filter((j) => j.status === 'interrupted')

  async function handleResume(jobId: string) {
    setResumingId(jobId)
    setError(null)
    try {
      await resumeJob(jobId)
      onResumed(jobId)
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resume failed')
    } finally {
      setResumingId(null)
    }
  }

  async function handleDismiss(jobId: string) {
    setDismissingId(jobId)
    setError(null)
    try {
      await dismissJob(jobId)
      onDismissed(jobId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dismiss failed')
    } finally {
      setDismissingId(null)
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen()
        if (!next) setError(null)
      }}
    >
      <Popover.Trigger
        aria-label="Resumable jobs"
        className={cn(
          'relative inline-flex size-9 items-center justify-center rounded-md border border-border bg-card',
          'transition-colors hover:border-line-strong hover:bg-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          hasNew ? 'text-warn' : 'text-text-2',
        )}
      >
        <Info className={cn('size-4', hasNew && 'animate-pulse')} />
        {hasNew && (
          <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-warn shadow-[0_0_6px_var(--color-warn)]" />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end">
          <Popover.Popup
            className={cn(
              'z-50 w-96 max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-card p-4',
              'shadow-[0_18px_50px_-20px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.25)]',
              'origin-[var(--transform-origin)] outline-none',
              'transition-all duration-150 ease-out',
              'data-[starting-style]:opacity-0 data-[starting-style]:translate-y-1 data-[starting-style]:scale-[0.98]',
              'data-[ending-style]:opacity-0 data-[ending-style]:translate-y-1 data-[ending-style]:scale-[0.98]',
            )}
          >
            <Popover.Arrow className="data-[side=top]:rotate-180">
              <svg width="14" height="8" viewBox="0 0 14 8" fill="none" aria-hidden>
                <path d="M0 0 L7 8 L14 0 Z" className="fill-card" />
                <path d="M0 0 L7 8 L14 0" className="stroke-border" strokeWidth="1" fill="none" />
              </svg>
            </Popover.Arrow>

            <Popover.Title className="mb-3 font-serif text-base italic tracking-[-0.01em] text-text-0">
              Resumable jobs
            </Popover.Title>

            {visibleJobs.length === 0 ? (
              <p className="py-6 text-center text-xs text-text-3">
                No interrupted jobs.
              </p>
            ) : (
              <ul className="space-y-2">
                {visibleJobs.map((job) => {
                  const tone = getStatusTone(job.status)
                  const isResuming = resumingId === job.id
                  const isDismissing = dismissingId === job.id
                  const anyBusy = resumingId !== null || dismissingId !== null
                  return (
                    <li
                      key={job.id}
                      className="rounded-lg border border-border bg-bg-0 px-3 py-2.5"
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <span className={cn('size-2 shrink-0 rounded-full', tone.dot)} />
                        <span className={cn('text-xs font-semibold', tone.head)}>
                          {STATUS_LABELS[job.status] ?? job.status}
                        </span>
                        <span className="ml-auto font-mono text-[11px] text-text-3 tabular-nums">
                          {job.completed.toLocaleString('en-US')} / {job.total_examples.toLocaleString('en-US')}
                        </span>
                      </div>
                      <div className="mb-2.5 flex items-center gap-1.5">
                        <span className="truncate font-mono text-[11.5px] text-text-2">
                          {job.model}
                        </span>
                        <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-2">
                          {job.format}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleResume(job.id)}
                          disabled={anyBusy}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                            'bg-primary text-primary-foreground hover:bg-primary/90',
                            'disabled:opacity-50 disabled:pointer-events-none',
                          )}
                        >
                          {isResuming ? (
                            <>
                              <Loader2 className="size-3 animate-spin" />
                              Resuming…
                            </>
                          ) : (
                            <>
                              <RotateCcw className="size-3" />
                              Resume
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => handleDismiss(job.id)}
                          disabled={anyBusy}
                          title="Dismiss — mark as cancelled (stays in history)"
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-text-2 transition-colors',
                            'hover:border-line-strong hover:bg-muted hover:text-text-0',
                            'disabled:opacity-50 disabled:pointer-events-none',
                          )}
                        >
                          {isDismissing ? (
                            <>
                              <Loader2 className="size-3 animate-spin" />
                              Dismissing…
                            </>
                          ) : (
                            <>
                              <X className="size-3" />
                              Dismiss
                            </>
                          )}
                        </button>
                        <Link
                          href={`/jobs/?id=${job.id}`}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-text-1',
                            'transition-colors hover:border-line-strong hover:bg-muted',
                          )}
                        >
                          <Eye className="size-3" />
                          View
                        </Link>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            {error && (
              <p className="mt-3 text-xs text-destructive">{error}</p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
