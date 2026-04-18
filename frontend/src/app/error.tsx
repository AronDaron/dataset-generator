'use client'

import { useEffect } from 'react'

export default function ErrorPage({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <div className="space-y-3 text-center">
        <h1 className="font-serif text-2xl italic text-destructive">Something went wrong</h1>
        <p className="text-sm text-text-3">{error.message}</p>
        <button
          className="cursor-pointer text-sm text-primary hover:underline"
          onClick={unstable_retry}
        >
          Try again
        </button>
      </div>
    </div>
  )
}
