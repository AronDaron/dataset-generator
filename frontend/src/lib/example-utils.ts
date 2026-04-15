export interface Turn {
  role: string
  content: string
}

export function normaliseRole(role: string): 'USER' | 'ASSISTANT' | 'SYSTEM' {
  if (role === 'human' || role === 'user') return 'USER'
  if (role === 'gpt' || role === 'assistant') return 'ASSISTANT'
  return 'SYSTEM'
}

export function parseTurnsFromContent(
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
