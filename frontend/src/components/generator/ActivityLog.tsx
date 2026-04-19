'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatClock, formatRelative } from '@/lib/relative-time'
import type { ActivityEvent, ActivityLevel } from '@/lib/api'

const LEVELS: ActivityLevel[] = ['info', 'warn', 'error']

const DOT_COLOR: Record<ActivityLevel, string> = {
  info:  'bg-info',
  warn:  'bg-warn',
  error: 'bg-destructive',
}

const CHIP_COLOR: Record<ActivityLevel, string> = {
  info:  'text-info border-info/30',
  warn:  'text-warn border-warn/30',
  error: 'text-destructive border-destructive/30',
}

export function ActivityLog({ events }: { events: ActivityEvent[] }) {
  const [visible, setVisible] = useState<Set<ActivityLevel>>(
    () => new Set<ActivityLevel>(LEVELS),
  )
  const [isPaused, setIsPaused] = useState(false)
  const [showJumpBadge, setShowJumpBadge] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(
    () => events.filter((e) => visible.has(e.level)),
    [events, visible],
  )

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (isPaused) return
    el.scrollTop = el.scrollHeight
  }, [filtered.length, isPaused])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    setShowJumpBadge(distanceFromBottom > 24)
  }

  function jumpToBottom() {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setIsPaused(false)
    setShowJumpBadge(false)
  }

  function toggleLevel(level: ActivityLevel) {
    setVisible((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-2">
      {/* Header: title + level filter chips */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-text-3">
          Activity log
        </p>
        <div className="flex items-center gap-1">
          {LEVELS.map((level) => {
            const active = visible.has(level)
            return (
              <button
                key={level}
                type="button"
                onClick={() => toggleLevel(level)}
                className={cn(
                  'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition',
                  active
                    ? CHIP_COLOR[level]
                    : 'text-text-3 border-border opacity-50 hover:opacity-100',
                )}
              >
                {level}
              </button>
            )
          })}
        </div>
      </div>

      {/* Scrollable event list */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        className="relative h-64 overflow-y-auto overflow-x-hidden rounded-lg bg-bg-0 border border-border"
      >
        {filtered.length === 0 ? (
          <p className="flex h-full items-center justify-center text-xs italic text-text-3">
            Waiting for events…
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {filtered.map((e) => (
              <li
                key={e.seq}
                className="px-2.5 py-1.5 flex items-start gap-2 font-mono text-[11px] leading-snug"
              >
                <span className="text-text-3 tabular-nums shrink-0">
                  {formatClock(e.ts)}
                </span>
                <span
                  className={cn('mt-1 size-1.5 rounded-full shrink-0', DOT_COLOR[e.level])}
                />
                <span className="flex-1 text-text-1 break-words">{e.message}</span>
                <span className="text-text-3 tabular-nums shrink-0">
                  {formatRelative(e.ts, now)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* Jump-to-bottom badge */}
        {showJumpBadge && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="sticky bottom-2 ml-auto mr-2 flex items-center gap-1 rounded-full border border-border bg-bg-2 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-text-2 shadow-md hover:text-text-0"
            style={{ float: 'right' }}
          >
            <ChevronDown className="size-3" />
            latest
          </button>
        )}
      </div>
    </div>
  )
}
