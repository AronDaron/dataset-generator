'use client'

import { Slider } from '@base-ui/react/slider'
import { cn } from '@/lib/utils'

interface SliderFieldProps {
  value: number
  onValueChange: (value: number) => void
  min: number
  max: number
  step: number
  label?: string
  sublabel?: string
  displayValue?: string
  className?: string
  disabled?: boolean
}

export function SliderField({
  value,
  onValueChange,
  min,
  max,
  step,
  label,
  sublabel,
  displayValue,
  className,
  disabled,
}: SliderFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      {(label || displayValue !== undefined) && (
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{label}</span>
          <span className="rounded-md border border-white/8 bg-white/5 px-1.5 py-0.5 font-mono text-xs tabular-nums text-foreground/80">
            {displayValue ?? value}
          </span>
        </div>
      )}
      <Slider.Root
        value={value}
        onValueChange={(v) => onValueChange(v as number)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="relative flex w-full touch-none select-none items-center py-1"
      >
        <Slider.Control className="relative flex w-full items-center">
          <Slider.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-white/8 ring-1 ring-white/5">
            <Slider.Indicator className="absolute h-full rounded-full bg-gradient-to-r from-primary/80 to-primary" />
          </Slider.Track>
          <Slider.Thumb
            className={cn(
              'block size-4 shrink-0 rounded-full bg-white',
              'shadow-[0_0_7px_oklch(0.65_0.22_292/0.55),0_2px_4px_oklch(0_0_0/0.4)]',
              'ring-2 ring-primary/28',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
              'data-[dragging]:cursor-grabbing data-[dragging]:scale-110 cursor-grab transition-transform',
            )}
          />
        </Slider.Control>
      </Slider.Root>
      {sublabel && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{sublabel.split('↔')[0]?.trim()}</span>
          <span>{sublabel.split('↔')[1]?.trim()}</span>
        </div>
      )}
    </div>
  )
}
