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
}: SliderFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      {(label || displayValue !== undefined) && (
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{label}</span>
          <span className="text-muted-foreground tabular-nums">
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
        className="relative flex w-full touch-none select-none items-center py-1"
      >
        <Slider.Control className="relative flex w-full items-center">
          <Slider.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
            <Slider.Indicator className="absolute h-full bg-primary rounded-full" />
          </Slider.Track>
          <Slider.Thumb
            className={cn(
              'block size-4 shrink-0 rounded-full border-2 border-background bg-primary shadow-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
              'data-[dragging]:cursor-grabbing cursor-grab',
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
