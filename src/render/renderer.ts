/**
 * Drives the graph from a canvas: sizing, the frame loop, and context loss.
 *
 * ## Pointer events never render
 *
 * {@link Renderer.setState} stores state and does nothing else. A
 * `requestAnimationFrame` loop renders at most once per frame from whatever the
 * latest state is. A drag that rendered synchronously per event would render
 * several times per frame and, because the events queue faster than the GPU
 * drains, show the oldest result last.
 */

import type { RenderContext } from './gl/context'
import { createRenderContext } from './gl/context'
import { RenderGraph } from './graph'
import { testPatternPass } from './passes/testPattern'
import { ingestPass } from './passes/ingest'
import { displayPass } from './passes/display'
import type { PassContext, RenderState } from './passes/types'

/**
 * The notional source dimensions the test pattern stands in for, so that
 * `uImageSize` and `uSourceRect` carry meaningful values before an image exists.
 *
 * The long edge is fixed and the short edge follows the viewport's aspect, which
 * keeps buffer-to-source scaling isotropic — the graph asserts that, and a
 * fixed 3:2 notional source in a 16:9 viewport would trip it. Part C replaces
 * this with the decoded image's true dimensions and letterboxes the canvas to
 * the image's aspect instead.
 */
const NOMINAL_SOURCE_LONG_EDGE = 4096

export const DEFAULT_RENDER_STATE: RenderState = {
  displayMode: 'sdr',
  patternPhase: 0,
}

export class Renderer {
  #context: RenderContext
  #graph: RenderGraph
  #state: RenderState = DEFAULT_RENDER_STATE
  #frame: number | null = null
  #dirty = true
  #unsubscribe: () => void
  #disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.#context = createRenderContext(canvas)
    this.#graph = new RenderGraph(this.#context, [
      // Registration order is not execution order; the graph sorts by stage.
      // Deliberately listed out of order here so that the ordering test is
      // asserting something rather than restating the array.
      displayPass,
      testPatternPass,
      ingestPass,
    ])

    this.#unsubscribe = this.#context.onStatusChange((status) => {
      if (status === 'ok') {
        // Every GL object from before the loss is gone. Nothing here recreates
        // them yet, so the honest thing is to stop rather than to draw with
        // dangling handles; Part C wires the rebuild.
        this.#dirty = true
      }
    })
  }

  get graph(): RenderGraph {
    return this.#graph
  }

  get context(): RenderContext {
    return this.#context
  }

  get state(): RenderState {
    return this.#state
  }

  /** Store state. Rendering happens on the next frame, not here. */
  setState(next: RenderState): void {
    this.#state = next
    this.#dirty = true
  }

  start(): void {
    if (this.#frame !== null || this.#disposed) return
    const tick = (): void => {
      this.#frame = requestAnimationFrame(tick)
      if (!this.#dirty) return
      this.#dirty = false
      this.renderNow()
    }
    this.#frame = requestAnimationFrame(tick)
  }

  stop(): void {
    if (this.#frame === null) return
    cancelAnimationFrame(this.#frame)
    this.#frame = null
  }

  /** Resize the drawing buffer. Returns true if the size actually changed. */
  syncSize(): boolean {
    const canvas = this.#context.canvas
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio))

    if (canvas.width === width && canvas.height === height) return false
    canvas.width = width
    canvas.height = height
    this.#dirty = true
    return true
  }

  /** The uniform contract's spatial values for the current canvas. */
  passContext(): PassContext {
    const canvas = this.#context.canvas
    const width = Math.max(1, canvas.width)
    const height = Math.max(1, canvas.height)

    const longEdge = Math.max(width, height)
    const scale = NOMINAL_SOURCE_LONG_EDGE / longEdge
    const imageWidth = Math.round(width * scale)
    const imageHeight = Math.round(height * scale)

    return {
      resolution: [width, height],
      imageSize: [imageWidth, imageHeight],
      // The interactive path covers the whole source, so the rect is the whole
      // image. Export tiles pass their own rect here, including overlap.
      sourceRect: [0, 0, imageWidth, imageHeight],
    }
  }

  /** Render immediately, outside the frame loop. Used by tests and by resize. */
  renderNow(): void {
    if (this.#disposed) return
    this.syncSize()
    this.#graph.render(this.#state, this.passContext())
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.stop()
    this.#unsubscribe()
    this.#graph.dispose()
    this.#context.dispose()
  }
}
