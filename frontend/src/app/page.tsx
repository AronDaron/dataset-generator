'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface HealthResponse {
  status: string
  timestamp: string
  service: string
  version: string
}

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const checkHealth = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/health')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: HealthResponse = await res.json()
      setHealth(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    checkHealth()
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Dataset Generator — Faza 0</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && (
            <p className="text-muted-foreground">Sprawdzam backend...</p>
          )}
          {error && (
            <p className="text-destructive">
              Błąd połączenia z backendem: {error}
            </p>
          )}
          {health && (
            <div className="space-y-1 text-sm">
              <p>
                Status:{' '}
                <span className="font-medium text-green-600">{health.status}</span>
              </p>
              <p>
                Serwis: {health.service} v{health.version}
              </p>
              <p>Czas: {new Date(health.timestamp).toLocaleString('pl-PL')}</p>
            </div>
          )}
          <Button onClick={checkHealth} disabled={loading}>
            {loading ? 'Sprawdzam...' : 'Odśwież'}
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
