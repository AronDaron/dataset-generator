import { getProviderIcon } from '@/lib/provider-icons'
import type { ModelOption } from '@/lib/api'
import type { SelectOption } from '@/components/ui/select'

export function toGroupedOptions(list: ModelOption[]): SelectOption[] {
  return [...list]
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    .map((m) => {
      const prefix = m.id.split('/')[0]
      return {
        value: m.id,
        label: m.name || m.id,
        group: prefix.charAt(0).toUpperCase() + prefix.slice(1),
        icon: getProviderIcon(m.id),
      }
    })
}
