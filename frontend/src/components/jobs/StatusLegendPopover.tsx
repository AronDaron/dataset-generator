'use client'

import { Popover } from '@base-ui/react/popover'
import { HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STATUS_LABELS, STAGE_LABELS, getStatusTone } from '@/lib/status-tone'

const STATUS_ENTRIES: Array<{ key: string; description: string }> = [
  { key: 'running',    description: 'Generation in progress' },
  { key: 'cancelling', description: 'Stopping…' },
  { key: 'cancelled',  description: 'Stopped by user' },
  { key: 'completed',  description: 'Finished successfully' },
  { key: 'failed',     description: 'Aborted due to error' },
]

const STAGE_ENTRIES: Array<{ key: string; description: string }> = [
  { key: 'generating_topics',   description: 'Building outlines per category' },
  { key: 'generating_examples', description: 'Producing examples from topics' },
]

interface OutcomeChip {
  label: string
  description: string
  toneClass: string
}

const OUTCOMES: OutcomeChip[] = [
  { label: 'generated', description: 'Successfully produced & saved',     toneClass: 'border-border bg-bg-0 text-text-0' },
  { label: 'skipped',   description: 'All retries failed (format/parse)', toneClass: 'border-border bg-bg-0 text-warn' },
  { label: 'evaluated', description: 'Sent to the judge model',           toneClass: 'border-border bg-bg-0 text-text-0' },
  { label: 'accepted',  description: '≥ threshold → in dataset',          toneClass: 'border-border bg-bg-0 text-ok' },
  { label: 'rejected',  description: '< threshold → NOT in dataset',      toneClass: 'border-border bg-bg-0 text-destructive' },
  { label: 'avg score', description: 'Mean across accepted examples',     toneClass: 'border-border bg-bg-0 text-ok' },
]

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[10.5px] font-semibold uppercase tracking-widest text-text-3">
      {children}
    </h4>
  )
}

export function StatusLegendPopover() {
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={120}
        closeDelay={120}
        aria-label="Status legend"
        className={cn(
          'inline-flex size-6 items-center justify-center rounded-full',
          'text-text-3 transition-colors hover:text-text-1 hover:bg-bg-2',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        )}
      >
        <HelpCircle className="size-3.5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end">
          <Popover.Popup
            className={cn(
              'z-50 w-80 max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-card p-5',
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

            <Popover.Title className="mb-4 font-serif text-base italic tracking-[-0.01em] text-text-0">
              Status Legend
            </Popover.Title>

            {/* Job status */}
            <div className="space-y-2.5">
              <SectionHeader>Job Status</SectionHeader>
              <ul className="space-y-1.5">
                {STATUS_ENTRIES.map(({ key, description }) => {
                  const tone = getStatusTone(key)
                  return (
                    <li key={key} className="flex items-center gap-2.5 text-[12.5px]">
                      <span className={cn('size-2 shrink-0 rounded-full', tone.dot)} />
                      <span className={cn('w-20 shrink-0 font-medium', tone.head)}>
                        {STATUS_LABELS[key] ?? key}
                      </span>
                      <span className="text-text-2">{description}</span>
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className="my-4 h-px bg-border" />

            {/* Stage */}
            <div className="space-y-2.5">
              <SectionHeader>Stage</SectionHeader>
              <ul className="space-y-1.5">
                {STAGE_ENTRIES.map(({ key, description }) => (
                  <li key={key} className="flex items-baseline gap-2.5 text-[12.5px]">
                    <span className="w-[140px] shrink-0 text-text-1">
                      {STAGE_LABELS[key] ?? key}
                    </span>
                    <span className="text-text-2">{description}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="my-4 h-px bg-border" />

            {/* Example outcomes */}
            <div className="space-y-2.5">
              <SectionHeader>Example Outcomes</SectionHeader>
              <ul className="space-y-1.5">
                {OUTCOMES.map((o) => (
                  <li key={o.label} className="flex items-center gap-2.5 text-[12.5px]">
                    <span
                      className={cn(
                        'inline-flex w-[78px] shrink-0 items-center justify-center rounded-full border px-2 py-0.5 font-mono text-[10.5px]',
                        o.toneClass,
                      )}
                    >
                      {o.label}
                    </span>
                    <span className="text-text-2">{o.description}</span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="mt-4 border-t border-border pt-3 text-[11.5px] italic text-text-3">
              Rejected & skipped examples are not saved — only accepted (or generated, if judge is disabled).
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
