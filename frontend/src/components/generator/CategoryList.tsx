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

// Pastel colors for segment bar / category dots (must match CategoryCard)
export const CATEGORY_COLORS = [
  'bg-blue-400',
  'bg-emerald-400',
  'bg-violet-400',
  'bg-amber-400',
  'bg-rose-400',
  'bg-cyan-400',
  'bg-orange-400',
  'bg-pink-400',
  'bg-teal-400',
  'bg-indigo-400',
]

function makeId(): string {
  return crypto.randomUUID()
}

interface CategoryListProps {
  categories: Category[]
  onChange: (categories: Category[]) => void
  modelOptions?: SelectOption[]
}

export function CategoryList({ categories, onChange, modelOptions = [] }: CategoryListProps) {
  const isFull = categories.length >= 10

  // Check if a preset name is already active (by exact name match)
  function isPresetActive(name: string): boolean {
    return categories.some((c) => c.name === name)
  }

  function handlePresetToggle(preset: Preset) {
    if (isPresetActive(preset.name)) {
      // Remove by name
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
        <h2 className="text-base font-semibold">Dataset categories</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Select preset categories or add a custom one. Proportions must sum to 100%.
        </p>
      </div>

      {/* Preset chips */}
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Preset categories
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
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all backdrop-blur-sm',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                  active
                    ? 'border-primary/35 bg-primary/10 text-primary shadow-[0_0_8px_oklch(0.62_0.20_228/0.18)] ring-1 ring-primary/14'
                    : 'border-white/10 bg-white/5 text-foreground/70 hover:bg-white/10 hover:text-foreground hover:border-white/20',
                ].join(' ')}
              >
                {active && <Check className="size-3.5" />}
                {preset.name}
              </button>
            )
          })}

          {/* Custom category button */}
          <button
            onClick={handleAddCustom}
            disabled={isFull}
            className={[
              'inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-sm font-medium transition-all backdrop-blur-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              'disabled:cursor-not-allowed disabled:opacity-40',
              'border-white/15 text-white/40 hover:border-primary/50 hover:text-primary hover:bg-primary/10',
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
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
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

          <div className="space-y-3">
            {categories.map((cat, i) => (
              <CategoryCard
                key={cat.id}
                category={cat}
                index={i}
                totalCategories={categories.length}
                canRemove={true}
                modelOptions={modelOptions}
                onUpdate={handleUpdate}
                onRemove={handleRemove}
                onProportionChange={handleProportionChange}
              />
            ))}
          </div>
        </div>
      )}

      {categories.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          Click a category above to start building your dataset.
        </div>
      )}
    </div>
  )
}
