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
import { whiteBalancePass } from './passes/whiteBalance'
import { exposurePass } from './passes/exposure'
import { contrastPass } from './passes/contrast'
import { createCurvePass } from './passes/curve'
import { createFilmCurvesPass } from './passes/filmCurves'
import { HALATION_PASSES } from './passes/halation'
import { grainPass } from './passes/grain'
import { displayPass } from './passes/display'
import type { CurvePass } from './passes/curve'
import type { FilmCurvesPass } from './passes/filmCurves'
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
 * # Engaged only when frames are actually being missed
 *
 * The decision was deferred twice, to the first multi-tap kernel, and halation
 * is it. Measured on a 12MP source with halation at a realistic radius:
 *
 *   buffer        Apple M5 (Metal)   SwiftShader
 *   512x384             0.275 ms        18.4 ms
 *   1024x768            0.400 ms        67.1 ms
 *   2048x1536           1.585 ms       263.3 ms
 *   4000x3000           6.092 ms      1023.0 ms
 *
 * Against a 16.7 ms budget, and against the 63% of high-frequency detail the
 * proxy costs on every drag (measured at Stage 4), the two ends disagree
 * completely:
 *
 * - **On this hardware the proxy is pure loss.** At a typical canvas it saves
 *   0.13 ms of a frame with 16.3 ms spare, and even the *full* 12MP image at
 *   6.1 ms is comfortably inside budget. Halving the resolution buys nothing and
 *   softens every drag.
 * - **On hardware an order of magnitude slower it is the difference between a
 *   usable drag and an unusable one.** The software rasteriser — the closest
 *   model of a weak GPU now that the chain is compute-bound rather than
 *   bandwidth-bound — is 16 times over budget at the 2048px proxy, with the lens
 *   stage's bloom and diffusion still to come.
 *
 * So it is neither deleted nor kept unconditionally: it **engages when frames
 * are being missed and not before**. The signal is the interval between rendered
 * frames during a gesture, which is exactly the symptom, and it needs no
 * synchronisation — `gl.finish()` does not synchronise under ANGLE and would
 * have to be a readback, which stalls the pipeline it is trying to measure.
 *
 * This is timing-derived, not content-derived, and the distinction is the one
 * recorded in `display.ts`: the *resolution* varies, and the two-resolution
 * invariant says resolution does not change the image. Output stays a pure
 * function of the inputs; only how densely it is sampled moves.
 */
export const DRAG_PROXY_SCALE = 0.5

/**
 * Frame interval above which a gesture is judged to be missing frames.
 *
 * 33ms, which is one missed frame at 60Hz — the median frame is failing to make
 * at least one refresh.
 *
 * An earlier version used 20ms and engaged on drags that were perfectly healthy.
 * Measured intervals on a trivial frame — a 64x48 buffer with every effect off —
 * run 12 to 24ms with occasional spikes past 45ms, because a 60Hz display
 * delivers 16.7ms nominal and normal jitter crosses 20 constantly. A threshold
 * that close to budget cannot separate jitter from trouble. A genuinely
 * struggling gesture in the same environment runs 240 to 300ms, so there is more
 * than a factor of ten to aim at and no reason to sit near the noise.
 */
export const DRAG_PROXY_FRAME_BUDGET_MS = 33

/**
 * How many recent frames the decision looks at.
 *
 * The statistic is the **median** of these, not a count of consecutive slow
 * frames. A count is defeated by exactly the pattern real drags produce —
 * alternating fast and slow — while a single garbage-collection spike can start
 * one. The median ignores both: it takes three of five frames to be over budget
 * before anything happens, and no individual outlier can trigger it.
 */
export const DRAG_PROXY_WINDOW = 5

/**
 * The engagement decision, as a pure function of recent frame intervals.
 *
 * Extracted so it can be tested on given numbers rather than by arranging for a
 * machine to be slow. The browser test that drives the real loop is still worth
 * having — it is what found that `Viewport` re-opens the gesture every frame —
 * but it cannot be the only cover, because whether any particular machine misses
 * frames is not something a test can rely on. It did not reproduce on CI.
 */
export function shouldEngageDragProxy(
  intervals: readonly number[],
  budgetMs: number = DRAG_PROXY_FRAME_BUDGET_MS,
): boolean {
  if (intervals.length < DRAG_PROXY_WINDOW) return false
  const recent = intervals.slice(-DRAG_PROXY_WINDOW)
  const sorted = [...recent].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  return median > budgetMs
}

/**
 * Whether the drag proxy may engage.
 *
 * `auto` is the shipping behaviour. The other two exist so a test can exercise
 * the mechanism without depending on how fast the machine running it happens to
 * be — a timing-dependent test of a timing-dependent feature would be flaky in
 * both directions.
 */
export type DragProxyMode = 'auto' | 'always' | 'never'



export class Renderer {
  #context: RenderContext
  #graph: RenderGraph
  #edit: EditState = DEFAULT_EDIT_STATE
  #view: ViewState = DEFAULT_VIEW_STATE
  #source: RenderSource = { kind: 'pattern' }
  #curvePass: CurvePass
  #filmCurvesPass: FilmCurvesPass
  #interacting = false
  #renderCount = 0
  #dragProxyMode: DragProxyMode = 'auto'
  #gestureOpen = false
  #lastFrameAt = 0
  #recentIntervals: number[] = []
  #frame: number | null = null
  #dirty = true
  #unsubscribe: () => void
  #disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.#context = createRenderContext(canvas)
    this.#curvePass = createCurvePass()
    this.#filmCurvesPass = createFilmCurvesPass()
    this.#graph = new RenderGraph(this.#context, [
      // Registration order is not execution order; the graph sorts by stage.
      // Deliberately listed out of order here so that the ordering test is
      // asserting something rather than restating the array.
      displayPass,
      this.#curvePass,
      contrastPass,
      // Halation before the curves, within the film stage. Registration order
      // decides inside a stage, and this one is physical: halation adds light to
      // the emulsion, so it happens before the curves turn exposure into
      // density. Listed here rather than left to chance.
      ...HALATION_PASSES,
      this.#filmCurvesPass,
      // Grain last inside the film stage, and registration order is what decides
      // that: its magnitude depends on the developed density, which does not
      // exist until the curves have produced it.
      grainPass,
      testPatternPass,
      imageSourcePass,
      whiteBalancePass,
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

  /** Exposed so a test can assert that a rebake happens per change, not per frame. */
  get curveBakeCount(): number {
    return this.#curvePass.bakeCount
  }

  get filmBakeCount(): number {
    return this.#filmCurvesPass.bakeCount
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
  setEdit(next: Partial<EditState>): void {
    // A patch, merged, rather than a replacement.
    //
    // The renderer holds the authoritative state and callers say what changed,
    // which is what every caller wanted anyway. Taking a whole `EditState` was a
    // standing trap at the boundary with browser tests, where the state arrives
    // through `page.evaluate` and the type system cannot see it: a caller that
    // named two parameters silently set every other one to undefined, and the
    // shader received NaN. That is not a hypothetical — it happened for the view
    // state and then again here.
    this.#edit = { ...this.#edit, ...next }
    this.#dirty = true
  }

  setView(next: Partial<ViewState>): void {
    this.#view = { ...this.#view, ...next }
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
    if (!active) {
      // Full resolution returns on release, always. The proxy is a concession to
      // a gesture in progress, not a state to be left in.
      this.#gestureOpen = false
      this.#recentIntervals = []
      this.#lastFrameAt = 0
      if (this.#interacting) {
        this.#interacting = false
        this.#dirty = true
      }
      return
    }

    // Opening an already-open gesture decides nothing. `Viewport` derives this
    // flag from the store and so calls it again on EVERY change during a drag,
    // which is most frames of one — and an earlier version re-evaluated
    // engagement each time, so in `auto` mode it drove an already-engaged proxy
    // straight back to full resolution. The result was the exact oscillation the
    // hold-for-the-gesture rule exists to prevent: engage, drop out, three slow
    // frames, engage again.
    if (this.#gestureOpen) return
    this.#gestureOpen = true
    this.#recentIntervals = []
    this.#lastFrameAt = 0

    const engageImmediately = this.#dragProxyMode === 'always'
    if (this.#interacting !== engageImmediately) {
      this.#interacting = engageImmediately
      this.#dirty = true
    }
  }

  get dragProxyMode(): DragProxyMode {
    return this.#dragProxyMode
  }

  setDragProxyMode(mode: DragProxyMode): void {
    this.#dragProxyMode = mode
    if (mode === 'never' && this.#interacting) {
      this.#interacting = false
      this.#dirty = true
    }
  }

  /**
   * Note how long the last frame took, and engage the proxy if a gesture is
   * missing frames.
   *
   * Measured from wall-clock intervals between rendered frames rather than from
   * the GPU, because the only reliable barrier available is a readback and that
   * stalls the pipeline it would be measuring. The interval is the symptom
   * anyway: a drag that holds frame rate does not need help.
   *
   * Once engaged it stays engaged for the rest of the gesture. Letting it
   * disengage mid-drag would oscillate — dropping resolution makes frames fast
   * again, which is the condition for going back to full resolution, which makes
   * them slow again.
   */
  #noteFrameTiming(): void {
    if (this.#dragProxyMode !== 'auto' || !this.#gestureOpen || this.#interacting) {
      this.#lastFrameAt = performance.now()
      return
    }

    const now = performance.now()
    const elapsed = this.#lastFrameAt === 0 ? 0 : now - this.#lastFrameAt
    this.#lastFrameAt = now
    if (elapsed === 0) return

    this.#recentIntervals.push(elapsed)
    if (this.#recentIntervals.length > DRAG_PROXY_WINDOW) this.#recentIntervals.shift()

    if (shouldEngageDragProxy(this.#recentIntervals)) {
      this.#interacting = true
      this.#dirty = true
    }
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
    this.#noteFrameTiming()
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
