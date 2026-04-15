'use client'

import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import {
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  ChevronDown,
  ChevronUp,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FormattedContent } from '@/components/ui/formatted-content'
import {
  findDuplicates,
  deleteExample,
  type DuplicatePair,
} from '@/lib/api'
import { cn } from '@/lib/utils'

type ModalState = 'config' | 'scanning' | 'results' | 'error'

interface DeduplicateModalProps {
  open: boolean
  onClose: () => void
  jobId: string
  onExamplesChanged: () => void
}

// ---- Turn parsing (same logic as /jobs/[id]/page.tsx) ----

interface Turn {
  role: string
  content: string
}

function parseTurnsFromContent(
  content: Record<string, unknown>,
  format: string,
): Turn[] {
  try {
    if (format === 'sharegpt') {
      const convs = content.conversations as Array<{ from: string; value: string }> | undefined
      return (convs ?? []).map((e) => ({ role: e.from ?? '', content: e.value ?? '' }))
    }
    if (format === 'chatml') {
      const msgs = content.messages as Array<{ role: string; content: string }> | undefined
      return (msgs ?? []).map((e) => ({ role: e.role ?? '', content: e.content ?? '' }))
    }
    if (format === 'alpaca') {
      const instruction = (content.instruction as string) ?? ''
      const input = (content.input as string) ?? ''
      const output = (content.output as string) ?? ''
      const userContent = input ? `${instruction}\n${input}` : instruction
      return [
        { role: 'user', content: userContent },
        { role: 'assistant', content: output },
      ]
    }
  } catch {
    // fall through
  }
  return []
}

function normaliseRole(role: string): 'USER' | 'ASSISTANT' | 'SYSTEM' {
  if (role === 'human' || role === 'user') return 'USER'
  if (role === 'gpt' || role === 'assistant') return 'ASSISTANT'
  return 'SYSTEM'
}

// ---- Helpers ----

function scoreColor(score: number | null): string {
  if (score == null) return 'text-muted-foreground'
  if (score >= 80) return 'text-emerald-400'
  if (score >= 50) return 'text-amber-400'
  return 'text-red-400'
}

function similarityColor(sim: number): string {
  if (sim >= 0.95) return 'bg-red-500/20 text-red-400'
  if (sim >= 0.9) return 'bg-amber-500/20 text-amber-400'
  return 'bg-violet-500/20 text-violet-300'
}

// ---- TurnBlock for expanded view ----

function TurnBlock({ turn }: { turn: Turn }) {
  const label = normaliseRole(turn.role)
  const chipClass =
    label === 'USER'
      ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
      : label === 'ASSISTANT'
        ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
        : 'border-amber-500/30 bg-amber-500/10 text-amber-300'

  return (
    <div className="rounded-lg border border-white/8 bg-white/3 p-3">
      <div className="mb-2">
        <span
          className={cn(
            'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-widest uppercase',
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

// ---- PairCard ----

function PairCard({
  pair,
  expanded,
  onToggle,
  onDelete,
  deletingId,
}: {
  pair: DuplicatePair
  expanded: boolean
  onToggle: () => void
  onDelete: (exampleId: string) => void
  deletingId: string | null
}) {
  const lowerScored =
    pair.judge_score_a != null && pair.judge_score_b != null
      ? pair.judge_score_a < pair.judge_score_b
        ? 'a'
        : pair.judge_score_a > pair.judge_score_b
          ? 'b'
          : null
      : null

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <span
          className={cn(
            'rounded-full px-2.5 py-0.5 text-xs font-semibold',
            similarityColor(pair.similarity),
          )}
        >
          {Math.round(pair.similarity * 100)}% similar
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="gap-1 text-muted-foreground"
          onClick={onToggle}
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" />
              Collapse
            </>
          ) : (
            <>
              <ChevronDown className="size-3" />
              Show full content
            </>
          )}
        </Button>
      </div>

      {/* Example A */}
      <ExampleCard
        label="A"
        preview={pair.preview_a}
        content={pair.content_a}
        format={pair.format_a}
        tokens={pair.tokens_a}
        judgeScore={pair.judge_score_a}
        expanded={expanded}
        isLowerScored={lowerScored === 'a'}
        exampleId={pair.example_id_a}
        onDelete={onDelete}
        deleting={deletingId === pair.example_id_a}
      />

      <div className="my-2 flex items-center justify-center">
        <span className="text-xs text-muted-foreground/50">vs</span>
      </div>

      {/* Example B */}
      <ExampleCard
        label="B"
        preview={pair.preview_b}
        content={pair.content_b}
        format={pair.format_b}
        tokens={pair.tokens_b}
        judgeScore={pair.judge_score_b}
        expanded={expanded}
        isLowerScored={lowerScored === 'b'}
        exampleId={pair.example_id_b}
        onDelete={onDelete}
        deleting={deletingId === pair.example_id_b}
      />
    </div>
  )
}

// ---- ExampleCard ----

function ExampleCard({
  label,
  preview,
  content,
  format,
  tokens,
  judgeScore,
  expanded,
  isLowerScored,
  exampleId,
  onDelete,
  deleting,
}: {
  label: string
  preview: string
  content: Record<string, unknown>
  format: string
  tokens: number
  judgeScore: number | null
  expanded: boolean
  isLowerScored: boolean
  exampleId: string
  onDelete: (id: string) => void
  deleting: boolean
}) {
  const turns = parseTurnsFromContent(content, format)

  return (
    <div
      className={cn(
        'rounded-lg border border-white/6 bg-white/[0.02] p-3',
        isLowerScored && 'ring-1 ring-amber-500/30',
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-bold">
            {label}
          </span>
          <span className="text-[11px] text-muted-foreground">{tokens} tok</span>
          {judgeScore != null && (
            <span className={cn('text-[11px] font-medium', scoreColor(judgeScore))}>
              Judge: {judgeScore}
            </span>
          )}
          {isLowerScored && (
            <span className="text-[10px] text-amber-400/70">lower score</span>
          )}
        </div>
        <Button
          variant="destructive"
          size="xs"
          className="gap-1"
          onClick={() => onDelete(exampleId)}
          disabled={deleting}
        >
          <Trash2 className="size-3" />
          {deleting ? 'Deleting...' : 'Delete'}
        </Button>
      </div>

      {expanded ? (
        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {turns.length > 0 ? (
            turns.map((turn, i) => <TurnBlock key={i} turn={turn} />)
          ) : (
            <p className="text-xs italic text-muted-foreground">Unable to parse content.</p>
          )}
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          &ldquo;{preview}&rdquo;
        </p>
      )}
    </div>
  )
}

// ---- Main Modal ----

export function DeduplicateModal({
  open,
  onClose,
  jobId,
  onExamplesChanged,
}: DeduplicateModalProps) {
  const [state, setState] = useState<ModalState>('config')
  const [threshold, setThreshold] = useState(0.85)
  const [pairs, setPairs] = useState<DuplicatePair[]>([])
  const [totalExamples, setTotalExamples] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [expandedPairs, setExpandedPairs] = useState<Set<number>>(new Set())
  const [deletingId, setDeletingId] = useState<string | null>(null)

  function handleClose() {
    onClose()
    setTimeout(() => {
      setState('config')
      setPairs([])
      setTotalExamples(0)
      setErrorMessage('')
      setExpandedPairs(new Set())
      setDeletingId(null)
    }, 200)
  }

  async function handleScan() {
    setState('scanning')
    try {
      const res = await findDuplicates(jobId, threshold)
      setPairs(res.pairs)
      setTotalExamples(res.total_examples)
      setExpandedPairs(new Set())
      setState('results')
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Scan failed')
      setState('error')
    }
  }

  async function handleDelete(exampleId: string) {
    setDeletingId(exampleId)
    try {
      await deleteExample(jobId, exampleId)
      setPairs((prev) =>
        prev.filter(
          (p) => p.example_id_a !== exampleId && p.example_id_b !== exampleId,
        ),
      )
      onExamplesChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleRemoveAllLowerScored() {
    const toDelete: string[] = []
    for (const p of pairs) {
      if (p.judge_score_a != null && p.judge_score_b != null) {
        if (p.judge_score_a < p.judge_score_b) toDelete.push(p.example_id_a)
        else if (p.judge_score_b < p.judge_score_a) toDelete.push(p.example_id_b)
      }
    }
    const unique = [...new Set(toDelete)]
    if (unique.length === 0) return
    if (!window.confirm(`Delete ${unique.length} lower-scored example(s)?`)) return

    setDeletingId('bulk')
    try {
      for (const id of unique) {
        await deleteExample(jobId, id)
      }
      setPairs((prev) =>
        prev.filter(
          (p) =>
            !unique.includes(p.example_id_a) && !unique.includes(p.example_id_b),
        ),
      )
      onExamplesChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Bulk delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  function toggleExpanded(index: number) {
    setExpandedPairs((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const hasJudgeScores = pairs.some(
    (p) => p.judge_score_a != null && p.judge_score_b != null,
  )

  const thresholdLabel =
    threshold >= 0.95
      ? 'Nearly identical'
      : threshold >= 0.85
        ? 'High similarity'
        : threshold >= 0.7
          ? 'Moderate similarity'
          : 'Loose matching'

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2',
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
            <Dialog.Title className="text-base font-semibold">
              {state === 'results' && pairs.length > 0
                ? `Found ${pairs.length} duplicate pair${pairs.length !== 1 ? 's' : ''}`
                : 'Duplicate Detection'}
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon" onClick={handleClose}>
                  <X className="size-4" />
                </Button>
              }
            />
          </div>

          {/* Content */}
          <div className="px-6 py-5">
            {/* Config state */}
            {state === 'config' && (
              <div className="space-y-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Similarity Threshold</label>
                    <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-xs">
                      {threshold.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={1.0}
                    step={0.01}
                    value={threshold}
                    onChange={(e) => setThreshold(parseFloat(e.target.value))}
                    className="w-full accent-violet-500"
                  />
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>0.50 - Loose</span>
                    <span className="font-medium text-foreground/70">{thresholdLabel}</span>
                    <span>1.00 - Identical</span>
                  </div>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Compares all examples using TF-IDF text similarity. Higher threshold
                  means only near-identical pairs are flagged.
                </p>
              </div>
            )}

            {/* Scanning state */}
            {state === 'scanning' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 className="size-8 animate-spin text-violet-400" />
                <p className="text-sm text-muted-foreground">Analyzing examples...</p>
              </div>
            )}

            {/* Results state — no duplicates */}
            {state === 'results' && pairs.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-8">
                <CheckCircle2 className="size-10 text-emerald-400" />
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium">No duplicates found</p>
                  <p className="text-xs text-muted-foreground">
                    No example pairs above {Math.round(threshold * 100)}% similarity
                    in {totalExamples} examples.
                  </p>
                </div>
              </div>
            )}

            {/* Results state — pairs found */}
            {state === 'results' && pairs.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Threshold: {Math.round(threshold * 100)}% &middot;{' '}
                  {totalExamples} total examples
                </p>
                <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
                  {pairs.map((pair, i) => (
                    <PairCard
                      key={`${pair.example_id_a}-${pair.example_id_b}`}
                      pair={pair}
                      expanded={expandedPairs.has(i)}
                      onToggle={() => toggleExpanded(i)}
                      onDelete={handleDelete}
                      deletingId={deletingId}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Error state */}
            {state === 'error' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <AlertCircle className="size-10 text-red-400" />
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium">Scan failed</p>
                  <p className="text-xs text-muted-foreground">{errorMessage}</p>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-white/8 px-6 py-4">
            <div>
              {state === 'results' && pairs.length > 0 && hasJudgeScores && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="gap-1.5"
                  onClick={handleRemoveAllLowerScored}
                  disabled={deletingId != null}
                >
                  <Zap className="size-3.5" />
                  Remove all lower-scored
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {state === 'config' && (
                <>
                  <Button variant="ghost" size="sm" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button size="sm" className="gap-1.5" onClick={handleScan}>
                    Scan for Duplicates
                  </Button>
                </>
              )}
              {state === 'results' && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setState('config')
                      setExpandedPairs(new Set())
                    }}
                  >
                    Re-scan
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleClose}>
                    Close
                  </Button>
                </>
              )}
              {state === 'error' && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setState('config')}
                  >
                    Try again
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleClose}>
                    Close
                  </Button>
                </>
              )}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
