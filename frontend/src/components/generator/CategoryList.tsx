'use client'

import { Plus, Check } from 'lucide-react'
import { CategoryCard } from './CategoryCard'
import {
  type Category,
  addCategory,
  removeCategory,
  adjustProportion,
} from '@/lib/proportions'

// ---------- Preset categories ----------
interface Preset {
  name: string
  description: string
}

const PRESETS: Preset[] = [
  {
    name: 'Frontend',
    description:
      'Pytania i odpowiedzi dotyczące programowania frontendowego: React, TypeScript, CSS, HTML i nowoczesne frameworki UI.',
  },
  {
    name: 'Backend',
    description:
      'Zagadnienia z zakresu programowania backendowego: Node.js, Python, REST API, bazy danych i architektura serwisów.',
  },
  {
    name: 'Python',
    description:
      'Przykłady kodu, pytania i wyjaśnienia dotyczące języka Python: składnia, biblioteki standardowe, wzorce i dobre praktyki.',
  },
  {
    name: 'TypeScript',
    description:
      'Typowanie, interfejsy, generyki i zaawansowane funkcje TypeScript w kontekście nowoczesnego JavaScriptu.',
  },
  {
    name: 'DevOps',
    description:
      'Docker, CI/CD, Kubernetes, automatyzacja wdrożeń i zarządzanie infrastrukturą chmurową.',
  },
  {
    name: 'SQL',
    description:
      'Zapytania SQL, projektowanie schematów, optymalizacja, transakcje i modelowanie danych relacyjnych i nierelacyjnych.',
  },
  {
    name: 'Machine Learning',
    description:
      'Koncepcje uczenia maszynowego, fine-tuning modeli, preprocessing danych i praktyczne zastosowania ML.',
  },
  {
    name: 'Algorytmy',
    description:
      'Struktury danych, algorytmy sortowania i wyszukiwania, złożoność obliczeniowa i rozwiązywanie problemów.',
  },
  {
    name: 'Bezpieczeństwo',
    description:
      'Web security, OWASP Top 10, autoryzacja, uwierzytelnianie i bezpieczne praktyki kodowania.',
  },
  {
    name: 'System Design',
    description:
      'Projektowanie skalowalnych systemów, wzorce architektoniczne, microservices i distributed systems.',
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
}

export function CategoryList({ categories, onChange }: CategoryListProps) {
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
        <h2 className="text-base font-semibold">Kategorie datasetu</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Wybierz gotowe kategorie lub dodaj własną. Suma proporcji = 100%.
        </p>
      </div>

      {/* Preset chips */}
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Gotowe kategorie
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
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-foreground hover:bg-muted',
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
              'inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              'disabled:cursor-not-allowed disabled:opacity-40',
              'border-border text-muted-foreground hover:border-primary hover:text-primary',
            ].join(' ')}
          >
            <Plus className="size-3.5" />
            Własna
          </button>
        </div>
        {isFull && (
          <p className="text-xs text-muted-foreground">Maksymalnie 10 kategorii.</p>
        )}
      </div>

      {/* Active categories */}
      {categories.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Aktywne ({categories.length}/10)
            </p>
            {/* Proportion bar */}
            <div className="flex h-1.5 flex-1 overflow-hidden rounded-full">
              {categories.map((cat, i) => (
                <div
                  key={cat.id}
                  className={CATEGORY_COLORS[i % CATEGORY_COLORS.length]}
                  style={{ width: `${cat.proportion}%` }}
                  title={`${cat.name || 'Kategoria'}: ${cat.proportion}%`}
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
          Kliknij kategorię powyżej, aby zacząć budować dataset.
        </div>
      )}
    </div>
  )
}
