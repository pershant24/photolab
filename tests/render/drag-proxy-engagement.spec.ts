import { expect, test } from '@playwright/test'

/**
 * The conditional drag proxy, watched engaging rather than only reasoned about.
 *
 * `DragProxyMode: 'auto'` engages the proxy only once the median of the last
 * `DRAG_PROXY_WINDOW` frame intervals exceeds `DRAG_PROXY_FRAME_BUDGET_MS`. The
 * other tests in this suite force the mode to `'always'`, which exercises what
 * the proxy does but not what decides to use it.
 *
 * This test drives the decision through the real wiring. The slow gesture is made
 * slow **deliberately**, by stalling between frames, rather than by arranging for
 * the renderer to be expensive: a first version relied on a large buffer with the
 * full film stage on the software rasteriser being hundreds of milliseconds a
 * frame, which held locally and did not on CI. Whether a given machine misses
 * frames is not something a test can depend on.
 *
 * The stall is real wall-clock time, so what is exercised is genuinely the
 * renderer noticing slow frames; only the cause is synthetic. The rule itself,
 * on given intervals, is covered in `tests/unit/drag-proxy.test.ts`.
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
    stallMs: number,
  ): Promise<{ engaged: boolean; engagedAfterRelease: boolean; frames: number }> {
    return page.evaluate<
      { engaged: boolean; engagedAfterRelease: boolean; frames: number },
      {
        canvas: { width: number; height: number }
        edit: Record<string, number>
        milliseconds: number
        stallMs: number
      }
    >(async ({ canvas, edit, milliseconds, stallMs }) => {
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
          // Burn wall-clock time before letting the next frame render, so the
          // interval the renderer measures is what this test says it is on any
          // machine. A sleep would not do: the interval has to elapse between
          // rendered frames, and the loop renders on the next animation frame.
          if (stallMs > 0) {
            const until = performance.now() + stallMs
            while (performance.now() < until) { /* spin */ }
          }
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
    }, { canvas, edit, milliseconds, stallMs })
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
    // Frames are stalled to 60ms and up, so the median crosses the threshold
    // within one window and the outcome does not depend on the hardware.
    // 60ms of stall per frame: comfortably past the 33ms threshold on any
    // machine, and nowhere near it by accident.
    const result = await gesture(page, { width: 700, height: 525 }, HEAVY, 6000, 60)
    expect(result.frames).toBeGreaterThan(2)
    expect(result.engaged, 'the proxy never engaged on a gesture missing frames').toBe(true)
    // Full resolution returns on pointer-up, always.
    expect(result.engagedAfterRelease).toBe(false)
  })

  test('does not engage when no gesture is open, however slow the frames', async ({ page }) => {
    // The gating property, and it is deterministic: stall the frames well past
    // the threshold but never open a gesture, and nothing should happen.
    //
    // The obvious counterpart — a CHEAP gesture must not engage — is deliberately
    // NOT here. It needs the machine running the test to be fast, which is the
    // same dependency that made the slow case fail on CI, mirrored. It passed and
    // failed on consecutive local runs while nothing but machine load changed.
    // Whether a loaded build agent holds 60Hz is not something to assert. The
    // rule is covered on given intervals in `tests/unit/drag-proxy.test.ts`,
    // against the measured jitter of a real healthy drag.
    const engaged = await page.evaluate<boolean, { edit: Record<string, number> }>(
      async ({ edit }) => {
        const renderer = (window as unknown as { __photolabRenderer: RendererLike })
          .__photolabRenderer
        const store = (window as unknown as { __photolabStore: StoreLike }).__photolabStore
        renderer.setDragProxyMode('auto')
        store.getState().applyPatch(edit)
        const canvas = { width: 700, height: 525 }
        renderer.syncSize(canvas)
        renderer.start()

        for (let i = 0; i < 10; i++) {
          const until = performance.now() + 60
          while (performance.now() < until) { /* spin */ }
          renderer.syncSize(canvas)
          store.getState().setParameter('exposure', (i % 20) / 200)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        const result = renderer.interacting
        renderer.stop()
        store.getState().reset()
        return result
      },
      { edit: HEAVY },
    )

    expect(engaged, 'the proxy engaged without a gesture').toBe(false)
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
