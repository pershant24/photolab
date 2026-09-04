/**
 * The canvas, its render loop, and image loading.
 *
 * Holds no editor state. It owns the {@link Renderer}'s lifetime and reports the
 * failures a user can actually encounter: a browser that cannot support the
 * pipeline, a lost GPU context, and an image that will not decode.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { FILM_STOCKS } from '../core/colour/filmStock'
import { editorStore } from '../core/state/editorStore'
import { imageKey, loadEdit, saveEdit } from '../core/state/sessionStore'
import type { EditorStoreState } from '../core/state/editorStore'
import { exportImage } from '../render/export'
import { ExportCancelled, ExportClient, ExportUnsupported } from '../render/exportClient'
import { RendererUnsupportedError } from '../render/gl/context'
import { ImageLoader, isSupersededError } from '../render/imageLoader'
import { Renderer } from '../render/renderer'

type Status = { kind: 'starting' } | { kind: 'running' } | { kind: 'failed'; message: string }

interface Session {
  renderer: Renderer
  loader: ImageLoader
  exporter: ExportClient
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
  const [inspecting, setInspecting] = useState(false)
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null)
  const [exportNote, setExportNote] = useState<string | null>(null)
  /** The file as opened. Export re-decodes it at full resolution. */
  const sourceFile = useRef<{ blob: Blob; width: number; height: number; name: string } | null>(null)
  /** The key the current image's edit is stored under, or null with no image. */
  const sessionKey = useRef<string | null>(null)
  const [restored, setRestored] = useState(false)

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
    const exporter = new ExportClient()
    sessionRef.current = { renderer, loader, exporter }

    // The store is the only writer of edit parameters, and the renderer is a
    // reader of it. Nothing else pushes state in, so there is one path from a
    // pointer event to a pixel and no way for the two to disagree.
    //
    // The drag proxy is derived from the same signal that coalesces history,
    // rather than wired separately from pointer events. A control only has to
    // tell the store a gesture is in progress; the reduced resolution and the
    // single undo entry both follow from that one fact, and they cannot
    // disagree about when a drag started.
    const publish = (next: EditorStoreState): void => {
      renderer.setEdit(next.edit)
      renderer.setInteracting(next.interactionBaseline !== null)
    }
    publish(editorStore.getState())
    const unsubscribeStore = editorStore.subscribe(publish)

    // Persist work in progress, but not on every frame of a drag: a slider
    // produces a store update per frame and IndexedDB is not the place to put
    // sixty writes a second. Saved when a gesture ends and otherwise coalesced.
    let saveTimer: number | undefined
    const persist = (next: EditorStoreState): void => {
      const key = sessionKey.current
      const file = sourceFile.current
      if (!key || !file) return
      if (next.interactionBaseline !== null) return
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        void saveEdit(key, file.name, editorStore.getState().edit)
      }, 400)
    }
    const unsubscribePersist = editorStore.subscribe(persist)

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

    // Reached by the browser tests, which need the graph's counters, the image
    // path and the store. Development-time only; it is not an API.
    const hooks = window as unknown as {
      __photolabRenderer?: Renderer
      __photolabStore?: typeof editorStore
      __photolabFilmStocks?: typeof FILM_STOCKS
      __photolabExport?: ExportClient
      __photolabExportDirect?: typeof exportImage
    }
    hooks.__photolabRenderer = renderer
    hooks.__photolabStore = editorStore
    hooks.__photolabFilmStocks = FILM_STOCKS
    hooks.__photolabExport = exporter
    hooks.__photolabExportDirect = exportImage

    return () => {
      observer.disconnect()
      unsubscribeStore()
      unsubscribePersist()
      window.clearTimeout(saveTimer)
      unsubscribe()
      loader.dispose()
      renderer.dispose()
      exporter.dispose()
      sessionRef.current = null
      delete hooks.__photolabRenderer
      delete hooks.__photolabStore
      delete hooks.__photolabFilmStocks
      delete hooks.__photolabExport
      delete hooks.__photolabExportDirect
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
      sourceFile.current = {
        blob: file,
        width: decoded.sourceWidth,
        height: decoded.sourceHeight,
        name: file.name,
      }

      // Reattach any work in progress for this exact file. Applied through the
      // store's patch path, so it is one undoable entry rather than twenty and
      // so it is validated on the way in like any other untrusted patch.
      const key = imageKey(file)
      sessionKey.current = key
      const stored = await loadEdit(key)
      if (stored && Object.keys(stored).length > 0) {
        editorStore.getState().applyPatch(stored)
        setRestored(true)
      } else {
        setRestored(false)
      }
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

  /**
   * Panning is a pointer drag on the canvas while the inspector is open.
   *
   * One source pixel per buffer pixel means a pointer moved by n device pixels
   * should move the region by n source pixels, in the opposite direction — the
   * picture follows the finger. The canvas is sized in CSS pixels and drawn in
   * device pixels, so the ratio between the two is what turns one into the other.
   */
  const panFrom = useRef<{ x: number; y: number; centre: readonly [number, number] } | null>(null)

  const beginPan = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = sessionRef.current?.renderer
    if (!renderer?.inspecting) return
    panFrom.current = { x: event.clientX, y: event.clientY, centre: renderer.view.inspectCentre }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const pan = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = sessionRef.current?.renderer
    const from = panFrom.current
    if (!renderer || !from) return
    const source = renderer.source
    if (source.kind !== 'image') return
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
    renderer.setView({
      inspectCentre: [
        from.centre[0] - ((event.clientX - from.x) * ratio) / source.sourceWidth,
        from.centre[1] - ((event.clientY - from.y) * ratio) / source.sourceHeight,
      ],
    })
  }, [])

  const endPan = useCallback(() => {
    panFrom.current = null
  }, [])

  /**
   * Export at full resolution and hand the file over.
   *
   * The renderer is stopped for the duration: the export drives the same graph,
   * and letting the interactive loop draw between tiles would have two callers
   * binding framebuffers on one context.
   */
  const runExport = useCallback(async (format: 'image/jpeg' | 'image/png') => {
    const session = sessionRef.current
    const renderer = session?.renderer
    const source = sourceFile.current
    if (!session || !renderer || !source) return
    setExportNote(null)
    setExporting({ done: 0, total: 1 })
    try {
      // The worker has its own GL context, so the interactive one keeps
      // rendering: the viewport stays live and a slider still moves while a
      // 60MP export runs.
      const result = await session.exporter.run({
        blob: source.blob,
        edit: editorStore.getState().edit,
        view: renderer.view,
        sourceWidth: source.width,
        sourceHeight: source.height,
        format,
        ...(format === 'image/jpeg' ? { quality: 0.92 } : {}),
        onProgress: (done, total) => setExporting({ done, total }),
      })
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      const stem = source.name.replace(/\.[^.]+$/, '')
      anchor.download = `${stem}-photolab.${format === 'image/png' ? 'png' : 'jpg'}`
      anchor.click()
      URL.revokeObjectURL(url)
      setExportNote(
        `${result.width}x${result.height}, ${result.tiles} tiles, ${result.overlap}px overlap, ` +
          `${(result.blob.size / 1e6).toFixed(1)} MB in ${(result.milliseconds / 1000).toFixed(1)}s`,
      )
    } catch (error) {
      if (error instanceof ExportCancelled) {
        setExportNote('Export cancelled.')
      } else if (error instanceof ExportUnsupported) {
        // Loud, per the standing rule: a worker that cannot support the pipeline
        // says so rather than quietly producing a lesser picture.
        setExportNote(`Export is unavailable on this device. ${error.message}`)
      } else {
        setExportNote(error instanceof Error ? error.message : 'Export failed.')
      }
    } finally {
      setExporting(null)
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
        <button
          type="button"
          data-testid="inspect-toggle"
          aria-pressed={inspecting}
          onClick={() => {
            const renderer = sessionRef.current?.renderer
            if (!renderer) return
            renderer.setView({ inspect: !renderer.view.inspect })
            setInspecting(renderer.view.inspect)
          }}
          className={`rounded border border-hairline px-2.5 py-1 text-xs ${
            inspecting ? 'bg-surface-raised text-ink' : 'text-ink-dim'
          }`}
        >
          1:1
        </button>

        <button
          type="button"
          data-testid="export-jpeg"
          disabled={exporting !== null}
          onClick={() => void runExport('image/jpeg')}
          className="rounded border border-hairline px-2.5 py-1 text-xs text-ink disabled:opacity-40"
        >
          {exporting ? `Exporting ${exporting.done}/${exporting.total}` : 'Export JPEG'}
        </button>
        <button
          type="button"
          data-testid="export-png"
          disabled={exporting !== null}
          onClick={() => void runExport('image/png')}
          className="rounded border border-hairline px-2.5 py-1 text-xs text-ink disabled:opacity-40"
        >
          PNG
        </button>

        <span className="truncate text-xs text-ink-dim" data-testid="image-label">
          {loading ? 'Decoding…' : (imageLabel ?? 'Test pattern')}
        </span>
        {inspecting && (
          <span className="text-xs text-ink-dim" data-testid="inspect-hint">
            Actual pixels — drag to pan
          </span>
        )}
        {restored && (
          <span className="text-xs text-ink-dim" data-testid="restored-note">
            Restored your edit
          </span>
        )}
        {exportNote && (
          <span className="truncate text-xs text-ink-dim" data-testid="export-note">
            {exportNote}
          </span>
        )}
      </div>

      <div ref={containerRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        <canvas
          ref={canvasRef}
          data-testid="viewport-canvas"
          aria-label="Render output"
          className={inspecting ? 'cursor-grab touch-none' : undefined}
          onPointerDown={beginPan}
          onPointerMove={pan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
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
