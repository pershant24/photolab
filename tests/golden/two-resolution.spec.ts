import { expect, test } from '@playwright/test'

/**
 * The two-resolution invariant, referenced in `CLAUDE.md` §4 and
 * `docs/SHADER_CONVENTIONS.md` §2 since Stage 1 and marked as not yet existing
 * until now.
 *
 * The rule it enforces: **every spatial parameter is normalised against image
 * dimensions**, so the same `EditState` produces the same picture at any buffer
 * resolution. Halation is the first pass with a spatial kernel, and therefore
 * the first place this can fail. It is also the exact failure the rule was
 * written for — a radius expressed against `uResolution` looks perfect in
 * preview and comes out the wrong size on export, where nobody is watching.
 *
 * ## Why this is not a golden *image* test
 *
 * The directory is `tests/golden/` because that is where the docs said this
 * would live. It compares two live renders rather than a render against a
 * committed reference, which is deliberate: a committed image would have to be
 * regenerated on every Playwright bump and would fail across the two SwiftShader
 * backends for reasons unrelated to any change. Two renders on the same machine
 * in the same run have neither problem, and the property under test is agreement
 * between them rather than agreement with a stored picture.
 */

interface RendererLike {
  graph: {
    pool: {
      acquire(w: number, h: number): { framebuffer: unknown; width: number; height: number }
      release(t: unknown): void
    }
    render(input: unknown, context: unknown, options?: Record<string, unknown>): void
  }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  input: { source: unknown; edit: Record<string, unknown>; view: Record<string, unknown> }
  stop(): void
}

/** A source big enough that a proxy and a "full" render differ meaningfully. */
const SOURCE = { width: 2400, height: 1600 }

/** Halation on, at a radius that is clearly visible. */
// Pinned, deliberately, rather than inherited from DEFAULT_EDIT_STATE.
//
// The tolerance below is derived assuming there is a blurred halo to compare. A
// shipping default raised above this synthetic source's peak would drive the
// measured disagreement to zero and make this test pass trivially — a test that
// passes because the effect is off is worse than no test. See tests/README.md.
const EDIT = { halationStrength: 0.8, halationThreshold: 1.2, halationRadius: 0.012 }

test.describe('the two-resolution invariant', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)

    // A frame with a small, very bright source against a dark ground: the case
    // halation exists for, and the one where a wrong radius is obvious.
    //
    // The bright source is a SMOOTH radial falloff rather than a hard-edged
    // disc, and that is not cosmetic. A hard edge sampled at two resolutions
    // differs by more than the kernel does: the source texture has no mipmaps,
    // so a render at a quarter of the proxy's resolution undersamples it and
    // aliases along the edge. Measured with a hard disc, eleven of 2304 samples
    // disagreed by up to 9e-2, all of them on the rim — which is source aliasing,
    // not the radius being wrong, and it would have made this test measure the
    // wrong thing. A smooth source isolates the kernel geometry, which is the
    // property under test.
    await page.evaluate<void, { width: number; height: number }>(async ({ width, height }) => {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      // A true Gaussian, written per pixel rather than approximated with colour
      // stops. A gradient's stops meet with a discontinuity in slope, and at the
      // peak that produces a FIRST-order sampling difference between the two
      // resolutions rather than the second-order one the tolerance is derived
      // for — measured at 5.3e-2 against a bound of 3.7e-2, all three failures
      // on the brightest samples. The field being compared has to be as smooth
      // as the derivation assumes.
      const image = context.createImageData(width, height)
      const cx = width * 0.5
      const cy = height * 0.5
      const sigma = Math.min(width, height) * 0.09
      const twoSigmaSquared = 2 * sigma * sigma
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const dx = x - cx
          const dy = y - cy
          const intensity = Math.exp(-(dx * dx + dy * dy) / twoSigmaSquared)
          const value = Math.round(16 + 239 * intensity)
          const i = (y * width + x) * 4
          image.data[i] = value
          image.data[i + 1] = value
          image.data[i + 2] = value
          image.data[i + 3] = 255
        }
      }
      context.putImageData(image, 0, 0)

      const blob = await canvas.convertToBlob({ type: 'image/png' })
      const file = new File([blob], 'lamp.png', { type: 'image/png' })
      const input = document.querySelector<HTMLInputElement>('[data-testid="image-input"]')
      if (!input) throw new Error('no file input')
      const transfer = new DataTransfer()
      transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, SOURCE)

    await expect(page.getByTestId('image-label')).toContainText(
      `${SOURCE.width}x${SOURCE.height}`,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(200)
  })

  test('renders the same picture at two buffer resolutions', async ({ page }) => {
    const result = await page.evaluate<
      { high: number[]; low: number[]; highSize: number[]; lowSize: number[] },
      { edit: Record<string, number>; source: { width: number; height: number } }
    >(({ edit, source }) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      const gl = renderer.context.gl

      /**
       * Render into a buffer of the given size, then resample to a common grid.
       *
       * Sampled on a coarse grid rather than compared pixel for pixel: the two
       * renders have different pixel counts, so any comparison is a resampling,
       * and a coarse one avoids conflating the interpolation with the effect.
       */
      const GRID = 48
      const renderAt = (width: number, height: number): number[] => {
        const target = renderer.graph.pool.acquire(width, height)
        const context = {
          resolution: [width, height] as const,
          imageSize: [source.width, source.height] as const,
          sourceRect: [0, 0, source.width, source.height] as const,
        }
        renderer.graph.render(
          {
            ...renderer.input,
            edit: { ...renderer.input.edit, ...edit },
            view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
          },
          context,
          { finalTarget: target },
        )

        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
        const pixel = new Uint16Array(4)
        const decodeHalf = (h: number): number => {
          const sign = h & 0x8000 ? -1 : 1
          const exponent = (h >> 10) & 0x1f
          const fraction = h & 0x3ff
          if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
          if (exponent === 31) return fraction ? NaN : sign * Infinity
          return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
        }
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

      // A two-to-one ratio, which is what the drag proxy actually does. Larger
      // ratios undersample the source texture itself and stop measuring the
      // kernel.
      const highSize = [1200, 800]
      const lowSize = [600, 400]
      return {
        high: renderAt(highSize[0] ?? 0, highSize[1] ?? 0),
        low: renderAt(lowSize[0] ?? 0, lowSize[1] ?? 0),
        highSize,
        lowSize,
      }
    }, { edit: EDIT, source: SOURCE })

    expect(result.high.length).toBe(result.low.length)

    // The comparison must be measuring something: with halation off, or with a
    // radius of zero, the two renders would agree trivially.
    const spread = Math.max(...result.high) - Math.min(...result.high)
    expect(spread, 'the frame must contain a halo to compare').toBeGreaterThan(0.05)

    /**
     * Derived, not tuned.
     *
     * The two renders sample the same continuous blurred field at different
     * rates. For a smooth field the error of such a sampling is **second order**
     * in the ratio of the sample spacing to the field's characteristic length —
     * here one coarse texel against the blur radius, both measured as a fraction
     * of the image's long edge:
     *
     *     relative error ~ (texel / radius)^2
     *
     * At 600 pixels across and a radius of 0.012 that is (1/600 / 0.012)^2 =
     * 0.019, which predicted the largest observed disagreement of 2.05e-2
     * against a frame spread of about 1.0 before it was measured.
     *
     * Scaled by the frame's own dynamic range rather than stated absolutely, so
     * the bound does not depend on how bright the test image happens to be, and
     * doubled for headroom per SHADER_CONVENTIONS.md section 5. Half-float
     * storage adds its own floor on top.
     */
    const coarseTexel = 1 / (result.lowSize[0] ?? 1)
    const samplingRatio = coarseTexel / EDIT.halationRadius
    const tolerance = 2 * samplingRatio * samplingRatio * spread + 2 ** -11

    const failures: string[] = []
    for (let i = 0; i < result.high.length; i++) {
      const a = result.high[i] ?? Number.NaN
      const b = result.low[i] ?? Number.NaN
      if (Math.abs(a - b) > tolerance) {
        failures.push(
          `sample ${i} (${i % 48}, ${Math.floor(i / 48)}): ` +
            `${result.highSize.join('x')} gave ${a.toFixed(5)}, ` +
            `${result.lowSize.join('x')} gave ${b.toFixed(5)}, ` +
            `delta ${(a - b).toExponential(2)} against ${tolerance.toExponential(2)}`,
        )
      }
    }

    expect(
      `${failures.length} of ${result.high.length} samples disagree\n${failures.slice(0, 6).join('\n')}`,
    ).toBe(`0 of ${result.high.length} samples disagree\n`)
  })
})
