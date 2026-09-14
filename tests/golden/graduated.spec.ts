import { expect, test } from '@playwright/test'

import { graduatedAspect, graduatedMask } from '../../src/core/colour/graduated'
import { srgbEotf } from '../../src/core/colour/transfer'

/**
 * The graduated filter's shader against the TypeScript it mirrors.
 *
 * # Why this one needs an agreement test where the date stamp did not
 *
 * The stamp's layout is computed once in TypeScript and handed over as uniforms,
 * so there is exactly one implementation of it and nothing to disagree. The
 * grad's mask is a function of position, so the shader has to evaluate it per
 * pixel — which means the maths is genuinely written twice, and step 5 of the
 * add-a-pass recipe says a shader compared only to itself measures nothing.
 *
 * # How the mask is recovered from a render
 *
 * With a tint of one, the filter is exactly `rgb * 2^(stops * mask)`. So the
 * ratio between a graded render and an ungraded one gives the mask back:
 *
 *     mask = log2(withFilter / without) / stops
 *
 * Two things make that legitimate rather than circular. The measurement never
 * touches the shader's mask function — it reads pixels and divides. And the
 * expected value comes from the TypeScript, evaluated at the same frame
 * position, so a disagreement names the geometry rather than a colour.
 *
 * # The identity display path, and the decode
 *
 * `identity` drops the tone map, the gamut compressor and the clamp, which the
 * ratio needs — a clamped render reads 1.0 on both legs and the ratio is 1
 * wherever the frame is bright. What it leaves is the matrix into display
 * primaries and the sRGB encode, so the decode is applied before dividing. The
 * matrix is linear and a ratio is blind to it; the encode is a power function
 * and a ratio is not.
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

const SOURCE = { width: 480, height: 320 }
const ASPECT = graduatedAspect([SOURCE.width, SOURCE.height])

/** Mid grey and flat: the ratio is then the filter and nothing else. */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  context.fillStyle = 'rgb(128, 128, 128)'
  context.fillRect(0, 0, source.width, source.height)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'flat.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

const OFF = {
  distortion: 0, aberration: 0, diffusionStrength: 0, vignette: 0, microcontrast: 0,
  lightLeakStrength: 0, dateStampStrength: 0,
  halationStrength: 0, grainStrength: 0, filmStrength: 0, exposure: 0, contrast: 1,
  graduatedExposure: 0,
}

/** Two stops is well clear of half-float noise and nowhere near clipping grey. */
const STOPS = -2

/**
 * Shapes chosen to exercise the geometry rather than to look like anything:
 * an unrotated grad, one past the vertical, one on a diagonal, a narrow band
 * and one placed off centre.
 */
const CASES = [
  { angle: 0, position: 0.5, width: 0.35 },
  { angle: 90, position: 0.35, width: 0.5 },
  { angle: 37, position: 0.6, width: 0.2 },
  { angle: 214, position: 0.45, width: 0.8 },
  { angle: 300, position: 0.5, width: 0.02 },
]

test.describe('the graduated filter shader agrees with its reference', () => {
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

  async function render(
    page: import('@playwright/test').Page,
    edit: Record<string, number>,
  ): Promise<number[]> {
    return page.evaluate<number[], { edit: Record<string, number>; source: typeof SOURCE }>(
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
        const target = renderer.graph.pool.acquire(source.width, source.height)
        renderer.graph.render(
          {
            ...renderer.input,
            edit: { ...renderer.input.edit, ...edit },
            view: { ...renderer.input.view, displayMode: 'identity' },
          },
          {
            resolution: [source.width, source.height] as const,
            imageSize: [source.width, source.height] as const,
            sourceRect: [0, 0, source.width, source.height] as const,
          },
          { finalTarget: target },
        )
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
        const raw = new Uint16Array(source.width * source.height * 4)
        gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.HALF_FLOAT, raw)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        renderer.graph.pool.release(target)
        const out: number[] = []
        for (let i = 0; i < source.width * source.height; i++) out.push(decodeHalf(raw[i * 4] ?? 0))
        return out
      },
      { edit, source: SOURCE },
    )
  }

  test('leaves everything outside the band bit for bit, at any strength', async ({ page }) => {
    test.setTimeout(120_000)

    /*
     * The vignette's guarantee, made by the same construction and asserted the
     * same way. `exp2(0)` is exactly 1 and `mix(vec3(1), tint, 0)` is exactly 1,
     * so a pixel the mask does not reach comes out unchanged rather than
     * nearly unchanged.
     *
     * It matters more here than it looks. A grad is normally set to act on part
     * of the frame and leave the rest alone, so "the rest" is most of the
     * picture — and a mask that approached zero asymptotically instead of
     * reaching it would put a very slight cast over all of it, at every setting,
     * for as long as the filter was enabled.
     *
     * Bit-identical is compared on the RAW half floats rather than on decoded
     * values, deliberately: a decode is monotone but not injective at this
     * precision, so two different half floats can decode to the same double and
     * a comparison after decoding would be weaker than it looks.
     */
    const raw = async (edit: Record<string, number>): Promise<number[]> =>
      page.evaluate<number[], { edit: Record<string, number>; source: typeof SOURCE }>(
        ({ edit, source }) => {
          const renderer = (window as unknown as { __photolabRenderer: RendererLike })
            .__photolabRenderer
          renderer.stop()
          const gl = renderer.context.gl
          const target = renderer.graph.pool.acquire(source.width, source.height)
          renderer.graph.render(
            {
              ...renderer.input,
              edit: { ...renderer.input.edit, ...edit },
              view: { ...renderer.input.view, displayMode: 'identity' },
            },
            {
              resolution: [source.width, source.height] as const,
              imageSize: [source.width, source.height] as const,
              sourceRect: [0, 0, source.width, source.height] as const,
            },
            { finalTarget: target },
          )
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
          const pixels = new Uint16Array(source.width * source.height * 4)
          gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.HALF_FLOAT, pixels)
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          renderer.graph.pool.release(target)
          return Array.from(pixels)
        },
        { edit, source: SOURCE },
      )

    const without = await raw(OFF)
    // A strong grad with a heavy colour shift, so nothing is hiding in a small
    // number: four stops down and two thirds of the blue absorbed.
    const shape = { graduatedAngle: 0, graduatedPosition: 0.5, graduatedWidth: 0.3 }
    const withFilter = await raw({ ...OFF, ...shape, graduatedExposure: -4 })

    /*
     * Counted and asserted once, not asserted per pixel.
     *
     * The first version called `expect` for every channel of every unmasked
     * pixel — 161,000 assertions. It passed, took six minutes, and took the
     * page down with it: the five agreement tests in this same file then failed
     * in 150ms each with the renderer gone. A slow test is not only slow; at
     * this scale it became a test that broke its neighbours.
     */
    let untouched = 0
    let changed = 0
    let moved = 0
    let firstMoved = ''
    for (let row = 0; row < SOURCE.height; row++) {
      for (let col = 0; col < SOURCE.width; col++) {
        const i = row * SOURCE.width + col
        const y = (SOURCE.height - 1 - row + 0.5) / SOURCE.height
        const x = (col + 0.5) / SOURCE.width
        const mask = graduatedMask(
          [x, y],
          ASPECT,
          shape.graduatedAngle,
          shape.graduatedPosition,
          shape.graduatedWidth,
        )
        if (mask !== 0) {
          if (withFilter[i * 4] !== without[i * 4]) changed++
          continue
        }
        untouched++
        const same =
          withFilter[i * 4] === without[i * 4] &&
          withFilter[i * 4 + 1] === without[i * 4 + 1] &&
          withFilter[i * 4 + 2] === without[i * 4 + 2]
        if (!same) {
          moved++
          if (!firstMoved) firstMoved = `(${x.toFixed(3)}, ${y.toFixed(3)})`
        }
      }
    }

    expect(
      moved,
      `${moved} of ${untouched} pixels outside the band moved, first at ${firstMoved}`,
    ).toBe(0)

    // Both counts, because either alone is satisfiable by a pass that did
    // nothing at all: the first says there was a population to be exact over,
    // the second says the filter was genuinely running while it was.
    expect(untouched, 'no pixel was outside the band').toBeGreaterThan(20_000)
    expect(changed, 'no pixel inside the band moved, so the filter did nothing').toBeGreaterThan(
      20_000,
    )
    process.stdout.write(
      `\n  ${untouched} pixels outside the band, all bit-identical; ${changed} inside it moved\n`,
    )
  })

  for (const shape of CASES) {
    test(`angle ${shape.angle}, position ${shape.position}, width ${shape.width}`, async ({
      page,
    }) => {
      test.setTimeout(120_000)

      const without = await render(page, OFF)
      const withFilter = await render(page, {
        ...OFF,
        graduatedAngle: shape.angle,
        graduatedPosition: shape.position,
        graduatedWidth: shape.width,
        graduatedExposure: STOPS,
      })

      let worst = 0
      let worstAt = ''
      let moved = 0
      let inBand = 0
      let samples = 0

      for (let row = 0; row < SOURCE.height; row += 4) {
        for (let col = 0; col < SOURCE.width; col += 4) {
          const i = row * SOURCE.width + col
          // readPixels is bottom-up; frame y runs downward.
          const y = (SOURCE.height - 1 - row + 0.5) / SOURCE.height
          const x = (col + 0.5) / SOURCE.width

          const base = srgbEotf(without[i] ?? 0)
          const lit = srgbEotf(withFilter[i] ?? 0)
          if (base <= 1e-6) continue
          samples++

          const measured = Math.log2(lit / base) / STOPS
          const expected = graduatedMask([x, y], ASPECT, shape.angle, shape.position, shape.width)

          if (Math.abs(measured - expected) > worst) {
            worst = Math.abs(measured - expected)
            worstAt = `(${x.toFixed(3)}, ${y.toFixed(3)}) measured ${measured.toFixed(4)} expected ${expected.toFixed(4)}`
          }
          if (Math.abs(measured) > 1e-3) moved++
          if (expected > 0.01 && expected < 0.99) inBand++
        }
      }

      /*
       * Non-vacuity, twice, and before the agreement is believed.
       *
       * The first is the ordinary one: the filter has to have done something.
       * The second is the one that matters here — agreement over a mask that is
       * flat 0 and flat 1 tests nothing but two constants. The TRANSITION BAND
       * has to be populated, or the geometry is not under test at all.
       */
      expect(samples, 'nothing was sampled').toBeGreaterThan(5_000)
      expect(moved, 'the filter changed no pixel').toBeGreaterThan(1_000)
      expect(
        inBand,
        'no sample landed inside the transition band, so only the flat ends were compared',
      ).toBeGreaterThan(200)

      process.stdout.write(
        `\n  angle ${shape.angle}: worst ${worst.toExponential(2)} over ${samples} samples, ` +
          `${inBand} in band\n`,
      )

      /*
       * Derived rather than tuned. The render is RGBA16F, so a mask recovered
       * through a ratio of two half floats carries about 2^-10 relative error
       * each; through `log2(·) / 2` that is roughly 7e-4 on the mask. The sRGB
       * decode is monotone and does not amplify it. 5e-3 is an order above that
       * and two orders below any geometry mistake — the diagonal-instead-of-
       * support-function error is 0.22 at some angles.
       */
      expect(worst, `worst disagreement at ${worstAt}`).toBeLessThan(5e-3)
    })
  }
})
