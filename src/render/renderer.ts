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
import { imageSourcePass } from './passes/imageSource'
import { ingestPass } from './passes/ingest'
import { displayPass } from './passes/display'
import type { PassContext, RenderSource, RenderState } from './passes/types'
import { uploadImageTexture } from './gl/texture'

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
  #source: RenderSource = { kind: 'pattern' }
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
      imageSourcePass,
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

  /**
   * Resize the drawing buffer. Returns true if the size actually changed.
   *
   * `available` is the space the canvas may occupy, which is **not** the canvas's
   * own client size once an image is loaded: the canvas is letterboxed to the
   * image's aspect ratio, so measuring it would feed its own previous size back
   * in and it would never grow again. The caller measures the container.
   */
  syncSize(available?: { readonly width: number; readonly height: number }): boolean {
    const canvas = this.#context.canvas
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const box = available ?? { width: canvas.clientWidth, height: canvas.clientHeight }
    const availablePixels: [number, number] = [
      Math.max(1, Math.round(box.width * ratio)),
      Math.max(1, Math.round(box.height * ratio)),
    ]
    const [width, height] = this.#fitToSource(availablePixels[0], availablePixels[1])

    if (canvas.width === width && canvas.height === height) return false
    canvas.width = width
    canvas.height = height
    canvas.style.width = `${width / ratio}px`
    canvas.style.height = `${height / ratio}px`
    this.#dirty = true
    return true
  }

  get source(): RenderSource {
    return this.#source
  }

  /**
   * Replace the image being edited, taking ownership of the previous texture.
   *
   * The upload happens here rather than in the decoder because it needs the GL
   * context, and the size guard needs `MAX_TEXTURE_SIZE`, which is a property of
   * the device rather than of the file.
   */
  setImage(bitmap: ImageBitmap, sourceWidth: number, sourceHeight: number): void {
    const texture = uploadImageTexture(this.#context.gl, this.#context.capabilities, bitmap)
    this.#releaseSourceTexture()
    this.#source = {
      kind: 'image',
      texture,
      width: bitmap.width,
      height: bitmap.height,
      sourceWidth,
      sourceHeight,
    }
    this.#dirty = true
  }

  clearImage(): void {
    this.#releaseSourceTexture()
    this.#source = { kind: 'pattern' }
    this.#dirty = true
  }

  #releaseSourceTexture(): void {
    if (this.#source.kind === 'image') this.#context.gl.deleteTexture(this.#source.texture)
  }

  /**
   * The uniform contract's spatial values for the current canvas.
   *
   * `uImageSize` is the **true** source dimensions, not the proxy's — the proxy
   * is an implementation detail of the interactive path, while spatial
   * parameters are defined against the image the user sees. `uSourceRect` covers
   * the whole image, because the interactive path renders all of it; an export
   * tile passes its own rect, including overlap.
   *
   * With no image loaded there is nothing to take dimensions from, so the test
   * pattern stands in for a notional source whose long edge is fixed and whose
   * short edge follows the viewport. That keeps buffer-to-source scaling
   * isotropic, which the graph asserts.
   */
  passContext(): PassContext {
    const canvas = this.#context.canvas
    const width = Math.max(1, canvas.width)
    const height = Math.max(1, canvas.height)

    if (this.#source.kind === 'image') {
      const { sourceWidth, sourceHeight } = this.#source
      return {
        resolution: [width, height],
        imageSize: [sourceWidth, sourceHeight],
        sourceRect: [0, 0, sourceWidth, sourceHeight],
      }
    }

    const longEdge = Math.max(width, height)
    const scale = NOMINAL_SOURCE_LONG_EDGE / longEdge
    const imageWidth = Math.round(width * scale)
    const imageHeight = Math.round(height * scale)

    return {
      resolution: [width, height],
      imageSize: [imageWidth, imageHeight],
      sourceRect: [0, 0, imageWidth, imageHeight],
    }
  }

  /**
   * The drawing-buffer size that shows the image at its own aspect ratio.
   *
   * Letterboxing is done by sizing the canvas rather than by scaling inside the
   * shader, so `uResolution` always describes a buffer that covers exactly the
   * source rect and buffer-to-source scaling stays isotropic.
   */
  #fitToSource(availableWidth: number, availableHeight: number): [number, number] {
    if (this.#source.kind !== 'image') return [availableWidth, availableHeight]
    const { sourceWidth, sourceHeight } = this.#source
    const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight)
    return [
      Math.max(1, Math.round(sourceWidth * scale)),
      Math.max(1, Math.round(sourceHeight * scale)),
    ]
  }

  /** Render immediately, outside the frame loop. Used by tests and by resize. */
  renderNow(available?: { readonly width: number; readonly height: number }): void {
    if (this.#disposed) return
    this.syncSize(available)
    this.#graph.render(this.#source, this.#state, this.passContext())
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.stop()
    this.#unsubscribe()
    this.#releaseSourceTexture()
    this.#graph.dispose()
    this.#context.dispose()
  }
}
