'use client'

import { useEffect, useState } from 'react'
import { getModelEndpoints } from '@/lib/api'
import type { SelectOption } from '@/components/ui/select'

/**
 * Routing-provider picker options for a given model id.
 *
 * Fetches the model's endpoints, drops duplicates by routing name and labels
 * each entry with latency + 30-day uptime. An empty/undefined `modelId`
 * yields no options (nothing to route yet), and a failed fetch degrades to an
 * empty list rather than blocking the form — provider choice is optional.
 */
export function useProviderOptions(modelId: string | undefined): {
  options: SelectOption[]
  loading: boolean
} {
  const [options, setOptions] = useState<SelectOption[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!modelId) {
      setOptions([])
      return
    }
    let cancelled = false
    setLoading(true)
    getModelEndpoints(modelId)
      .then((endpoints) => {
        if (cancelled) return
        const seen = new Set<string>()
        const opts: SelectOption[] = endpoints
          .filter((e) => {
            const key = e.provider_name || e.name
            if (!key || seen.has(key)) return false
            seen.add(key)
            return true
          })
          .map((e) => {
            const routingName = e.provider_name || e.name
            const parts: string[] = [routingName]
            if (e.latency != null) parts.push(`${Math.round(e.latency)}ms`)
            if (e.uptime_last_30m != null)
              parts.push(`${e.uptime_last_30m.toFixed(1)}% up`)
            return { value: routingName, label: parts.join(' · ') }
          })
        setOptions(opts)
      })
      .catch(() => {
        if (!cancelled) setOptions([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [modelId])

  return { options, loading }
}
