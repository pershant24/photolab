/**
 * The canvas and its render loop.
 *
 * Holds no editor state. It owns the {@link Renderer}'s lifetime and reports the
 * two failures a user can actually encounter: a browser that cannot support the
 * pipeline, and a lost GPU context.
 */

import { useEffect, useRef, useState } from 'react'

import { RendererUnsupportedError } from '../render/gl/context'
import { DEFAULT_RENDER_STATE, Renderer } from '../render/renderer'

type Status = { kind: 'starting' } | { kind: 'running' } | { kind: 'failed'; message: string }

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'starting' })
  const [contextLost, setContextLost] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let renderer: Renderer
    try {
      renderer = new Renderer(canvas)
    } catch (error) {
      // A browser without WebGL2 or without a half-float framebuffer gets a
      // sentence it can act on, not a stack trace and not a silently degraded
      // 8-bit image.
      const message =
        error instanceof RendererUnsupportedError
          ? error.message
          : 'The renderer failed to start. See the browser console for details.'
      setStatus({ kind: 'failed', message })
      if (!(error instanceof RendererUnsupportedError)) console.error(error)
      return
    }

    renderer.setState(DEFAULT_RENDER_STATE)
    const unsubscribe = renderer.context.onStatusChange((next) => setContextLost(next === 'lost'))

    renderer.syncSize()
    renderer.renderNow()
    renderer.start()
    setStatus({ kind: 'running' })

    const observer = new ResizeObserver(() => {
      if (renderer.syncSize()) renderer.renderNow()
    })
    observer.observe(canvas)

    // Exposed for the browser tests, which need to reach the graph's compile and
    // allocation counters. Development-time only; it is not an API.
    ;(window as unknown as { __photolabRenderer?: Renderer }).__photolabRenderer = renderer

    return () => {
      observer.disconnect()
      unsubscribe()
      renderer.dispose()
      delete (window as unknown as { __photolabRenderer?: Renderer }).__photolabRenderer
    }
  }, [])

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <canvas
        ref={canvasRef}
        data-testid="viewport-canvas"
        className="h-full w-full"
        aria-label="Render output"
      />

      {status.kind === 'failed' && (
        <div
          role="alert"
          className="absolute inset-0 flex items-center justify-center bg-surface/90 p-8"
        >
          <p className="max-w-md text-center text-sm text-ink">{status.message}</p>
        </div>
      )}

      {contextLost && (
        <div
          role="alert"
          className="absolute inset-0 flex items-center justify-center bg-surface/90 p-8"
        >
          <p className="max-w-md text-center text-sm text-ink">
            The graphics context was lost, usually because the GPU was reset or the
            machine went to sleep. Reload the page to continue.
          </p>
        </div>
      )}
    </div>
  )
}
