export const STATUS_LABELS: Record<string, string> = {
  pending:     'Pending',
  running:     'Running',
  cancelling:  'Cancelling…',
  cancelled:   'Cancelled',
  completed:   'Completed',
  failed:      'Failed',
  interrupted: 'Interrupted',
}

export const STAGE_LABELS: Record<string, string> = {
  pending:             'Awaiting start',
  generating_topics:   'Generating topics',
  generating_examples: 'Generating examples',
  completed:           'Completed',
  cancelled:           'Cancelled',
  failed:              'Generation error',
  interrupted:         'Interrupted',
}

export interface StatusTone {
  head: string
  dot: string
  status: string
  barClass: string
}

export function getStatusTone(status: string, isRunning = false): StatusTone {
  switch (status) {
    case 'completed':
      return {
        head: 'text-primary',
        dot: 'bg-primary shadow-[0_0_8px_var(--color-primary)]',
        status: 'text-ok',
        barClass: 'bg-gradient-to-r from-[oklch(0.50_0.14_145)] to-primary',
      }
    case 'failed':
      return {
        head: 'text-destructive',
        dot: 'bg-destructive shadow-[0_0_6px_var(--color-destructive)]',
        status: 'text-destructive',
        barClass: 'bg-destructive',
      }
    case 'cancelled':
      return {
        head: 'text-text-2',
        dot: 'bg-text-3',
        status: 'text-text-3',
        barClass: 'bg-text-4',
      }
    case 'cancelling':
      return {
        head: 'text-warn',
        dot: 'bg-warn animate-pulse',
        status: 'text-warn',
        barClass: 'bg-warn',
      }
    case 'interrupted':
      return {
        head: 'text-warn',
        dot: 'bg-warn',
        status: 'text-warn',
        barClass: 'bg-warn',
      }
    case 'running':
      return {
        head: 'text-info',
        dot: 'bg-info animate-pulse shadow-[0_0_6px_var(--color-info)]',
        status: 'text-info',
        barClass: isRunning ? 'progress-running' : 'bg-gradient-to-r from-[oklch(0.50_0.14_145)] to-primary',
      }
    default:
      return {
        head: 'text-text-2',
        dot: 'bg-text-3',
        status: 'text-text-3',
        barClass: 'bg-text-4',
      }
  }
}
