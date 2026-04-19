'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AlertCircle, BarChart3, ChevronLeft, Copy, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getJob,
  getJobExamples,
  type ExampleItem,
  type JobDetail,
} from '@/lib/api'
import { parseTurnsFromContent, normaliseRole, type Turn } from '@/lib/example-utils'
import { DeduplicateModal } from '@/components/jobs/DeduplicateModal'
import { QualityReportModal } from '@/components/jobs/QualityReportModal'

// ---- Helpers ----

function parseTurns(example: ExampleItem): Turn[] {
  return parseTurnsFromContent(example.content, example.format)
}

function getPreviewText(example: ExampleItem): string {
  const turns = parseTurns(example)
  const first = turns.find((t) => ['human', 'user'].includes(t.role))
  const text = first?.content ?? ''
  return text.length > 60 ? text.slice(0, 60) + '…' : text
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-ok'
  if (score >= 60) return 'text-warn'
  return 'text-destructive'
}

function scoreBg(score: number): string {
  if (score >= 80) return 'border-transparent bg-ok/10'
  if (score >= 60) return 'border-transparent bg-warn/10'
  return 'border-transparent bg-destructive/10'
}

// FormattedContent extracted to shared component
import { FormattedContent } from '@/components/ui/formatted-content'

// ---- TurnBlock ----

function TurnBlock({ turn }: { turn: Turn }) {
  const label = normaliseRole(turn.role)

  const chipClass =
    label === 'USER'
      ? 'bg-info/12 text-info'
      : label === 'ASSISTANT'
        ? 'bg-accent-soft text-primary'
        : 'bg-muted text-text-2'

  return (
    <div className="rounded-[var(--radius-xl)] border border-border bg-card p-[var(--radius-xl)] transition-colors hover:border-line-strong">
      <div className="mb-3 flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded-md px-2 py-1 font-semibold tracking-widest uppercase text-[10.5px]',
            chipClass,
          )}
        >
          {label}
        </span>
      </div>
      <FormattedContent content={turn.content} />
    </div>
  )
}

// ---- ExampleMetadata ----

function ExampleMetadata({ example }: { example: ExampleItem }) {
  return (
    <div className="mt-6 grid grid-cols-[1fr_auto] gap-x-2.5 gap-y-1.5 border-t border-border pt-4 text-[13px]">
      {example.judge_score != null && (
        <>
          <dt className="text-[11px] uppercase tracking-widest text-text-3">Judge</dt>
          <dd className="text-right">
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold min-w-[44px] justify-center',
                scoreBg(example.judge_score),
                scoreColor(example.judge_score),
              )}
            >
              {example.judge_score}/100
            </span>
          </dd>
        </>
      )}
      <dt className="text-[11px] uppercase tracking-widest text-text-3">Tokens</dt>
      <dd className="text-right font-mono text-[12.5px] text-text-1">
        {example.tokens.toLocaleString('en-US')}
      </dd>
      <dt className="text-[11px] uppercase tracking-widest text-text-3">Created</dt>
      <dd className="text-right font-mono text-[12.5px] text-text-1">{formatDate(example.created_at)}</dd>
    </div>
  )
}

// ---- ExampleListItem ----

interface ExampleListItemProps {
  example: ExampleItem
  index: number
  isSelected: boolean
  onClick: () => void
}

function ExampleListItem({ example, index, isSelected, onClick }: ExampleListItemProps) {
  const preview = getPreviewText(example)

  return (
    <button
      onClick={onClick}
      className={cn(
        'relative grid w-full grid-cols-[auto_1fr_auto] items-start gap-x-3 gap-y-1 rounded-lg border px-3 py-3 text-left transition-colors',
        isSelected
          ? 'border-line-strong bg-bg-2 shadow-[inset_2px_0_0_var(--color-primary)]'
          : 'border-transparent bg-transparent hover:border-border hover:bg-muted',
      )}
    >
      <span className="row-span-2 font-serif italic text-[22px] leading-none text-text-3 tabular-nums">
        {index + 1}
      </span>
      <p className="col-start-2 line-clamp-2 text-xs leading-relaxed text-text-1">
        {preview || <span className="italic text-text-3">No preview</span>}
      </p>
      {example.judge_score != null && (
        <span
          className={cn(
            'col-start-3 row-start-1 shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[11px] font-semibold min-w-[30px] text-center',
            scoreBg(example.judge_score),
            scoreColor(example.judge_score),
          )}
        >
          {example.judge_score}
        </span>
      )}
      <div className="col-start-2 col-span-2 font-mono text-[11.5px] text-text-3">
        {example.tokens.toLocaleString('en-US')} tok
      </div>
    </button>
  )
}

// ---- Main page ----

const PAGE_LIMIT = 50

export default function JobDetailPage() {
  const params = useParams()
  const jobId = params.id as string

  const [job, setJob] = useState<JobDetail | null>(null)
  const [examples, setExamples] = useState<ExampleItem[]>([])
  const [selectedExample, setSelectedExample] = useState<ExampleItem | null>(null)
  const [loadingJob, setLoadingJob] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [errorJob, setErrorJob] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [dedupOpen, setDedupOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)

  const detailPanelRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!jobId) return
    setLoadingJob(true)

    Promise.all([getJob(jobId), getJobExamples(jobId, PAGE_LIMIT, 0)])
      .then(([jobData, exData]) => {
        setJob(jobData)
        setExamples(exData)
        setOffset(PAGE_LIMIT)
        setHasMore(exData.length === PAGE_LIMIT)
        if (exData.length > 0) setSelectedExample(exData[0])
      })
      .catch((e) => setErrorJob(e instanceof Error ? e.message : 'Failed to load job'))
      .finally(() => setLoadingJob(false))
  }, [jobId])

  async function handleLoadMore() {
    setLoadingMore(true)
    try {
      const more = await getJobExamples(jobId, PAGE_LIMIT, offset)
      setExamples((prev) => [...prev, ...more])
      setOffset((prev) => prev + PAGE_LIMIT)
      setHasMore(more.length === PAGE_LIMIT)
    } catch {
      // non-fatal, user can retry
    } finally {
      setLoadingMore(false)
    }
  }

  function handleSelectExample(ex: ExampleItem) {
    setSelectedExample(ex)
    if (detailPanelRef.current) {
      detailPanelRef.current.scrollTop = 0
    }
  }

  const shortId = jobId?.slice(0, 8) ?? '…'

  return (
    <main className="min-h-screen bg-transparent">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-background border-b border-border">
        <div className="mx-auto flex h-14 max-w-[1800px] items-center gap-3 px-8">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-1.5">
              <ChevronLeft className="size-4" />
              Generator
            </Button>
          </Link>
          <div className="h-4 w-px bg-border" />
          <Link href="/history">
            <Button variant="ghost" size="sm" className="gap-1.5">
              History
            </Button>
          </Link>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <Database className="size-4 text-primary" />
            <span className="text-sm text-text-1">
              Job <span className="font-serif italic text-lg text-text-0">#{shortId}</span>
            </span>
          </div>
          {job && (
            <>
              <div className="h-4 w-px bg-border" />
              <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider text-text-2">
                {job.config.format}
              </span>
              <span className="max-w-[200px] truncate font-mono text-xs text-text-3">
                {job.config.model}
              </span>
              {job.status === 'completed' && (
                <>
                  <div className="h-4 w-px bg-border" />
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setReportOpen(true)}
                  >
                    <BarChart3 className="size-3.5" />
                    Quality Report
                  </Button>
                  {examples.length >= 2 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setDedupOpen(true)}
                    >
                      <Copy className="size-3.5" />
                      Check duplicates
                    </Button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </header>

      {/* Loading skeleton */}
      {loadingJob && (
        <div className="mx-auto flex h-[calc(100vh-3.5rem)] max-w-[1800px] gap-0 px-8 py-6">
          <div className="w-72 shrink-0 animate-pulse rounded-xl bg-bg-2" />
          <div className="ml-4 flex-1 animate-pulse rounded-xl bg-bg-2" />
        </div>
      )}

      {/* Error */}
      {!loadingJob && errorJob && (
        <div className="mx-auto max-w-[1800px] px-8 py-8">
          <div className="flex items-start gap-2 rounded-xl border border-transparent bg-destructive/10 px-5 py-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {errorJob}
          </div>
        </div>
      )}

      {/* Split layout */}
      {!loadingJob && !errorJob && (
        <div className="mx-auto flex h-[calc(100vh-3.5rem)] max-w-[1800px]">
          {/* Left panel — example list */}
          <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border">
            <div className="sticky top-0 z-[1] flex items-baseline justify-between border-b border-border bg-background px-3 py-2.5">
              <span className="text-[11px] uppercase tracking-widest font-semibold text-text-3">
                Examples
              </span>
              <span className="font-serif italic text-lg text-text-1 tabular-nums">
                {examples.length.toLocaleString('en-US')}{hasMore ? '+' : ''}
              </span>
            </div>

            {examples.length === 0 && (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-text-3">
                No examples yet.
              </div>
            )}

            <div className="flex-1 space-y-1 p-2">
              {examples.map((ex, i) => (
                <ExampleListItem
                  key={ex.id}
                  example={ex}
                  index={i}
                  isSelected={selectedExample?.id === ex.id}
                  onClick={() => handleSelectExample(ex)}
                />
              ))}
            </div>

            {/* Load more */}
            {hasMore && (
              <div className="border-t border-border p-2">
                <button
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="w-full rounded-md py-2 text-xs text-text-3 transition-colors hover:text-text-0 disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
            {!hasMore && examples.length >= PAGE_LIMIT && (
              <div className="border-t border-border px-3 py-2 text-center text-xs text-text-3">
                All {examples.length} examples loaded
              </div>
            )}
          </aside>

          {/* Right panel — detail */}
          <section
            ref={detailPanelRef}
            className="flex-1 overflow-y-auto px-8 py-6"
          >
            {!selectedExample && examples.length > 0 && (
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-text-3">
                Select an example from the list
              </div>
            )}

            {!selectedExample && examples.length === 0 && (
              <div className="flex h-full items-center justify-center text-sm text-text-3">
                No examples to display.
              </div>
            )}

            {selectedExample && (() => {
              const idx = examples.findIndex((e) => e.id === selectedExample.id)
              const turns = parseTurns(selectedExample)
              return (
                <div className="mx-auto max-w-3xl">
                  <h2 className="mb-5 flex items-baseline gap-2">
                    <span className="text-[11px] uppercase tracking-widest font-semibold text-text-3">
                      Example
                    </span>
                    <span className="font-serif italic text-3xl text-text-0 tabular-nums leading-none">
                      #{idx + 1}
                    </span>
                  </h2>
                  <div className="space-y-3">
                    {turns.length > 0 ? (
                      turns.map((turn, i) => <TurnBlock key={i} turn={turn} />)
                    ) : (
                      <p className="italic text-sm text-text-3">
                        Unable to parse content.
                      </p>
                    )}
                  </div>
                  <ExampleMetadata example={selectedExample} />
                </div>
              )
            })()}
          </section>
        </div>
      )}
      <DeduplicateModal
        open={dedupOpen}
        onClose={() => setDedupOpen(false)}
        jobId={jobId}
        onExamplesChanged={() => {
          getJobExamples(jobId, PAGE_LIMIT, 0).then((data) => {
            setExamples(data)
            setOffset(PAGE_LIMIT)
            setHasMore(data.length === PAGE_LIMIT)
            setSelectedExample(data[0] ?? null)
          })
        }}
      />
      <QualityReportModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        jobId={jobId}
      />
    </main>
  )
}
