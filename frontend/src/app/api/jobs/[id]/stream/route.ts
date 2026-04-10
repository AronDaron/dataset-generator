export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * SSE proxy: streams /api/jobs/{id}/stream from the FastAPI backend.
 *
 * Uses explicit ReadableStream piping instead of passing upstream.body
 * directly, to avoid undici/Web API ReadableStream compatibility issues
 * in Next.js 16.
 *
 * NOTE: JobDashboard currently connects directly to http://localhost:8000
 * (bypassing this route) because Next.js fetch can still interfere with
 * long-lived streaming responses. Keep this route as a fallback.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const upstream = await fetch(
    `http://localhost:8000/api/jobs/${id}/stream`,
    {
      cache: 'no-store',
      signal: request.signal,
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    },
  )

  if (!upstream.ok || !upstream.body) {
    return new Response('upstream error', { status: 502 })
  }

  const reader = upstream.body.getReader()

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch {
        controller.close()
      }
    },
    cancel() {
      reader.cancel()
    },
  })

  return new Response(stream, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}
