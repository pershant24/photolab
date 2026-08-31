/**
 * The canvas, its render loop, and image loading.
 *
 * Holds no editor state. It owns the {@link Renderer}'s lifetime and reports the
 * failures a user can actually encounter: a browser that cannot support the
 * pipeline, a lost GPU context, and an image that will not decode.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { RendererUnsupportedError } from '../render/gl/context'
import { ImageLoader, isSupersededError } from '../render/imageLoader'
import { DEFAULT_RENDER_STATE, Renderer } from '../render/renderer'

type Status = { kind: 'starting' } | { kind: 'running' } | { kind: 'failed'; message: string }

interface Session {
  renderer: Renderer
  loader: ImageLoader
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sessionRef = useRef<Session | null>(null)

  const [status, setStatus] = useState<Status>({ kind: 'starting' })
  const [contextLost, setContextLost] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [imageLabel, setImageLabel] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

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

    const loader = new ImageLoader()
    sessionRef.current = { renderer, loader }

    renderer.setState(DEFAULT_RENDER_STATE)
    const unsubscribe = renderer.context.onStatusChange((next) => setContextLost(next === 'lost'))

    const available = (): { width: number; height: number } => ({
      width: container.clientWidth,
      height: container.clientHeight,
    })

    renderer.renderNow(available())
    renderer.start()
    setStatus({ kind: 'running' })

    // The container is observed, not the canvas: the canvas is letterboxed to
    // the image's aspect ratio, so watching its own size would feed back.
    const observer = new ResizeObserver(() => {
      if (renderer.syncSize(available())) renderer.renderNow(available())
    })
    observer.observe(container)

    // Reached by the browser tests, which need the graph's counters and the
    // image path. Development-time only; it is not an API.
    ;(window as unknown as { __photolabRenderer?: Renderer }).__photolabRenderer = renderer

    return () => {
      observer.disconnect()
      unsubscribe()
      loader.dispose()
      renderer.dispose()
      sessionRef.current = null
      delete (window as unknown as { __photolabRenderer?: Renderer }).__photolabRenderer
    }
  }, [])

  const loadFile = useCallback(async (file: File) => {
    const session = sessionRef.current
    const container = containerRef.current
    if (!session || !container) return

    setLoading(true)
    setLoadError(null)
    try {
      const decoded = await session.loader.load(file)
      session.renderer.setImage(decoded.bitmap, decoded.sourceWidth, decoded.sourceHeight)
      // The proxy has been uploaded; the bitmap itself is no longer needed, and
      // at 2048px it is 16MB.
      decoded.bitmap.close()
      setImageLabel(`${file.name} — ${decoded.sourceWidth}x${decoded.sourceHeight}`)
      session.renderer.renderNow({
        width: container.clientWidth,
        height: container.clientHeight,
      })
    } catch (error) {
      // A superseded load is the expected outcome of picking a second file
      // while the first is still decoding, not a failure to report.
      if (!isSupersededError(error)) {
        setLoadError(error instanceof Error ? error.message : 'Could not load that image.')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-hairline px-4 py-2">
        <label className="cursor-pointer rounded border border-hairline px-2.5 py-1 text-xs text-ink hover:bg-surface-raised">
          Open image
          <input
            type="file"
            accept="image/jpeg,image/png"
            data-testid="image-input"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void loadFile(file)
              event.target.value = ''
            }}
          />
        </label>
        <span className="truncate text-xs text-ink-dim" data-testid="image-label">
          {loading ? 'Decoding…' : (imageLabel ?? 'Test pattern')}
        </span>
      </div>

      <div ref={containerRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        <canvas ref={canvasRef} data-testid="viewport-canvas" aria-label="Render output" />

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

        {loadError && (
          <div
            role="alert"
            data-testid="load-error"
            className="absolute inset-x-0 bottom-0 bg-surface-raised px-4 py-2 text-xs text-ink"
          >
            {loadError}
          </div>
        )}
      </div>
    </div>
  )
}
