'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AlertCircle, ChevronLeft, Copy, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getJob,
  getJobExamples,
  type ExampleItem,
  type JobDetail,
} from '@/lib/api'
import { DeduplicateModal } from '@/components/jobs/DeduplicateModal'

// ---- Types ----

interface Turn {
  role: string
  content: string
}

// ---- Helpers ----

function parseTurns(example: ExampleItem): Turn[] {
  const c = example.content
  try {
    if (example.format === 'sharegpt') {
      const convs = c.conversations as Array<{ from: string; value: string }> | undefined
      return (convs ?? []).map((e) => ({ role: e.from ?? '', content: e.value ?? '' }))
    }
    if (example.format === 'chatml') {
      const msgs = c.messages as Array<{ role: string; content: string }> | undefined
      return (msgs ?? []).map((e) => ({ role: e.role ?? '', content: e.content ?? '' }))
    }
    if (example.format === 'alpaca') {
      const instruction = (c.instruction as string) ?? ''
      const input = (c.input as string) ?? ''
      const output = (c.output as string) ?? ''
      const userContent = input ? `${instruction}\n${input}` : instruction
      return [
        { role: 'user', content: userContent },
        { role: 'assistant', content: output },
      ]
    }
  } catch {
    // fall through to empty
  }
  return []
}

function getPreviewText(example: ExampleItem): string {
  const turns = parseTurns(example)
  const first = turns.find((t) => ['human', 'user'].includes(t.role))
  const text = first?.content ?? ''
  return text.length > 60 ? text.slice(0, 60) + '…' : text
}

function normaliseRole(role: string): 'USER' | 'ASSISTANT' | 'SYSTEM' {
  if (role === 'human' || role === 'user') return 'USER'
  if (role === 'gpt' || role === 'assistant') return 'ASSISTANT'
  return 'SYSTEM'
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
  if (score >= 80) return 'text-emerald-400'
  if (score >= 60) return 'text-yellow-400'
  return 'text-red-400'
}

function scoreBg(score: number): string {
  if (score >= 80) return 'border-emerald-500/30 bg-emerald-500/10'
  if (score >= 60) return 'border-yellow-500/30 bg-yellow-500/10'
  return 'border-red-500/30 bg-red-500/10'
}

// FormattedContent extracted to shared component
import { FormattedContent } from '@/components/ui/formatted-content'

// ---- TurnBlock ----

function TurnBlock({ turn }: { turn: Turn }) {
  const label = normaliseRole(turn.role)

  const chipClass =
    label === 'USER'
      ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
      : label === 'ASSISTANT'
        ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
        : 'border-amber-500/30 bg-amber-500/10 text-amber-300'

  return (
    <div className="rounded-lg border border-white/8 bg-white/3 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-widest uppercase',
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
    <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-white/8 pt-4">
      {example.judge_score != null && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Judge</span>
          <span
            className={cn(
              'inline-flex items-center rounded border px-2 py-0.5 font-mono text-xs font-semibold',
              scoreBg(example.judge_score),
              scoreColor(example.judge_score),
            )}
          >
            {example.judge_score}/100
          </span>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Tokens</span>
        <span className="font-mono text-xs text-foreground/80">
          {example.tokens.toLocaleString('en-US')}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Created</span>
        <span className="text-xs text-foreground/70">{formatDate(example.created_at)}</span>
      </div>
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
        'w-full rounded-lg border px-3 py-3 text-left transition-colors',
        isSelected
          ? 'border-primary/40 bg-white/8'
          : 'border-transparent bg-transparent hover:border-white/8 hover:bg-white/4',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-foreground/60">#{index + 1}</span>
        {example.judge_score != null && (
          <span
            className={cn(
              'shrink-0 rounded border px-1.5 py-0 font-mono text-[10px] font-semibold',
              scoreBg(example.judge_score),
              scoreColor(example.judge_score),
            )}
          >
            {example.judge_score}
          </span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/70">
        {preview || <span className="italic text-muted-foreground">No preview</span>}
      </p>
      <div className="mt-1.5 font-mono text-[10px] text-muted-foreground/60">
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
      <header className="sticky top-0 z-10 glass-header">
        <div className="mx-auto flex h-14 max-w-[1800px] items-center gap-3 px-8">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-1.5">
              <ChevronLeft className="size-4" />
              Generator
            </Button>
          </Link>
          <div className="h-4 w-px bg-white/10" />
          <Link href="/history">
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
              History
            </Button>
          </Link>
          <div className="h-4 w-px bg-white/10" />
          <div className="flex items-center gap-2">
            <Database className="size-4 text-primary" />
            <span className="text-sm font-semibold">
              Job <span className="font-mono text-muted-foreground">#{shortId}</span>
            </span>
          </div>
          {job && (
            <>
              <div className="h-4 w-px bg-white/10" />
              <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {job.config.format}
              </span>
              <span className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">
                {job.config.model}
              </span>
              {job.status === 'completed' && examples.length >= 2 && (
                <>
                  <div className="h-4 w-px bg-white/10" />
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setDedupOpen(true)}
                  >
                    <Copy className="size-3.5" />
                    Check duplicates
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </header>

      {/* Loading skeleton */}
      {loadingJob && (
        <div className="mx-auto flex h-[calc(100vh-3.5rem)] max-w-[1800px] gap-0 px-8 py-6">
          <div className="w-72 shrink-0 animate-pulse rounded-xl bg-white/5" />
          <div className="ml-4 flex-1 animate-pulse rounded-xl bg-white/5" />
        </div>
      )}

      {/* Error */}
      {!loadingJob && errorJob && (
        <div className="mx-auto max-w-[1800px] px-8 py-8">
          <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/8 px-5 py-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {errorJob}
          </div>
        </div>
      )}

      {/* Split layout */}
      {!loadingJob && !errorJob && (
        <div className="mx-auto flex h-[calc(100vh-3.5rem)] max-w-[1800px]">
          {/* Left panel — example list */}
          <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-white/8">
            <div className="sticky top-0 border-b border-white/8 bg-[hsl(var(--background))] px-3 py-2.5">
              <span className="text-xs text-muted-foreground">
                {examples.length.toLocaleString('en-US')} example{examples.length !== 1 ? 's' : ''}
                {hasMore ? '+' : ''}
              </span>
            </div>

            {examples.length === 0 && (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
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
              <div className="border-t border-white/8 p-2">
                <button
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="w-full rounded-md py-2 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
            {!hasMore && examples.length >= PAGE_LIMIT && (
              <div className="border-t border-white/8 px-3 py-2 text-center text-[10px] text-muted-foreground/60">
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
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-muted-foreground">
                Select an example from the list
              </div>
            )}

            {!selectedExample && examples.length === 0 && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No examples to display.
              </div>
            )}

            {selectedExample && (() => {
              const idx = examples.findIndex((e) => e.id === selectedExample.id)
              const turns = parseTurns(selectedExample)
              return (
                <div className="mx-auto max-w-3xl">
                  <h2 className="mb-5 text-sm font-semibold text-foreground/70">
                    Example{' '}
                    <span className="font-mono text-foreground">#{idx + 1}</span>
                  </h2>
                  <div className="space-y-3">
                    {turns.length > 0 ? (
                      turns.map((turn, i) => <TurnBlock key={i} turn={turn} />)
                    ) : (
                      <p className="italic text-sm text-muted-foreground">
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
    </main>
  )
}
