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
    <div className="min-h-full flex items-center justify-center p-8">
      <div className="text-center space-y-3">
        <h1 className="text-xl font-semibold text-red-400">Something went wrong</h1>
        <p className="text-sm text-zinc-400">{error.message}</p>
        <button
          className="text-sm text-violet-400 hover:underline cursor-pointer"
          onClick={unstable_retry}
        >
          Try again
        </button>
      </div>
    </div>
  )
}
