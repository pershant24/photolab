import { expect, test } from '@playwright/test'

/**
 * The 1:1 inspector, and what it is worth as a test fixture.
 *
 * It exists because grain is otherwise a parameter that cannot be evaluated: at
 * the default size on a large source the proxy correctly fades it to nothing, so
 * the user sets a number, sees no change, and finds out on export.
 *
 * Implemented as a change to `uSourceRect` and nothing else, so it runs the
 * identical pass chain over a different region rather than being a second render
 * path. Two assertions follow from that, and they are different questions:
 *
 * 1. **The region is derived correctly.** The inspector's own render must match a
 *    direct graph render of the rect it claims to be showing. This covers
 *    `passContext()`, which no other test reaches — `tile-overlap` exercises the
 *    graph at a non-zero origin, but it builds the rect itself.
 * 2. **The main view and the inspector agree about the picture.** They render the
 *    same source region at different scales at the same moment, which is the
 *    combination Part A's audit found untested, and it is the arrangement a user
 *    is in whenever they toggle the button.
 */

interface RendererLike {
  stop(): void
  renderNow(): void
  syncSize(available?: { width: number; height: number }): boolean
  setView(next: Record<string, unknown>): void
  setInteracting(active: boolean): void
  setDragProxyMode(mode: 'auto' | 'always' | 'never'): void
  passContext(): {
    resolution: readonly [number, number]
    imageSize: readonly [number, number]
    sourceRect: readonly [number, number, number, number]
  }
  readonly inspecting: boolean
  view: Record<string, unknown>
  source: { kind: string; sourceWidth: number; sourceHeight: number }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  graph: {
    pool: { acquire(w: number, h: number): { framebuffer: unknown }; release(t: unknown): void }
    render(input: unknown, viewport: unknown, options?: unknown): void
  }
  input: { edit: Record<string, unknown>; view: Record<string, unknown> }
}

const SOURCE = { width: 1600, height: 1200 }

/**
 * A smooth two-axis gradient with fine detail laid over it.
 *
 * Smooth, so that the main view's downscale of it is a fair comparison — a
 * hard-edged source sampled at two rates disagrees because of the source
 * texture's own aliasing, which was the first thing to go wrong in
 * `two-resolution.spec.ts`. The fine detail is there so the inspector has
 * something to show that the proxy cannot.
 */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  const image = context.createImageData(source.width, source.height)
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
      const base = 40 + 150 * (x / source.width) + 40 * (y / source.height)
      const fine = 12 * Math.sin(x * 1.7) * Math.sin(y * 1.7)
      const v = Math.max(0, Math.min(255, Math.round(base + fine)))
      image.data[i] = v
      image.data[i + 1] = Math.max(0, Math.min(255, Math.round(v * 0.9)))
      image.data[i + 2] = Math.max(0, Math.min(255, Math.round(v * 0.8)))
      image.data[i + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'gradient.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

/** Pointwise only: no spatial pass, so scale cannot legitimately change a pixel. */
const POINTWISE = {
  exposure: 0.4, contrast: 1.2, halationStrength: 0, grainStrength: 0, filmStrength: 0,
}

/** Everything the page-side code needs, since it cannot close over this module. */
const ARGS = { edit: POINTWISE, source: SOURCE }

test.describe('the 1:1 inspector', () => {
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

  test('asks for a buffer-sized region of the source, centred where it is looking', async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      const whole = renderer.passContext()
      renderer.setView({ inspect: true, inspectCentre: [0.2, 0.2] })
      const near = renderer.passContext()
      renderer.setView({ inspectCentre: [0.8, 0.8] })
      const far = renderer.passContext()
      renderer.setView({ inspect: false })
      return {
        whole: [...whole.sourceRect],
        near: [...near.sourceRect],
        far: [...far.sourceRect],
        resolution: [...far.resolution],
        inspecting: renderer.inspecting,
      }
    })

    // The main view covers the whole source; the inspector covers a buffer-sized
    // piece of it, which is what "one buffer pixel per source pixel" means.
    expect(result.whole).toEqual([0, 0, SOURCE.width, SOURCE.height])
    expect(result.far[2]).toBe(Math.min(result.resolution[0] ?? 0, SOURCE.width))
    expect(result.far[3]).toBe(Math.min(result.resolution[1] ?? 0, SOURCE.height))

    // The region tracks the centre. Not asserted as a specific origin: with a
    // canvas nearly as wide as the source the rect is clamped against the edge
    // for most centres, and 0 is then the right answer rather than a failure.
    // What must hold is that panning moves it, and that it stays inside.
    expect(result.near).not.toEqual(result.far)
    for (const rect of [result.near, result.far]) {
      expect(rect[0]).toBeGreaterThanOrEqual(0)
      expect(rect[1]).toBeGreaterThanOrEqual(0)
      expect((rect[0] ?? 0) + (rect[2] ?? 0)).toBeLessThanOrEqual(SOURCE.width)
      expect((rect[1] ?? 0) + (rect[3] ?? 0)).toBeLessThanOrEqual(SOURCE.height)
    }
    expect(result.inspecting).toBe(false)
  })

  test('renders exactly what a direct render of its own region renders', async ({ page }) => {
    // The assertion that pins `passContext()`. If the inspector asked for one
    // region and drew another, every other assertion here would still pass while
    // the user looked at the wrong part of the photograph.
    const worst = await page.evaluate(({ edit }) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      const gl = renderer.context.gl
      const decodeHalf = (h: number): number => {
        const sign = h & 0x8000 ? -1 : 1
        const exponent = (h >> 10) & 0x1f
        const fraction = h & 0x3ff
        if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
        if (exponent === 31) return fraction ? NaN : sign * Infinity
        return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
      }

      renderer.setView({ inspect: true, inspectCentre: [0.35, 0.6] })
      const context = renderer.passContext()
      const [width, height] = context.resolution
      const input = {
        ...renderer.input,
        edit: { ...renderer.input.edit, ...edit },
        view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
      }

      const readInto = (viewport: unknown): Float32Array => {
        const target = renderer.graph.pool.acquire(width, height)
        renderer.graph.render(input, viewport, { finalTarget: target })
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
        const raw = new Uint16Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, raw)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        renderer.graph.pool.release(target)
        const out = new Float32Array(width * height)
        for (let i = 0; i < width * height; i++) out[i] = decodeHalf(raw[i * 4] ?? 0)
        return out
      }

      // What the inspector asked for, and the same rect written out by hand.
      const viaInspector = readInto(context)
      const rect = context.sourceRect
      const viaRect = readInto({
        resolution: [width, height] as const,
        imageSize: [...context.imageSize] as const,
        sourceRect: [rect[0], rect[1], rect[2], rect[3]] as const,
      })
      renderer.setView({ inspect: false })

      let w = 0
      for (let i = 0; i < viaInspector.length; i++) {
        w = Math.max(w, Math.abs((viaInspector[i] ?? 0) - (viaRect[i] ?? 0)))
      }
      return w
    }, ARGS)

    // Identical arithmetic on identical inputs.
    expect(worst).toBe(0)
  })

  test('shows the same picture as the main view, at a different scale', async ({ page }) => {
    // The combination Part A's audit found untested: the same source region
    // rendered at two scales *and* at two origins at the same moment. With only
    // pointwise passes enabled, scale cannot legitimately change a pixel, so any
    // disagreement beyond resampling is a bug in how one of the two builds its
    // rect.
    const result = await page.evaluate(({ edit, source }) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      const gl = renderer.context.gl
      const decodeHalf = (h: number): number => {
        const sign = h & 0x8000 ? -1 : 1
        const exponent = (h >> 10) & 0x1f
        const fraction = h & 0x3ff
        if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
        if (exponent === 31) return fraction ? NaN : sign * Infinity
        return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
      }
      const input = {
        ...renderer.input,
        edit: { ...renderer.input.edit, ...edit },
        view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
      }
      const read = (
        context: { resolution: readonly [number, number]; imageSize: readonly [number, number]; sourceRect: readonly [number, number, number, number] },
      ): { pixels: Float32Array; width: number; height: number } => {
        const [width, height] = context.resolution
        const target = renderer.graph.pool.acquire(width, height)
        renderer.graph.render(input, context, { finalTarget: target })
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
        const raw = new Uint16Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, raw)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        renderer.graph.pool.release(target)
        const pixels = new Float32Array(width * height)
        for (let i = 0; i < width * height; i++) pixels[i] = decodeHalf(raw[i * 4] ?? 0)
        return { pixels, width, height }
      }

      renderer.setView({ inspect: false })
      const main = read(renderer.passContext())
      renderer.setView({ inspect: true, inspectCentre: [0.4, 0.55] })
      const inspectorContext = renderer.passContext()
      const zoom = read(inspectorContext)
      renderer.setView({ inspect: false })

      // Sample the inspector on a grid, map each sample to its source pixel, then
      // to the main view's own buffer, and compare.
      const rect = inspectorContext.sourceRect
      let worst = 0
      let samples = 0
      const STEP = 7
      for (let y = STEP; y < zoom.height - STEP; y += STEP) {
        for (let x = STEP; x < zoom.width - STEP; x += STEP) {
          const sx = (rect[0] ?? 0) + x + 0.5
          const sy = (rect[1] ?? 0) + (zoom.height - 1 - y) + 0.5
          const mx = Math.round((sx / source.width) * main.width - 0.5)
          const my = main.height - 1 - Math.round((sy / source.height) * main.height - 0.5)
          if (mx < 0 || my < 0 || mx >= main.width || my >= main.height) continue
          const a = zoom.pixels[y * zoom.width + x] ?? 0
          const b = main.pixels[my * main.width + mx] ?? 0
          worst = Math.max(worst, Math.abs(a - b))
          samples++
        }
      }
      return { worst, samples, mainSize: [main.width, main.height], zoomSize: [zoom.width, zoom.height] }
    }, ARGS)

    expect(result.samples).toBeGreaterThan(500)
    // The main view is a downscale, so it has averaged the fine detail the
    // inspector resolves. What survives that is the smooth gradient, and the
    // bound is the amplitude of the detail the downscale removed — 12/255 in the
    // source, carried through exposure and contrast — plus the half-pixel
    // registration error between the two grids over the gradient's own slope.
    // Anything larger is not resampling, it is a different region.
    expect(
      result.worst,
      `worst ${result.worst.toExponential(2)} between a ${result.mainSize.join('x')} main view and a ${result.zoomSize.join('x')} inspector`,
    ).toBeLessThan(0.12)
  })

  test('is exempt from the drag proxy, which would defeat it', async ({ page }) => {
    // The proxy halves the drawing buffer, and the inspector exists to show one
    // source pixel per buffer pixel. Engaging it here would replace the only
    // thing the view is for with the thing the user opened it to escape.
    const result = await page.evaluate(() => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.setDragProxyMode('always')
      const canvas = { width: 600, height: 450 }

      renderer.setView({ inspect: false })
      renderer.setInteracting(false)
      renderer.syncSize(canvas)
      const restingWidth = renderer.context.canvas.width

      renderer.setInteracting(true)
      renderer.syncSize(canvas)
      const draggingMain = renderer.context.canvas.width

      renderer.setView({ inspect: true })
      renderer.syncSize(canvas)
      const draggingInspector = renderer.context.canvas.width

      renderer.setInteracting(false)
      renderer.setView({ inspect: false })
      renderer.setDragProxyMode('auto')
      return { restingWidth, draggingMain, draggingInspector }
    })

    // The proxy is doing its job in the main view...
    expect(result.draggingMain).toBeLessThan(result.restingWidth)
    // ...and stays out of the inspector.
    expect(result.draggingInspector).toBe(result.restingWidth)
  })
})
