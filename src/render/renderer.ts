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

import type { EditState } from '../core/state/editState'
import { DEFAULT_EDIT_STATE } from '../core/state/editState'
import type { RenderContext } from './gl/context'
import { createRenderContext } from './gl/context'
import { RenderGraph } from './graph'
import { testPatternPass } from './passes/testPattern'
import { imageSourcePass } from './passes/imageSource'
import { ingestPass } from './passes/ingest'
import { exposurePass } from './passes/exposure'
import { contrastPass } from './passes/contrast'
import { displayPass } from './passes/display'
import type { PassContext, RenderInput, RenderSource, ViewState } from './passes/types'
import { DEFAULT_VIEW_STATE } from './passes/types'
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

/**
 * Linear scale applied to the drawing buffer while a drag is in progress.
 *
 * Half on each axis is a quarter of the pixels and therefore roughly a quarter
 * of the fragment work, which is the dominant cost in a chain of full-screen
 * passes. Half is also the largest reduction that stays unobtrusive: the browser
 * upscales it bilinearly, and at 2x the result reads as slightly soft rather
 * than as blocky.
 *
 * **Whether this is needed at all is a measurement, and the measurement says it
 * currently is not.** A full-resolution 12MP frame costs 0.97 ms on an Apple M5
 * against a 16.7 ms budget, so halving the resolution saves 0.7 ms of a frame
 * with 15.7 ms spare, and costs a visibly softer image throughout every drag.
 *
 * It is kept because that figure is from one fast GPU and the chain it measures
 * is three passes; the film and lens stages arriving next are the expensive kind,
 * with spatial kernels rather than one tap per pixel. `tests/README.md` records
 * the full table and the condition for deleting this: if a full-resolution drag
 * is still inside budget on the slowest device worth supporting once the real
 * chain exists, this should go.
 */
export const DRAG_PROXY_SCALE = 0.5



export class Renderer {
  #context: RenderContext
  #graph: RenderGraph
  #edit: EditState = DEFAULT_EDIT_STATE
  #view: ViewState = DEFAULT_VIEW_STATE
  #source: RenderSource = { kind: 'pattern' }
  #interacting = false
  #renderCount = 0
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
      contrastPass,
      testPatternPass,
      imageSourcePass,
      exposurePass,
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

  get input(): RenderInput {
    return { source: this.#source, edit: this.#edit, view: this.#view }
  }

  /**
   * Store the edit. Rendering happens on the next frame, not here.
   *
   * This is the whole of the pointer-event path: an event updates the store, the
   * store updates this, and the frame loop reads it. A synchronous render from
   * here would render several times per frame during a drag and, because events
   * queue faster than the GPU drains, show the oldest result last.
   */
  setEdit(next: EditState): void {
    this.#edit = next
    this.#dirty = true
  }

  setView(next: ViewState): void {
    this.#view = next
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
   *
   * The drag proxy is applied here, and it is applied to the **drawing buffer
   * only**. The CSS size is computed from the full-quality dimensions and does
   * not change, so the element does not move or reflow when a drag starts; the
   * browser upscales the smaller buffer to fill it. That is why the drag proxy
   * needs no extra pass and no blit: it is a resolution change, not a
   * composition change.
   *
   * `uSourceRect` is untouched by any of this. The buffer covers the same region
   * of the same source either way — only how many samples it covers it with
   * changes — which is exactly the distinction the uniform contract exists to
   * make. See docs/SHADER_CONVENTIONS.md §1.
   */
  syncSize(available?: { readonly width: number; readonly height: number }): boolean {
    const canvas = this.#context.canvas
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const box = available ?? { width: canvas.clientWidth, height: canvas.clientHeight }
    const availablePixels: [number, number] = [
      Math.max(1, Math.round(box.width * ratio)),
      Math.max(1, Math.round(box.height * ratio)),
    ]
    const [displayWidth, displayHeight] = this.#fitToSource(
      availablePixels[0],
      availablePixels[1],
    )

    const scale = this.#interacting ? DRAG_PROXY_SCALE : 1
    const width = Math.max(1, Math.round(displayWidth * scale))
    const height = Math.max(1, Math.round(displayHeight * scale))

    // Written unconditionally: the CSS size is what the drag proxy must not
    // change, and leaving it stale after a resize that only altered the buffer
    // would letterbox the image against its own previous dimensions.
    canvas.style.width = `${displayWidth / ratio}px`
    canvas.style.height = `${displayHeight / ratio}px`

    if (canvas.width === width && canvas.height === height) return false
    canvas.width = width
    canvas.height = height
    this.#dirty = true
    return true
  }

  /**
   * Enter or leave the reduced-resolution drag proxy.
   *
   * Called on pointer-down and pointer-up, not per movement: the two size
   * changes per gesture each reallocate the drawing buffer and the pooled
   * targets, which is affordable twice and not affordable per frame.
   */
  setInteracting(active: boolean): void {
    if (this.#interacting === active) return
    this.#interacting = active
    this.#dirty = true
  }

  get interacting(): boolean {
    return this.#interacting
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

  /**
   * Frames actually drawn.
   *
   * Exposed so that the coalescing rule can be asserted as a number rather than
   * inspected. Sixty state changes inside one frame must produce **one** render;
   * a count is the only way to tell that apart from sixty renders that happen to
   * end at the same image.
   */
  get renderCount(): number {
    return this.#renderCount
  }

  /** Render immediately, outside the frame loop. Used by tests and by resize. */
  renderNow(available?: { readonly width: number; readonly height: number }): void {
    if (this.#disposed) return
    this.syncSize(available)
    this.#renderCount += 1
    this.#graph.render(this.input, this.passContext())
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
