import { expect, test } from '@playwright/test'

/**
 * The frame loop and the drag proxy.
 *
 * Two rules that are cheap to state and easy to violate by accident:
 * a pointer event may never render, and a resolution change may never compile.
 */

interface RendererLike {
  graph: { compileCount: number; allocationCount: number; passIds: string[] }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  renderCount: number
  interacting: boolean
  setDragProxyMode(mode: string): void
  syncSize(available?: { width: number; height: number }): boolean
  renderNow(available?: { width: number; height: number }): void
  start(): void
  stop(): void
}

interface StoreLike {
  getState(): {
    edit: { exposure: number; contrast: number }
    past: readonly unknown[]
    setParameter(key: 'exposure' | 'contrast', value: number): void
    beginInteraction(): void
    endInteraction(): void
  }
}

/** Resolve after `count` animation frames have actually elapsed. */
const WAIT_FRAMES = `(count) => new Promise((resolve) => {
  let left = count
  const step = () => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(step) }
  requestAnimationFrame(step)
})`

test.describe('render loop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window && '__photolabStore' in window)
  })

  test('sixty state changes inside one frame produce one render', async ({ page }) => {
    // The rule this exists for: a pointer drag emits changes at whatever rate the
    // device reports pointer events, which on a high-rate mouse is several times
    // per frame. Rendering from the handler would draw several times per frame
    // and, because the events queue faster than the GPU drains, show the oldest
    // result last — the image visibly lagging the pointer while doing more work.
    const renders = await page.evaluate<number, string>(async (waitFramesSrc) => {
      const waitFrames = eval(waitFramesSrc) as (count: number) => Promise<void>
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      const store = (window as unknown as { __photolabStore: StoreLike }).__photolabStore

      renderer.start()
      // Let anything already pending settle, so the count starts from rest.
      await waitFrames(3)
      const before = renderer.renderCount

      // All sixty inside one task: no frame boundary can fall between them.
      for (let i = 0; i < 60; i++) {
        store.getState().setParameter('exposure', -5 + (10 * i) / 60)
      }

      await waitFrames(3)
      return renderer.renderCount - before
    }, WAIT_FRAMES)

    expect(renders, 'exactly one render for sixty changes in one frame').toBe(1)
  })

  test('renders nothing further while the state is unchanged', async ({ page }) => {
    // The loop runs continuously; it must not redraw an unchanged image. A
    // renderer that drew every frame regardless would keep a laptop's fan on
    // while the user looked at a still picture.
    const renders = await page.evaluate<number, string>(async (waitFramesSrc) => {
      const waitFrames = eval(waitFramesSrc) as (count: number) => Promise<void>
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.start()
      await waitFrames(3)
      const before = renderer.renderCount
      await waitFrames(10)
      return renderer.renderCount - before
    }, WAIT_FRAMES)

    expect(renders, 'an idle loop must not redraw').toBe(0)
  })

  test('renders once per frame across a drag spanning several frames', async ({ page }) => {
    const result = await page.evaluate<{ frames: number; renders: number }, string>(
      async (waitFramesSrc) => {
        const waitFrames = eval(waitFramesSrc) as (count: number) => Promise<void>
        const renderer = (window as unknown as { __photolabRenderer: RendererLike })
          .__photolabRenderer
        const store = (window as unknown as { __photolabStore: StoreLike }).__photolabStore

        renderer.start()
        await waitFrames(3)
        const before = renderer.renderCount

        store.getState().beginInteraction()
        const frames = 6
        for (let frame = 0; frame < frames; frame++) {
          // Ten changes per frame, as a high-rate pointer would deliver.
          for (let i = 0; i < 10; i++) {
            store.getState().setParameter('exposure', -3 + frame * 0.5 + i * 0.01)
          }
          await waitFrames(1)
        }
        store.getState().endInteraction()
        await waitFrames(3)

        return { frames, renders: renderer.renderCount - before }
      },
      WAIT_FRAMES,
    )

    // Sixty changes over six frames: at most one render per frame, plus the
    // resolution changes at each end of the gesture.
    expect(result.renders).toBeLessThanOrEqual(result.frames + 3)
    expect(result.renders).toBeGreaterThan(0)
  })
})

test.describe('drag proxy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window && '__photolabStore' in window)
  })

  test('shrinks the drawing buffer but not the displayed size', async ({ page }) => {
    const sizes = await page.evaluate(() => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      const store = (window as unknown as { __photolabStore: StoreLike }).__photolabStore
      renderer.stop()
      // Forced on, because the shipping behaviour engages only when frames are
      // being missed and this machine does not miss any. A timing-dependent test
      // of a timing-dependent feature would be flaky in both directions.
      renderer.setDragProxyMode('always')
      renderer.renderNow()

      const canvas = renderer.context.canvas
      const idle = {
        buffer: [canvas.width, canvas.height] as [number, number],
        css: canvas.style.width,
      }

      store.getState().beginInteraction()
      store.getState().setParameter('exposure', 1)
      renderer.renderNow()
      const dragging = {
        buffer: [canvas.width, canvas.height] as [number, number],
        css: canvas.style.width,
        interacting: renderer.interacting,
      }

      store.getState().endInteraction()
      renderer.renderNow()
      const restored = {
        buffer: [canvas.width, canvas.height] as [number, number],
        css: canvas.style.width,
        interacting: renderer.interacting,
      }

      return { idle, dragging, restored }
    })

    expect(sizes.dragging.interacting).toBe(true)
    expect(sizes.restored.interacting).toBe(false)

    // The buffer halves on each axis: a quarter of the fragment work.
    expect(sizes.dragging.buffer[0]).toBeLessThan(sizes.idle.buffer[0])
    expect(sizes.dragging.buffer[0] / sizes.idle.buffer[0]).toBeCloseTo(0.5, 1)
    expect(sizes.dragging.buffer[1] / sizes.idle.buffer[1]).toBeCloseTo(0.5, 1)

    // The element does not move or reflow. If the CSS size changed with the
    // buffer, the image would jump smaller on pointer-down.
    expect(sizes.dragging.css).toBe(sizes.idle.css)
    expect(sizes.restored.css).toBe(sizes.idle.css)
    expect(sizes.restored.buffer).toEqual(sizes.idle.buffer)
  })

  test('changes resolution without compiling anything', async ({ page }) => {
    // Resolution is a uniform, not a compile-time variant. A drag that
    // recompiled at each end would stutter exactly when the interface is meant
    // to be at its most responsive.
    const counts = await page.evaluate<{ before: number; during: number; after: number; allocationsBefore: number; allocationsAfter: number }, string>(
      async (waitFramesSrc) => {
        const waitFrames = eval(waitFramesSrc) as (count: number) => Promise<void>
        const renderer = (window as unknown as { __photolabRenderer: RendererLike })
          .__photolabRenderer
        const store = (window as unknown as { __photolabStore: StoreLike }).__photolabStore

        renderer.stop()

        // Warm every pass the drag will use before the count starts. Enabling a
        // pass for the first time legitimately compiles it; that is a graph
        // structure change, not a resolution change, and it is measured by
        // plumbing.spec.ts. What must compile nothing is the proxy switch, and
        // mixing the two would let a real regression hide behind an expected
        // increment.
        renderer.setDragProxyMode('always')
        store.getState().setParameter('exposure', 1)
        renderer.renderNow()
        store.getState().setParameter('exposure', 0)
        renderer.renderNow()

        const before = renderer.graph.compileCount
        const allocationsBefore = renderer.graph.allocationCount

        store.getState().beginInteraction()
        renderer.renderNow()
        const during = renderer.graph.compileCount

        for (let i = 0; i < 30; i++) {
          store.getState().setParameter('exposure', -3 + (6 * i) / 30)
          renderer.renderNow()
        }

        store.getState().endInteraction()
        renderer.renderNow()
        await waitFrames(1)

        return {
          before,
          during,
          after: renderer.graph.compileCount,
          allocationsBefore,
          allocationsAfter: renderer.graph.allocationCount,
        }
      },
      WAIT_FRAMES,
    )

    expect(counts.during, 'entering the drag proxy must not compile').toBe(counts.before)
    expect(counts.after, 'a full drag including both transitions must not compile').toBe(
      counts.before,
    )

    // Buffers are a different matter: a resolution change genuinely needs new
    // targets. Two per size is the ping-pong pair, and the reduced size is used
    // for the whole drag rather than reallocated per frame.
    expect(counts.allocationsAfter - counts.allocationsBefore).toBeLessThanOrEqual(4)
  })

  test('produces the same colours at both proxy resolutions, with both passes engaged', async ({
    page,
  }) => {
    // The two-resolution invariant, with exposure and contrast actually running
    // rather than only ingest and display. Both are per-pixel functions of the
    // value at that pixel, so neither may consult the buffer's resolution and
    // the two sizes must agree to within where they round.
    //
    // A pass that reached for uResolution where it should have used uSourceRect
    // would fail here, and that is not hypothetical: the uniform contract carried
    // exactly that defect until it was found in Stage 3, where the expression
    // that appeared to use the image size cancelled down to using the buffer's.
    //
    // tests/golden/two-resolution.spec.ts carries the spatial-effect version
    // once there are spatial effects, where the answer is a resampled image
    // comparison rather than an equality.
    const { full, proxy, fullSize, proxySize, passIds } = await page.evaluate(() => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      const store = (window as unknown as { __photolabStore: StoreLike }).__photolabStore
      renderer.stop()

      renderer.setDragProxyMode('always')
      // Both passes off their identity values, so both are in the chain.
      store.getState().setParameter('exposure', 1.35)
      store.getState().setParameter('contrast', 1.4)

      const gl = renderer.context.gl
      const canvas = renderer.context.canvas

      // Patch centres of the 5x5 grid, above the ramp band.
      const uvs: [number, number][] = []
      for (let i = 0; i < 25; i++) {
        const column = i % 5
        const row = Math.floor(i / 5)
        uvs.push([(column + 0.5) / 5, 1 - ((row + 0.5) / 5) * 0.8])
      }

      const sample = (): number[][] => {
        const pixel = new Uint8Array(4)
        const out: number[][] = []
        for (const [u, v] of uvs) {
          const x = Math.min(canvas.width - 1, Math.max(0, Math.round(u * canvas.width)))
          const y = Math.min(canvas.height - 1, Math.max(0, Math.round(v * canvas.height)))
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          out.push([pixel[0] ?? -1, pixel[1] ?? -1, pixel[2] ?? -1])
        }
        return out
      }

      renderer.renderNow()
      const full = sample()
      const fullSize: [number, number] = [canvas.width, canvas.height]

      store.getState().beginInteraction()
      renderer.renderNow()
      const proxy = sample()
      const proxySize: [number, number] = [canvas.width, canvas.height]
      store.getState().endInteraction()

      return { full, proxy, fullSize, proxySize, passIds: renderer.graph.passIds }
    })

    // The comparison is only meaningful if the resolutions actually differed and
    // both passes actually ran.
    expect(proxySize[0], 'the proxy must be a different resolution').toBeLessThan(fullSize[0])
    expect(passIds).toContain('exposure')
    expect(passIds).toContain('contrast')
    expect(proxy).toHaveLength(full.length)
    const failures: string[] = []
    for (let i = 0; i < full.length; i++) {
      const a = full[i]
      const b = proxy[i]
      if (!a || !b) continue
      for (let c = 0; c < 3; c++) {
        // One code value of rounding either side. Not a tuned number: every pass
        // in the chain is a per-pixel function of the same input, so the only
        // legitimate difference is where the two resolutions round.
        if (Math.abs((a[c] ?? -1) - (b[c] ?? -1)) > 1) {
          failures.push(`patch ${i} channel ${'rgb'[c] ?? '?'}: full ${a[c]}, proxy ${b[c]}`)
        }
      }
    }
    expect(failures.join('\n')).toBe('')
  })
})
