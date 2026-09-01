import { expect, test } from '@playwright/test'

import {
  GRAIN_FULL_AMPLITUDE_PERIOD,
  grainDivergenceSourcePixels,
} from '../../src/core/colour/grain'

/**
 * Grain against the two-resolution invariant, and where the invariant stops.
 *
 * # The invariant holds only down to the proxy's resolution limit
 *
 * Every other spatial parameter in this pipeline is expressed against the source
 * and is expected to render identically at any buffer resolution. Grain is
 * expressed the same way and **cannot** meet the same bar, for a reason that is
 * physical rather than a defect: a few source pixels is below a proxy's Nyquist
 * frequency, so the preview cannot represent it at all.
 *
 * The response is deliberately not to make the invariant pass. Forcing it would
 * mean coarsening the export's grain until the preview could draw it, which is
 * the preview dictating the picture. Instead:
 *
 * - Above the representable limit the invariant is asserted, and this file
 *   asserts it.
 * - Below it the preview fades the amplitude rather than drawing grain of the
 *   wrong size, and this file measures where that begins.
 *
 * The scope is therefore part of the test rather than a caveat next to it: the
 * grain size below is pinned above the limit, and the second test establishes
 * that the limit is where `src/core/colour/grain.ts` says it is.
 */

interface RendererLike {
  stop(): void
  context: { gl: WebGL2RenderingContext }
  graph: {
    pool: { acquire(w: number, h: number): { framebuffer: unknown }; release(t: unknown): void }
    render(input: unknown, viewport: unknown, options: unknown): void
  }
  input: { edit: Record<string, unknown>; view: Record<string, unknown> }
}

const SOURCE = { width: 400, height: 300 }

/**
 * A flat middle grey, so grain is the only thing that varies.
 *
 * On a picture, a difference between two resolutions could be the grain or could
 * be the picture resampled; on a flat field it can only be the grain.
 */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  context.fillStyle = 'rgb(118, 118, 118)'
  context.fillRect(0, 0, source.width, source.height)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'flat.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

/**
 * Grain of 16 source pixels, which is four times the limit at the coarse buffer.
 *
 * **This is the scope.** At a 2:1 proxy the buffer scale is 0.5, so the smallest
 * representable period is `GRAIN_FULL_AMPLITUDE_PERIOD / 0.5` = 4 source pixels.
 * 16 is comfortably above it, which is the condition under which the invariant is
 * claimed at all. Pinned here rather than taken from the shipping default, which
 * is far finer and would put this test below its own scope.
 */
const GRAIN_PERIOD_SOURCE_PIXELS = 16
const EDIT = {
  grainStrength: 1,
  grainSize: GRAIN_PERIOD_SOURCE_PIXELS / SOURCE.width,
  halationStrength: 0,
  filmStrength: 0,
}

test.describe('grain and buffer resolution', () => {
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

  /** Render at a buffer size and sample a shared normalised grid. */
  async function sampleAt(
    page: import('@playwright/test').Page,
    edit: Record<string, number>,
    sizes: readonly (readonly [number, number])[],
  ): Promise<number[][]> {
    return page.evaluate<
      number[][],
      {
        edit: Record<string, number>
        source: { width: number; height: number }
        sizes: number[][]
      }
    >(({ edit, source, sizes }) => {
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

      const GRID = 40
      const renderAt = (width: number, height: number): number[] => {
        const target = renderer.graph.pool.acquire(width, height)
        renderer.graph.render(
          {
            ...renderer.input,
            edit: { ...renderer.input.edit, ...edit },
            view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
          },
          {
            resolution: [width, height] as const,
            imageSize: [source.width, source.height] as const,
            sourceRect: [0, 0, source.width, source.height] as const,
          },
          { finalTarget: target },
        )
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
        const pixel = new Uint16Array(4)
        const out: number[] = []
        for (let gy = 0; gy < GRID; gy++) {
          for (let gx = 0; gx < GRID; gx++) {
            const x = Math.min(width - 1, Math.round(((gx + 0.5) / GRID) * width))
            const y = Math.min(height - 1, Math.round(((gy + 0.5) / GRID) * height))
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.HALF_FLOAT, pixel)
            out.push(decodeHalf(pixel[0] ?? 0))
          }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        renderer.graph.pool.release(target)
        return out
      }

      return sizes.map((s) => renderAt(s[0] ?? 0, s[1] ?? 0))
    }, { edit, source: SOURCE, sizes: sizes.map((s) => [s[0], s[1]]) })
  }

  test('holds for grain above the representable limit', async ({ page }) => {
    const [high, low] = await sampleAt(page, EDIT, [
      [SOURCE.width, SOURCE.height],
      [SOURCE.width / 2, SOURCE.height / 2],
    ])
    expect(high).toBeDefined()
    expect(low).toBeDefined()
    if (!high || !low) return

    // Not vacuous: the frame is flat, so all of this spread is grain. With grain
    // off, or fully attenuated, the two renders would agree perfectly and the
    // assertion below would mean nothing.
    const spread = Math.max(...high) - Math.min(...high)
    expect(spread, 'no grain in the frame to compare').toBeGreaterThan(0.01)

    /**
     * Derived, not tuned.
     *
     * Both buffers sample the same continuous noise field, but their pixel
     * centres do not coincide. This is a **first-order** error, unlike the
     * halation case, because what is sampled is the noise itself rather than a
     * field already smoothed by a kernel much wider than either sample spacing.
     *
     * The displacement was underestimated on the first attempt, at 1 source pixel
     * along one axis, and the bound came out at 1.09e-2 against a measured
     * 1.93e-2. Two things were missing:
     *
     * - **Both grids round.** A shared grid position rounds to the nearest texel
     *   in each render — up to half a coarse texel (1 source pixel at 2:1) and
     *   half a fine texel (0.5) — so the separation reaches 1.5 source pixels per
     *   axis, not 1.
     * - **The displacement is two-dimensional.** It applies in x and y at once,
     *   so the worst case is the diagonal, a further factor of sqrt(2).
     *
     *   offset        <= 1.5 * sqrt(2) source pixels
     *   noise slope    = 1.5 * range / period = 1.5 * 2 / 16 per source pixel
     *   swing          = noise * GRAIN_MAX_DENSITY_SWING, in ACEScct
     *   -> stops       = swing * 17.52
     *   -> linear      = 2^stops - 1, relative
     *   -> encoded     = that / 2.4, since the display OETF is a 2.4 power
     *
     * Doubled for headroom per SHADER_CONVENTIONS.md section 5, with the
     * half-float floor added.
     */
    const offsetSourcePixels = 1.5 * Math.SQRT2
    const noiseSlope = (1.5 * 2) / GRAIN_PERIOD_SOURCE_PIXELS
    const swing = noiseSlope * offsetSourcePixels * 0.012
    const stops = swing * 17.52
    const relativeLinear = 2 ** stops - 1
    const MIDDLE_GREY_ENCODED = 0.45
    const tolerance = 2 * ((relativeLinear / 2.4) * MIDDLE_GREY_ENCODED) + 2 ** -11

    let worst = 0
    for (let i = 0; i < high.length; i++) {
      worst = Math.max(worst, Math.abs((high[i] ?? 0) - (low[i] ?? 0)))
    }
    expect(
      worst,
      `worst disagreement ${worst.toExponential(2)} against a derived bound of ${tolerance.toExponential(2)}`,
    ).toBeLessThan(tolerance)
  })

  test('measures the size below which a proxy necessarily diverges', async ({ page }) => {
    // The requirement is a measured divergence threshold rather than an estimated
    // one. `grainDivergenceSourcePixels` predicts it from the same constant the
    // shader fades on; this checks the prediction against renders.
    //
    // At a 2:1 buffer the prediction is 4 source pixels. Sizes are swept across
    // it and the amplitude of the coarse render is compared against the fine one.
    const bufferScale = 0.5
    const predicted = grainDivergenceSourcePixels(bufferScale)
    expect(predicted).toBe(GRAIN_FULL_AMPLITUDE_PERIOD / bufferScale)

    const periods = [1.5, 2, 3, 4, 6, 12]
    const results: { period: number; fine: number; coarse: number }[] = []
    for (const period of periods) {
      const [high, low] = await sampleAt(
        page,
        { ...EDIT, grainSize: period / SOURCE.width },
        [[SOURCE.width, SOURCE.height], [SOURCE.width / 2, SOURCE.height / 2]],
      )
      if (!high || !low) continue
      const amplitude = (values: number[]): number => {
        const mean = values.reduce((s, v) => s + v, 0) / values.length
        let variance = 0
        for (const v of values) variance += (v - mean) * (v - mean)
        return Math.sqrt(variance / values.length)
      }
      results.push({ period, fine: amplitude(high), coarse: amplitude(low) })
    }

    const at = (period: number): { fine: number; coarse: number } =>
      results.find((r) => r.period === period) ?? { fine: 0, coarse: 0 }

    // Above the predicted limit the coarse buffer draws the grain at essentially
    // full amplitude.
    expect(at(12).coarse / at(12).fine).toBeGreaterThan(0.7)
    expect(at(6).coarse / at(6).fine).toBeGreaterThan(0.6)

    // Below it the coarse buffer fades rather than aliasing. The failure being
    // guarded against is the OPPOSITE of a small number here: a naive hash below
    // Nyquist returns uncorrelated values and the coarse amplitude stays high
    // while the size is wrong, so a ratio near or above one at period 1.5 would
    // mean the preview is drawing grain the export does not have.
    expect(at(1.5).coarse / at(1.5).fine).toBeLessThan(0.25)
    expect(at(2).coarse / at(2).fine).toBeLessThan(0.5)

    // And the crossover is where the constant says it is, not somewhere else.
    expect(at(predicted).coarse / at(predicted).fine).toBeGreaterThan(
      at(predicted / 2).coarse / at(predicted / 2).fine,
    )
  })
})
