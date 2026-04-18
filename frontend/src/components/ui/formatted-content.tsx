'use client'

import { useCallback, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

type TokenKind = 'kw' | 'fn' | 'str' | 'num' | 'cmt' | 'type' | 'text'

const TOKEN_CLASS: Record<TokenKind, string> = {
  kw: 'text-[oklch(0.80_0.12_300)]',
  fn: 'text-[oklch(0.78_0.12_220)]',
  str: 'text-[oklch(0.80_0.12_55)]',
  num: 'text-[oklch(0.78_0.13_40)]',
  cmt: 'italic text-text-4',
  type: 'text-[oklch(0.78_0.14_180)]',
  text: '',
}

const KEYWORDS_BY_LANG: Record<string, Set<string>> = {
  js: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
    'break', 'continue', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'throw',
    'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'class', 'extends', 'super',
    'import', 'export', 'from', 'as', 'async', 'await', 'yield', 'this', 'null', 'undefined',
    'true', 'false', 'void',
  ]),
  ts: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
    'break', 'continue', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'throw',
    'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'class', 'extends', 'super',
    'import', 'export', 'from', 'as', 'async', 'await', 'yield', 'this', 'null', 'undefined',
    'true', 'false', 'void', 'interface', 'type', 'enum', 'public', 'private', 'protected',
    'readonly', 'abstract', 'implements', 'namespace', 'declare', 'keyof', 'infer',
  ]),
  py: new Set([
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue',
    'pass', 'try', 'except', 'finally', 'raise', 'import', 'from', 'as', 'with', 'lambda',
    'yield', 'global', 'nonlocal', 'in', 'is', 'not', 'and', 'or', 'True', 'False', 'None',
    'async', 'await', 'self', 'cls',
  ]),
}

const TYPES_BY_LANG: Record<string, Set<string>> = {
  ts: new Set(['string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint']),
  py: new Set(['int', 'str', 'float', 'bool', 'list', 'dict', 'tuple', 'set', 'bytes']),
  js: new Set([]),
}

function normalizeLang(lang: string): 'js' | 'ts' | 'py' | null {
  const l = lang.toLowerCase().trim()
  if (l === 'js' || l === 'javascript' || l === 'jsx') return 'js'
  if (l === 'ts' || l === 'typescript' || l === 'tsx') return 'ts'
  if (l === 'py' || l === 'python') return 'py'
  return null
}

function tokenize(code: string, lang: 'js' | 'ts' | 'py'): Array<[TokenKind, string]> {
  const tokens: Array<[TokenKind, string]> = []
  const keywords = KEYWORDS_BY_LANG[lang] ?? new Set<string>()
  const types = TYPES_BY_LANG[lang] ?? new Set<string>()
  const commentLine = lang === 'py' ? '#' : '//'
  const blockComments = lang === 'py' ? null : { open: '/*', close: '*/' }

  let i = 0
  let buf = ''
  const flush = () => {
    if (buf) {
      tokens.push(['text', buf])
      buf = ''
    }
  }

  while (i < code.length) {
    const ch = code[i]
    const rest = code.slice(i)

    // Line comment
    if (rest.startsWith(commentLine)) {
      flush()
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? code.length : nl
      tokens.push(['cmt', code.slice(i, end)])
      i = end
      continue
    }
    // Block comment
    if (blockComments && rest.startsWith(blockComments.open)) {
      flush()
      const close = code.indexOf(blockComments.close, i + 2)
      const end = close === -1 ? code.length : close + 2
      tokens.push(['cmt', code.slice(i, end)])
      i = end
      continue
    }
    // Strings
    if (ch === '"' || ch === "'" || ch === '`') {
      flush()
      const quote = ch
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === quote) { j++; break }
        j++
      }
      tokens.push(['str', code.slice(i, j)])
      i = j
      continue
    }
    // Numbers
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z_$]/.test(code[i - 1]))) {
      flush()
      let j = i
      while (j < code.length && /[0-9a-fA-FxX._]/.test(code[j])) j++
      tokens.push(['num', code.slice(i, j)])
      i = j
      continue
    }
    // Identifier / keyword / function-call / type
    if (/[A-Za-z_$]/.test(ch)) {
      flush()
      let j = i
      while (j < code.length && /[A-Za-z0-9_$]/.test(code[j])) j++
      const word = code.slice(i, j)
      let kind: TokenKind = 'text'
      if (keywords.has(word)) kind = 'kw'
      else if (types.has(word)) kind = 'type'
      else if (code[j] === '(') kind = 'fn'
      tokens.push([kind, word])
      i = j
      continue
    }
    buf += ch
    i++
  }
  flush()
  return tokens
}

function renderCode(code: string, lang: string): React.ReactNode {
  const normalized = normalizeLang(lang)
  if (!normalized) return code
  const tokens = tokenize(code, normalized)
  return tokens.map(([kind, text], idx) => {
    const cls = TOKEN_CLASS[kind]
    return cls ? <span key={idx} className={cls}>{text}</span> : <span key={idx}>{text}</span>
  })
}

function InlineCode({ children }: { children: string }) {
  return (
    <code className="rounded-md border border-border bg-bg-2 px-1.5 py-0.5 font-mono text-[0.9em] text-warn">
      {children}
    </code>
  )
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(() => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }, [code])

  return (
    <div className="my-3 overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--color-bg-code)]">
      {(lang || true) && (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-3 px-3 py-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-text-3">
            {lang || 'text'}
          </span>
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-text-2 transition-colors hover:bg-bg-2 hover:text-text-0"
          >
            {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <pre className="overflow-x-auto p-4">
        <code className="font-mono text-sm leading-relaxed text-text-1">
          {renderCode(code, lang)}
        </code>
      </pre>
    </div>
  )
}

function PlainTextSegment({ text }: { text: string }) {
  const parts = text.split('`')
  return (
    <span className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
      {parts.map((part, i) =>
        i % 2 === 1 ? <InlineCode key={i}>{part}</InlineCode> : part,
      )}
    </span>
  )
}

export function FormattedContent({ content }: { content: string }) {
  if (!content.trim()) {
    return <span className="italic text-text-3">Empty</span>
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
