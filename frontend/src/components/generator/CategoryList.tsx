'use client'

import { Plus, Check } from 'lucide-react'
import { CategoryCard } from './CategoryCard'
import {
  type Category,
  addCategory,
  removeCategory,
  adjustProportion,
} from '@/lib/proportions'
import type { SelectOption } from '@/components/ui/select'

// ---------- Preset categories ----------
interface Preset {
  name: string
  description: string
}

const PRESETS: Preset[] = [
  {
    name: 'Frontend',
    description:
      'Q&A about frontend programming: React, TypeScript, CSS, HTML, and modern UI frameworks.',
  },
  {
    name: 'Backend',
    description:
      'Topics covering backend programming: Node.js, Python, REST APIs, databases, and service architecture.',
  },
  {
    name: 'Python',
    description:
      'Code examples, questions, and explanations about Python: syntax, standard libraries, patterns, and best practices.',
  },
  {
    name: 'TypeScript',
    description:
      'Typing, interfaces, generics, and advanced TypeScript features in the context of modern JavaScript.',
  },
  {
    name: 'DevOps',
    description:
      'Docker, CI/CD, Kubernetes, deployment automation, and cloud infrastructure management.',
  },
  {
    name: 'SQL',
    description:
      'SQL queries, schema design, optimization, transactions, and relational and non-relational data modeling.',
  },
  {
    name: 'Machine Learning',
    description:
      'Machine learning concepts, model fine-tuning, data preprocessing, and practical ML applications.',
  },
  {
    name: 'Algorithms',
    description:
      'Data structures, sorting and search algorithms, computational complexity, and problem-solving.',
  },
  {
    name: 'Security',
    description:
      'Web security, OWASP Top 10, authorization, authentication, and secure coding practices.',
  },
  {
    name: 'System Design',
    description:
      'Designing scalable systems, architectural patterns, microservices, and distributed systems.',
  },
]

const CATEGORY_PALETTE = [
  { tailwind: 'bg-blue-400',    hex: '#60a5fa' },
  { tailwind: 'bg-emerald-400', hex: '#34d399' },
  { tailwind: 'bg-violet-400',  hex: '#a78bfa' },
  { tailwind: 'bg-amber-400',   hex: '#fbbf24' },
  { tailwind: 'bg-rose-400',    hex: '#fb7185' },
  { tailwind: 'bg-cyan-400',    hex: '#22d3ee' },
  { tailwind: 'bg-orange-400',  hex: '#fb923c' },
  { tailwind: 'bg-pink-400',    hex: '#f472b6' },
  { tailwind: 'bg-teal-400',    hex: '#2dd4bf' },
  { tailwind: 'bg-indigo-400',  hex: '#818cf8' },
]

export const CATEGORY_COLORS    = CATEGORY_PALETTE.map((c) => c.tailwind)
export const CATEGORY_COLOR_HEX = CATEGORY_PALETTE.map((c) => c.hex)

function makeId(): string {
  return crypto.randomUUID()
}

interface CategoryListProps {
  categories: Category[]
  onChange: (categories: Category[]) => void
  modelOptions?: SelectOption[]
  judgeEnabled?: boolean
}

export function CategoryList({ categories, onChange, modelOptions = [], judgeEnabled = false }: CategoryListProps) {
  const isFull = categories.length >= 10

  function isPresetActive(name: string): boolean {
    return categories.some((c) => c.name === name)
  }

  function handlePresetToggle(preset: Preset) {
    if (isPresetActive(preset.name)) {
      const cat = categories.find((c) => c.name === preset.name)
      if (cat) onChange(removeCategory(categories, cat.id))
    } else {
      if (isFull) return
      onChange(addCategory(categories, { id: makeId(), name: preset.name, description: preset.description }))
    }
  }

  function handleAddCustom() {
    if (isFull) return
    onChange(addCategory(categories, { id: makeId(), name: '', description: '' }))
  }

  function handleRemove(id: string) {
    onChange(removeCategory(categories, id))
  }

  function handleUpdate(id: string, patch: Partial<Omit<Category, 'id'>>) {
    onChange(categories.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  function handleProportionChange(id: string, value: number) {
    onChange(adjustProportion(categories, id, value))
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-foreground/90">Dataset categories</h2>
        <p className="mt-0.5 text-xs text-muted-foreground/70">
          Select preset categories or add a custom one. Proportions must sum to 100%.
        </p>
      </div>

      {/* Preset chips */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70">
          Presets
        </p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => {
            const active = isPresetActive(preset.name)
            return (
              <button
                key={preset.name}
                onClick={() => handlePresetToggle(preset)}
                disabled={!active && isFull}
                title={preset.description}
                className={[
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium',
                  'transition-all duration-150 backdrop-blur-sm',
                  'hover:scale-[1.04] active:scale-[0.96]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100',
                  active
                    ? 'border-primary/40 bg-primary/12 text-primary shadow-[0_0_12px_oklch(0.65_0.22_292/0.20)]'
                    : 'border-white/8 bg-white/3 text-foreground/55 hover:bg-white/7 hover:text-foreground/85 hover:border-white/16',
                ].join(' ')}
              >
                {active && <Check className="size-3.5" />}
                {preset.name}
              </button>
            )
          })}

          <button
            onClick={handleAddCustom}
            disabled={isFull}
            className={[
              'inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-xs font-medium',
              'transition-all duration-150 backdrop-blur-sm',
              'hover:scale-[1.04] active:scale-[0.96]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100',
              'border-white/12 text-white/35 hover:border-primary/45 hover:text-primary hover:bg-primary/8',
            ].join(' ')}
          >
            <Plus className="size-3.5" />
            Custom
          </button>
        </div>
        {isFull && (
          <p className="text-xs text-muted-foreground">Maximum 10 categories.</p>
        )}
      </div>

      {/* Active categories */}
      {categories.length > 0 && (
        <div className="space-y-3.5">
          <div className="flex items-center gap-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70">
              Active ({categories.length}/10)
            </p>
            {/* Proportion bar */}
            <div className="flex h-1.5 flex-1 overflow-hidden rounded-full">
              {categories.map((cat, i) => (
                <div
                  key={cat.id}
                  className={CATEGORY_COLORS[i % CATEGORY_COLORS.length]}
                  style={{ width: `${cat.proportion}%` }}
                  title={`${cat.name || 'Category'}: ${cat.proportion}%`}
                />
              ))}
            </div>
          </div>

          {/* 2-column grid on larger screens */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {categories.map((cat, i) => (
              <CategoryCard
                key={cat.id}
                category={cat}
                index={i}
                totalCategories={categories.length}
                canRemove={true}
                modelOptions={modelOptions}
                judgeEnabled={judgeEnabled}
                onUpdate={handleUpdate}
                onRemove={handleRemove}
                onProportionChange={handleProportionChange}
              />
            ))}
          </div>
        </div>
      )}

      {categories.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 py-14 text-center text-sm text-muted-foreground">
          Click a preset above or add a custom category to get started.
        </div>
      )}
    </div>
  )
}
