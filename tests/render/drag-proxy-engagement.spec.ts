import { expect, test } from '@playwright/test'

/**
 * The conditional drag proxy, watched engaging rather than only reasoned about.
 *
 * `DragProxyMode: 'auto'` engages the proxy only once the median of the last
 * `DRAG_PROXY_WINDOW` frame intervals exceeds `DRAG_PROXY_FRAME_BUDGET_MS`. The
 * other tests in this suite force the mode to `'always'`, which exercises what
 * the proxy does but not what decides to use it.
 *
 * This test drives the decision itself, and it is not flaky in either direction
 * because it does not rely on the machine being slow by accident. It runs on the
 * software rasteriser, where a large buffer with the full film stage is hundreds
 * of milliseconds per frame — more than an order of magnitude past the 20 ms
 * threshold, so the outcome is not a close call. The counterpart assertion, that
 * a cheap frame does NOT engage it, uses a tiny buffer that is equally far the
 * other way.
 *
 * # It has to run through requestAnimationFrame
 *
 * A first version called `renderNow()` in a tight loop and never engaged the
 * proxy, on a gesture that genuinely took a third of a second per frame. GL is
 * asynchronous: `renderNow()` queues the work and returns, so the wall-clock
 * interval between two calls measures how fast the CPU can issue draws, not how
 * long the GPU takes to do them.
 *
 * The real loop does not have that problem, and that is why the shipping code
 * measures what it measures. The browser paces `requestAnimationFrame` against
 * presentation, so GPU backpressure lengthens the interval between callbacks —
 * which is the same signal a user perceives as a stuttering drag. Driving the
 * actual loop is therefore not merely more realistic, it is the only arrangement
 * in which the quantity being measured exists at all.
 *
 * # What it found
 *
 * Two defects in the shipping code, neither visible from the forced-mode tests:
 *
 * - `setInteracting(true)` re-evaluated engagement every time it was called, and
 *   `Viewport` calls it on every store change during a drag. An engaged proxy was
 *   driven straight back to full resolution on the next slider movement — the
 *   oscillation the hold-for-the-gesture rule exists to prevent.
 * - The trigger was three consecutive intervals over 20ms, which a healthy 60Hz
 *   drag produces on its own. It now takes a median over a window, at one missed
 *   refresh rather than at budget.
 */

interface RendererLike {
  stop(): void
  start(): void
  renderNow(): void
  setInteracting(active: boolean): void
  setDragProxyMode(mode: 'auto' | 'always' | 'never'): void
  syncSize(available?: { width: number; height: number }): boolean
  readonly interacting: boolean
  readonly dragProxyMode: string
  input: { edit: Record<string, unknown> }
}

interface StoreLike {
  getState(): {
    applyPatch(patch: Record<string, number>): void
    setParameter(key: string, value: number): void
    beginInteraction(): void
    endInteraction(): void
    reset(): void
  }
}

const SOURCE = { width: 1600, height: 1200 }

const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  const image = context.createImageData(source.width, source.height)
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
      const v = 40 + Math.round(180 * (x / source.width))
      image.data[i] = v; image.data[i+1] = v; image.data[i+2] = v; image.data[i+3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'ramp.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

test.describe('the drag proxy engages on measured frame time', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
    await page.evaluate(`(${SETUP})(${JSON.stringify(SOURCE)})`)
    await expect(page.getByTestId('image-label')).toContainText(
      `${SOURCE.width}x${SOURCE.height}`,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(200)
  })

  /**
   * Open a gesture, render `frames` frames at the given canvas size, and report
   * whether the proxy engaged.
   */
  async function gesture(
    page: import('@playwright/test').Page,
    canvas: { width: number; height: number },
    edit: Record<string, number>,
    milliseconds: number,
  ): Promise<{ engaged: boolean; engagedAfterRelease: boolean; frames: number }> {
    return page.evaluate<
      { engaged: boolean; engagedAfterRelease: boolean; frames: number },
      {
        canvas: { width: number; height: number }
        edit: Record<string, number>
        milliseconds: number
      }
    >(async ({ canvas, edit, milliseconds }) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      const store = (window as unknown as { __photolabStore: StoreLike }).__photolabStore

      renderer.setDragProxyMode('auto')
      store.getState().applyPatch(edit)
      renderer.syncSize(canvas)
      renderer.start()

      // Warm up before opening the gesture. Changing which effects are on
      // recompiles the pass graph, and the first draw at a new buffer size is not
      // representative — both land as slow frames that have nothing to do with
      // how expensive the drag is. A user has been looking at the picture before
      // they touch a slider, so warming up is the faithful arrangement as well as
      // the stable one.
      for (let i = 0; i < 4; i++) {
        renderer.syncSize(canvas)
        store.getState().setParameter('exposure', i / 400)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }

      // The gesture is opened through the STORE, not by calling
      // `setInteracting` directly, because `Viewport` subscribes to the store and
      // derives the renderer's interacting flag from `interactionBaseline` on
      // every change. Setting the flag by hand and then moving a parameter closes
      // the gesture on the next store update — which is what happened on the
      // first attempt, and it looked exactly like the proxy refusing to engage on
      // frames that were plainly 250 ms long.
      store.getState().beginInteraction()

      // The loop renders only when something changed, so the gesture is
      // simulated the way a real one behaves: a parameter moving every frame.
      let frames = 0
      const deadline = performance.now() + milliseconds
      await new Promise<void>((resolve) => {
        const step = (): void => {
          renderer.syncSize(canvas)
          store.getState().setParameter('exposure', (frames % 20) / 200)
          frames++
          if (performance.now() >= deadline || renderer.interacting) resolve()
          else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })

      const engaged = renderer.interacting
      store.getState().endInteraction()
      // One more frame, so the release is actually applied by the loop.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const engagedAfterRelease = renderer.interacting
      renderer.stop()
      store.getState().reset()
      return { engaged, engagedAfterRelease, frames }
    }, { canvas, edit, milliseconds })
  }

  const HEAVY = {
    halationStrength: 0.7,
    halationThreshold: 1.2,
    halationRadius: 0.008,
    grainStrength: 0.6,
    grainSize: 0.0009,
    filmStrength: 1,
  }

  test('engages once a gesture is missing frames, and lets go on release', async ({ page }) => {
    // A large canvas with the full film stage on the software rasteriser. Frames
    // here are hundreds of milliseconds, so the three-slow-frame condition is met
    // immediately and by a wide margin.
    const result = await gesture(page, { width: 1400, height: 1050 }, HEAVY, 4000)
    expect(result.frames).toBeGreaterThan(2)
    expect(result.engaged, 'the proxy never engaged on a gesture missing frames').toBe(true)
    // Full resolution returns on pointer-up, always.
    expect(result.engagedAfterRelease).toBe(false)
  })

  test('stays out of the way when frames are cheap', async ({ page }) => {
    // The whole point of making it conditional: on a gesture that holds frame
    // rate the proxy costs 63% of high-frequency detail and buys nothing, so it
    // must not engage. A tiny canvas with every effect off is far below the
    // threshold on any hardware this can run on.
    const result = await gesture(
      page,
      { width: 64, height: 48 },
      { halationStrength: 0, grainStrength: 0, filmStrength: 0 },
      1200,
    )
    expect(result.engaged, 'the proxy engaged on a gesture that was keeping up').toBe(false)
  })

  test('never engages when the mode forbids it, however slow the frames', async ({ page }) => {
    const engaged = await page.evaluate<boolean, { edit: Record<string, number> }>(({ edit }) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.setDragProxyMode('never')
      Object.assign(renderer.input.edit, edit)
      const canvas = { width: 1400, height: 1050 }
      renderer.syncSize(canvas)
      renderer.setInteracting(true)
      for (let i = 0; i < 6; i++) {
        renderer.syncSize(canvas)
        renderer.renderNow()
      }
      const result = renderer.interacting
      renderer.setInteracting(false)
      renderer.setDragProxyMode('auto')
      return result
    }, { edit: HEAVY })

    expect(engaged).toBe(false)
  })
})
