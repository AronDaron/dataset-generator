import { cn } from '@/lib/utils'

function InlineCode({ children }: { children: string }) {
  return (
    <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-xs text-emerald-300/90">
      {children}
    </code>
  )
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="my-3">
      {lang && (
        <span className="inline-block rounded-t border border-b-0 border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {lang}
        </span>
      )}
      <pre
        className={cn(
          'overflow-x-auto rounded-md border border-white/10 bg-black/30 p-4',
          lang && 'rounded-tl-none',
        )}
      >
        <code className="font-mono text-sm leading-relaxed text-emerald-300/90">{code}</code>
      </pre>
    </div>
  )
}

function PlainTextSegment({ text }: { text: string }) {
  const parts = text.split('`')
  return (
    <span className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
      {parts.map((part, i) =>
        i % 2 === 1 ? <InlineCode key={i}>{part}</InlineCode> : part,
      )}
    </span>
  )
}

export function FormattedContent({ content }: { content: string }) {
  if (!content.trim()) {
    return <span className="italic text-muted-foreground">Empty</span>
  }

  const segments = content.split('```')

  return (
    <div>
      {segments.map((seg, i) => {
        if (i % 2 === 0) {
          return seg ? <PlainTextSegment key={i} text={seg} /> : null
        }
        const newline = seg.indexOf('\n')
        if (newline === -1) {
          return <PlainTextSegment key={i} text={seg} />
        }
        const lang = seg.slice(0, newline).trim()
        const code = seg.slice(newline + 1).replace(/\n$/, '')
        return <CodeBlock key={i} lang={lang} code={code} />
      })}
    </div>
  )
}
