'use client'

import { Popover } from '@base-ui/react/popover'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'

interface HintPopoverProps {
  children: React.ReactNode
  className?: string
  iconSize?: number
}

export function HintPopover({ children, className, iconSize = 12 }: HintPopoverProps) {
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={120}
        closeDelay={120}
        aria-label="More info"
        className={cn(
          'inline-flex size-5 items-center justify-center rounded-full',
          'text-text-3 transition-colors hover:text-text-1 hover:bg-bg-2',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          className,
        )}
      >
        <Info style={{ width: iconSize, height: iconSize }} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="center">
          <Popover.Popup
            className={cn(
              'z-50 max-w-xs rounded-xl border border-border bg-card px-3.5 py-2.5',
              'text-[12px] leading-relaxed text-text-2',
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
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
