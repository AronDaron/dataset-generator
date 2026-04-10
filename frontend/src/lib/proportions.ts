// Pure proportion math — no React, no side effects.
// Proportions are stored as integers 0–100 (percentages).
// Invariant: sum(categories.map(c => c.proportion)) === 100 at all times.
// Conversion to float 0–1 happens only at submission time.

export interface Category {
  id: string
  name: string
  description: string
  proportion: number // integer 1–99 (min 1 per category), sum === 100
}

// Distribute `total` across `n` slots as evenly as possible using integers.
// First `remainder` slots get (even + 1), the rest get `even`.
function distributeEvenly(
  total: number,
  n: number,
): number[] {
  if (n === 0) return []
  const even = Math.floor(total / n)
  const remainder = total - even * n
  return Array.from({ length: n }, (_, i) => even + (i < remainder ? 1 : 0))
}

// Add a new category. Proportions are redistributed evenly across all n+1 slots.
export function addCategory(
  categories: Category[],
  newCat: Omit<Category, 'proportion'>,
): Category[] {
  const n = categories.length + 1
  const shares = distributeEvenly(100, n)
  return [
    ...categories.map((c, i) => ({ ...c, proportion: shares[i] })),
    { ...newCat, proportion: shares[n - 1] },
  ]
}

// Remove a category by id. Remaining proportions are redistributed evenly.
export function removeCategory(
  categories: Category[],
  removeId: string,
): Category[] {
  const remaining = categories.filter((c) => c.id !== removeId)
  if (remaining.length === 0) return remaining
  const shares = distributeEvenly(100, remaining.length)
  return remaining.map((c, i) => ({ ...c, proportion: shares[i] }))
}

// Adjust a single slider. The chosen category gets `newVal` (clamped to keep
// every other category at minimum 1). The budget left over is distributed
// evenly across the other categories.
export function adjustProportion(
  categories: Category[],
  id: string,
  newVal: number,
): Category[] {
  const n = categories.length
  const min = 1
  const max = 100 - (n - 1) * min
  const clamped = Math.max(min, Math.min(max, Math.round(newVal)))
  const budget = 100 - clamped
  const others = categories.filter((c) => c.id !== id)
  const shares = distributeEvenly(budget, others.length)
  const adjustedOthers = others.map((c, i) => ({ ...c, proportion: shares[i] }))

  return categories.map((c) => {
    if (c.id === id) return { ...c, proportion: clamped }
    return adjustedOthers.find((a) => a.id === c.id)!
  })
}

// Convert integer proportions to floats summing to exactly 1.0.
// A rounding correction is applied to the last element.
export function toApiProportions(categories: Category[]): number[] {
  const floats = categories.map((c) => c.proportion / 100)
  const sum = floats.reduce((a, b) => a + b, 0)
  floats[floats.length - 1] += 1.0 - sum
  return floats
}
