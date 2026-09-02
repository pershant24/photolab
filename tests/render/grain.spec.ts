import { expect, test } from '@playwright/test'

import { grainDensityModulation } from '../../src/core/colour/grain'

/**
 * Grain amplitude follows the density modulation, measured on a real render.
 *
 * # Why the amplitude and not the value
 *
 * The other shader agreement tests in this suite compare a rendered value
 * against a TypeScript reference pointwise. That cannot work here: the value at a
 * pixel depends on the hash, and a TypeScript copy of the hash would assert only
 * that two transcriptions of an arbitrary mixing function match — which is a
 * check on typing, not on the effect.
 *
 * What the modulation actually claims is about the **amplitude**: grain is
 * strongest on a correctly exposed midtone and falls to nothing in the toe and
 * the shoulder. That is measurable without knowing any individual noise value —
 * take the spread across a band of constant exposure — and it is the claim that
 * matters. A pointwise test could pass with the modulation applied upside down.
 *
 * Measured in ACEScct, because that is the space the perturbation is applied in.
 * Measuring the spread of linear values instead would recover the exponential,
 * not the modulation, and would report grain growing towards the highlights.
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

const SOURCE = { width: 512, height: 512 }

/** Period of 4 source pixels on a 512px long edge: well above the band limit at 1:1. */
const EDIT = {
  grainStrength: 1,
  grainSize: 4 / 512,
  halationStrength: 0,
  filmStrength: 0,
  exposure: 0,
  contrast: 1,
}

/**
 * A vertical ramp of constant-value rows.
 *
 * Each row is one exposure, so the spread across a row is grain and nothing else.
 * The full 0-255 sweep is used so the ramp covers the toe, the peak and the
 * shoulder in one render.
 */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  const image = context.createImageData(source.width, source.height)
  for (let y = 0; y < source.height; y++) {
    const v = Math.round((y / (source.height - 1)) * 255)
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
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

test.describe('grain amplitude tracks density', () => {
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

  /** Per-row mean and standard deviation of the rendered value, in ACEScct. */
  async function profile(
    page: import('@playwright/test').Page,
    edit: Record<string, number>,
  ): Promise<{ meanStops: number[]; spread: number[] }> {
    return page.evaluate<
      { meanStops: number[]; spread: number[] },
      { edit: Record<string, number>; source: { width: number; height: number } }
    >(({ edit, source }) => {
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

      // The readback is DISPLAY-ENCODED, because the display pass still applies
      // the primaries matrix and the transfer function with the tone map off. It
      // has to be linearised before anything is read as an exposure.
      //
      // Skipping this step is not a small error: it maps a true middle grey to
      // +1.32 stops, so the measured amplitude profile peaks a stop and a third
      // high and appears to die just below grey. It looked exactly like a broken
      // modulation, and the modulation was correct.
      const srgbEotf = (encoded: number): number =>
        encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4)

      // ACEScct, transcribed from src/render/shaders/lib/colour.glsl.
      const encodeACEScct = (linear: number): number =>
        linear <= 0.0078125
          ? 10.5402377416545 * linear + 0.0729055341958355
          : (Math.log2(linear) + 9.72) / 17.52
      const MIDDLE_GREY_ACESCCT = 0.4135884025
      const STOP = 1 / 17.52

      const input = {
        ...renderer.input,
        edit: { ...renderer.input.edit, ...edit },
        view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
      }

      const width = source.width
      const height = source.height
      const target = renderer.graph.pool.acquire(width, height)
      renderer.graph.render(
        input,
        {
          resolution: [width, height] as const,
          imageSize: [width, height] as const,
          sourceRect: [0, 0, width, height] as const,
        },
        { finalTarget: target },
      )
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
      const raw = new Uint16Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, raw)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      renderer.graph.pool.release(target)

      const meanStops: number[] = []
      const spread: number[] = []
      for (let y = 0; y < height; y++) {
        let sum = 0
        const values: number[] = []
        for (let x = 0; x < width; x++) {
          const linear = srgbEotf(decodeHalf(raw[(y * width + x) * 4] ?? 0))
          const encoded = encodeACEScct(Math.max(linear, 1e-8))
          values.push(encoded)
          sum += encoded
        }
        const mean = sum / width
        let variance = 0
        for (const v of values) variance += (v - mean) * (v - mean)
        meanStops.push((mean - MIDDLE_GREY_ACESCCT) / STOP)
        spread.push(Math.sqrt(variance / width))
      }
      return { meanStops, spread }
    }, { edit, source: SOURCE })
  }

  test('is strongest at middle grey and absent at the toe and the shoulder', async ({ page }) => {
    const { meanStops, spread } = await profile(page, EDIT)

    /** The measured spread at the row whose exposure is nearest `stops`. */
    const at = (stops: number): number => {
      let best = 0
      let bestDistance = Infinity
      for (let i = 0; i < meanStops.length; i++) {
        const d = Math.abs((meanStops[i] ?? 0) - stops)
        if (d < bestDistance) { bestDistance = d; best = i }
      }
      return spread[best] ?? 0
    }

    const peak = at(0)
    expect(peak, 'no grain at middle grey').toBeGreaterThan(1e-3)

    // The shape, not the scale. Deep shadow and display white are both past the
    // modulation's reach, so grain there must be a small fraction of the peak —
    // this is what separates density-dependent grain from a noise overlay, and a
    // uniform overlay would score 1.0 on both.
    expect(at(-4.5) / peak, 'grain in the deep shadows').toBeLessThan(0.15)
    expect(at(2.4) / peak, 'grain in the blown highlights').toBeLessThan(0.2)

    // And it is not merely smaller at the ends: it follows the curve in between.
    // Half a stop either side of grey is still near the peak; two stops down is
    // partway; three and a half is nearly gone.
    expect(at(-0.5) / peak).toBeGreaterThan(0.8)
    expect(at(-2) / peak).toBeGreaterThan(0.25)
    expect(at(-2) / peak).toBeLessThan(0.75)
    expect(at(-3.5) / peak).toBeLessThan(0.3)
  })

  test('matches the TypeScript modulation across the ramp', async ({ page }) => {
    const { meanStops, spread } = await profile(page, EDIT)

    // Rows are binned before comparison. Each row is a standard deviation
    // estimated from 512 samples of a lattice with a 4-pixel period — about 128
    // independent cells — so a single row carries several per cent of sampling
    // error, and the estimator is noisier than the thing being estimated.
    // Neighbouring rows differ by a hundredth of a stop, so averaging them
    // estimates the same quantity with less noise rather than blurring it.
    const BIN = 16
    const binStops: number[] = []
    const binSpread: number[] = []
    for (let i = 0; i + BIN <= meanStops.length; i += BIN) {
      let ms = 0
      let sp = 0
      for (let k = 0; k < BIN; k++) {
        ms += meanStops[i + k] ?? 0
        sp += spread[i + k] ?? 0
      }
      binStops.push(ms / BIN)
      binSpread.push(sp / BIN)
    }

    // The absolute scale is a property of the noise distribution, not of the
    // modulation, so one scale factor is fitted and the SHAPE is compared.
    // Fitted by least squares rather than by dividing through the largest
    // measurement — with a noisy estimator the maximum is biased high, which
    // depresses every other point and reports a shape error that is really a
    // normalisation error.
    const points: { stops: number; measured: number; expected: number }[] = []
    for (let i = 0; i < binStops.length; i++) {
      const stops = binStops[i] ?? 0
      // Below the toe's reach there is nothing to compare, and the very bottom of
      // the ramp sits in ACEScct's linear splice where a row's own quantisation
      // dominates.
      if (stops < -4 || stops > 2.474) continue
      points.push({ stops, measured: binSpread[i] ?? 0, expected: grainDensityModulation(stops) })
    }
    expect(points.length).toBeGreaterThan(12)

    let numerator = 0
    let denominator = 0
    for (const p of points) {
      numerator += p.measured * p.expected
      denominator += p.expected * p.expected
    }
    const scale = numerator / denominator
    expect(scale).toBeGreaterThan(1e-4)

    let worst = 0
    let worstAt = 0
    for (const p of points) {
      const error = Math.abs(p.measured / scale - p.expected)
      if (error > worst) { worst = error; worstAt = p.stops }
    }

    expect(worst, `worst shape error ${worst.toFixed(3)} at ${worstAt.toFixed(2)} stops`)
      .toBeLessThan(0.12)
  })

  test('passes through the tone map untouched; it is gamut compression that acts on it', async ({ page }) => {
    // Correcting a claim this suite previously made. Grain was measured losing
    // between a third and three quarters of its amplitude in some regions of a
    // photograph once the display transform was enabled, and that was written up
    // as the tone map's shoulder compressing it.
    //
    // It is not the tone map. Splitting the two stages, `toneMap` alone keeps
    // grain at 1.000 in every region measured and `gamutCompress` alone accounts
    // for the entire effect, to three decimals. The regions affected were the
    // saturated ones, not the bright ones — per-channel independent noise creates
    // chroma excursions, and in an already-saturated area those land outside the
    // display gamut and get pulled back.
    //
    // Asserted here on a neutral ramp, where gamut compression has nothing to do,
    // so what is pinned is the half of the correction this fixture can see: the
    // tone map is not the mechanism.
    const kept = await page.evaluate<number, { edit: Record<string, number>; source: { width: number; height: number } }>(
      ({ edit, source }) => {
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
        const width = source.width
        const height = source.height
        const grab = (e: Record<string, number>, view: Record<string, boolean>): number[] => {
          const target = renderer.graph.pool.acquire(width, height)
          renderer.graph.render(
            { ...renderer.input, edit: { ...renderer.input.edit, ...e },
              view: { ...renderer.input.view, ...view } },
            { resolution: [width, height] as const,
              imageSize: [width, height] as const,
              sourceRect: [0, 0, width, height] as const },
            { finalTarget: target },
          )
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
          const raw = new Uint16Array(width * height * 4)
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, raw)
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          renderer.graph.pool.release(target)
          // Rows selected by their MEASURED level, not by index.
          //
          // `readPixels` is bottom-up, so the ramp arrives inverted and a band
          // chosen by row index is a different band from the one intended. Here
          // it happened to land somewhere usable, which is worse than failing:
          // the same assumption elsewhere in this file produced a comparison
          // against zero samples that passed silently.
          const out: number[] = []
          for (let y = 0; y < height; y++) {
            let mean = 0
            for (let x = 0; x < width; x++) mean += decodeHalf(raw[(y * width + x) * 4] ?? 0)
            mean /= width
            // Around middle grey, where the modulation is strong.
            if (mean < 0.25 || mean > 0.6) continue
            for (let x = 0; x < width; x++) out.push(decodeHalf(raw[(y * width + x) * 4] ?? 0))
          }
          return out
        }
        const sd = (a: number[]): number => {
          const m = a.reduce((s, v) => s + v, 0) / a.length
          return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length)
        }
        const residual = (view: Record<string, boolean>): number => {
          const on = grab(edit, view)
          const off = grab({ ...edit, grainStrength: 0 }, view)
          return sd(on.map((v, i) => v - (off[i] ?? 0)))
        }
        const plain = residual({ toneMap: false, gamutCompress: false })
        if (plain <= 0) return 0
        return residual({ toneMap: true, gamutCompress: false }) / plain
      },
      { edit: EDIT, source: SOURCE },
    )

    expect(kept, `the tone map kept ${(100 * kept).toFixed(1)}% of the grain`)
      .toBeGreaterThan(0.95)
  })

  test('gives the three channels independent noise, not one luminance value', async ({ page }) => {
    // Correlated channels are luminance noise — what a digital sensor makes. The
    // three layers develop separately, and that is why film grain is coloured.
    //
    // # Why not a channel correlation
    //
    // The obvious statistic is corr(R, G) of the rendered values, and it does not
    // work. The readback is in display primaries, and the ACEScg to sRGB matrix
    // has negative off-diagonal terms, so a perturbation of ACEScg red alone
    // pushes sRGB green the other way. Independent noise therefore shows up as a
    // correlation around -0.4 rather than around 0 — measured between -0.27 and
    // -0.56 across twenty regions of a photograph — which is the same
    // neighbourhood a shared-noise mutation lands in. The statistic cannot
    // separate the two cases and a bar drawn through it would be arbitrary.
    //
    // # What does work
    //
    // One shared noise value moves the working-space triple along (1, 1, 1). The
    // matrix maps that to ONE fixed direction in display space, so every residual
    // lies on a single line and its covariance is rank one. Independent noise
    // spans all three dimensions. The share of residual variance in the leading
    // eigenvector separates them completely and does not care what the matrix is.
    const share = await page.evaluate<number, { edit: Record<string, number>; source: { width: number; height: number } }>(
      ({ edit, source }) => {
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
        const width = source.width
        const height = source.height
        const grab = (e: Record<string, number>): Float32Array => {
          const target = renderer.graph.pool.acquire(width, height)
          renderer.graph.render(
            {
              ...renderer.input,
              edit: { ...renderer.input.edit, ...e },
              view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
            },
            {
              resolution: [width, height] as const,
              imageSize: [width, height] as const,
              sourceRect: [0, 0, width, height] as const,
            },
            { finalTarget: target },
          )
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
          const raw = new Uint16Array(width * height * 4)
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, raw)
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          renderer.graph.pool.release(target)
          const out = new Float32Array(width * height * 3)
          for (let i = 0; i < width * height; i++) {
            out[i * 3] = decodeHalf(raw[i * 4] ?? 0)
            out[i * 3 + 1] = decodeHalf(raw[i * 4 + 1] ?? 0)
            out[i * 3 + 2] = decodeHalf(raw[i * 4 + 2] ?? 0)
          }
          return out
        }

        // The grain itself: the difference the pass makes, pixel by pixel. Taking
        // a difference removes the picture, so what is measured is the noise and
        // not the ramp it is sitting on.
        const on = grab(edit)
        const off = grab({ ...edit, grainStrength: 0 })

        // Rows well inside the modulation's reach, so the residual is real.
        // Selected by measured level rather than by row index; readPixels is
        // bottom-up and an index-chosen band is the wrong end of the ramp.
        const rowMean = (y: number, buffer: Float32Array): number => {
          let sum = 0
          for (let x = 0; x < width; x++) sum += buffer[(y * width + x) * 3] ?? 0
          return sum / width
        }
        const from = 0
        const to = height
        const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
        let n = 0
        for (let y = from; y < to; y++) {
          if (rowMean(y, off) < 0.25 || rowMean(y, off) > 0.6) continue
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3
            const d = [
              (on[i] ?? 0) - (off[i] ?? 0),
              (on[i + 1] ?? 0) - (off[i + 1] ?? 0),
              (on[i + 2] ?? 0) - (off[i + 2] ?? 0),
            ]
            for (let a = 0; a < 3; a++) {
              for (let b = 0; b < 3; b++) cov[a * 3 + b] = (cov[a * 3 + b] ?? 0) + (d[a] ?? 0) * (d[b] ?? 0)
            }
            n++
          }
        }
        for (let k = 0; k < 9; k++) cov[k] = (cov[k] ?? 0) / n
        const trace = (cov[0] ?? 0) + (cov[4] ?? 0) + (cov[8] ?? 0)
        if (trace <= 0) return 1

        // Leading eigenvalue by power iteration; three-by-three and symmetric, so
        // a handful of steps is more than enough.
        let v = [1, 0.5, -0.3]
        for (let step = 0; step < 200; step++) {
          const w = [0, 1, 2].map((a) =>
            [0, 1, 2].reduce((s, b) => s + (cov[a * 3 + b] ?? 0) * (v[b] ?? 0), 0),
          )
          const norm = Math.hypot(w[0] ?? 0, w[1] ?? 0, w[2] ?? 0)
          if (norm === 0) break
          v = w.map((c) => c / norm)
        }
        const av = [0, 1, 2].map((a) =>
          [0, 1, 2].reduce((s, b) => s + (cov[a * 3 + b] ?? 0) * (v[b] ?? 0), 0),
        )
        const leading = [0, 1, 2].reduce((s, a) => s + (av[a] ?? 0) * (v[a] ?? 0), 0)
        return leading / trace
      },
      { edit: EDIT, source: SOURCE },
    )

    // One shared value puts everything on a line: the share goes to 1. Three
    // independent hashes spread the variance across all three directions.
    // Measured 0.45 for independent noise against 0.99 for a shared value, so the
    // bar sits in a gap rather than on a slope.
    expect(share, `leading eigenvector holds ${(100 * share).toFixed(1)}% of residual variance`)
      .toBeLessThan(0.75)
  })
})
