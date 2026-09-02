import { expect, test } from '@playwright/test'

import { applyWheelsEncoded } from '../../src/core/colour/wheels'
import { encodeACEScct, decodeACEScct, srgbEotf, srgbOetf } from '../../src/core/colour/transfer'
import { ACESCG_TO_SRGB, SRGB_TO_ACESCG } from '../../src/core/colour/matrices'
import { mat3MulVec3 } from '../../src/core/colour/types'

/**
 * The wheels shader against the TypeScript reference, and the identity.
 *
 * # The readback is display-encoded, and reading it as linear is a trap
 *
 * `displayMode: 'identity'` skips the tone map and the gamut compression; it does
 * **not** skip the primaries matrix or the transfer function, because the
 * round-trip test it exists for needs sRGB in to equal sRGB out. So a readback is
 * sRGB-encoded in display primaries, and treating it as a linear ACEScg value
 * gives an error of 800% at the bottom of the ramp.
 *
 * This is the second time that trap has been walked into — the grain amplitude
 * profile hit it first, where it moved an apparent peak by 1.3 stops and looked
 * like a plausible answer. Here it does not look plausible, which is luck rather
 * than diligence.
 *
 * The reference therefore makes the same round trip the shader does: linearise,
 * matrix into ACEScg, apply the wheels, matrix back, re-encode. Comparing in the
 * space the values are actually in rather than in the one they came from.
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

const SOURCE = { width: 256, height: 256 }

/** A vertical ramp: each row is one exposure, covering toe to shoulder. */
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

const OFF = { halationStrength: 0, grainStrength: 0, filmStrength: 0, exposure: 0, contrast: 1 }

test.describe('colour wheels', () => {
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

  /** The red channel of the middle column, row by row, in linear ACEScg. */
  async function column(
    page: import('@playwright/test').Page,
    edit: Record<string, unknown>,
  ): Promise<number[]> {
    return page.evaluate<number[], { edit: Record<string, unknown>; source: { width: number; height: number } }>(
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
        const { width, height } = source
        const target = renderer.graph.pool.acquire(width, height)
        renderer.graph.render(
          {
            ...renderer.input,
            edit: { ...renderer.input.edit, ...edit },
            // Identity display: the comparison is against a working-space
            // reference, so the primaries matrix and the transfer function would
            // both have to be undone to compare anything through them.
            view: { ...renderer.input.view, displayMode: 'identity', toneMap: false, gamutCompress: false },
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
        const out: number[] = []
        for (let y = 0; y < height; y++) out.push(decodeHalf(raw[(y * width + width / 2) * 4] ?? 0))
        return out
      },
      { edit, source: SOURCE },
    )
  }

  test('is an exact identity at zero', async ({ page }) => {
    // Bit-identical, not close. Anything else alters every unedited photograph,
    // and the pass is skipped entirely at the identity so this also confirms the
    // `enabled` predicate agrees with the maths.
    const before = await column(page, OFF)
    const after = await column(page, { ...OFF, lift: [0, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0] })
    expect(after).toEqual(before)
  })

  test('matches the TypeScript reference across the range', async ({ page }) => {
    const LIFT = 0.03
    const GAMMA = -0.02
    const GAIN = 0.045
    const before = await column(page, OFF)
    const after = await column(page, {
      ...OFF,
      lift: [LIFT, 0, 0],
      gamma: [GAMMA, 0, 0],
      gain: [GAIN, 0, 0],
    })

    let worst = 0
    let worstAt = 0
    let compared = 0
    for (let i = 0; i < before.length; i++) {
      const encodedIn = before[i] ?? 0
      // Skip the very bottom, where half-float quantisation dominates.
      if (encodedIn < 1e-2) continue
      // The source is neutral, so the readback is one component of a neutral
      // triple and the whole triple can be reconstructed from it.
      const linearSrgb = srgbEotf(encodedIn)
      const acescg = mat3MulVec3(SRGB_TO_ACESCG, [linearSrgb, linearSrgb, linearSrgb])
      const graded: [number, number, number] = [
        decodeACEScct(applyWheelsEncoded(encodeACEScct(acescg[0]), LIFT, GAMMA, GAIN)),
        decodeACEScct(applyWheelsEncoded(encodeACEScct(acescg[1]), 0, 0, 0)),
        decodeACEScct(applyWheelsEncoded(encodeACEScct(acescg[2]), 0, 0, 0)),
      ]
      const expected = srgbOetf(mat3MulVec3(ACESCG_TO_SRGB, graded)[0])
      const measured = after[i] ?? 0
      // Relative, because the values span three orders of magnitude and an
      // absolute bound would be meaningless at one end or the other.
      const error = Math.abs(measured - expected) / Math.max(expected, 1e-3)
      if (error > worst) { worst = error; worstAt = encodedIn }
      compared++
    }

    expect(compared).toBeGreaterThan(100)
    // Half float carries about 11 bits, and the value passes through an encode,
    // three weighted adds and a decode. 2^-9 is four times that floor.
    expect(worst, `worst relative error ${worst.toExponential(2)} at linear ${worstAt.toExponential(2)}`)
      .toBeLessThan(2 ** -9)
  })

  test('puts each wheel where its name says', async ({ page }) => {
    // The end-to-end version of the zone test: a lift-only move must change the
    // shadows more than the highlights, measured on a real render rather than on
    // the weight function.
    const before = await column(page, OFF)
    const lifted = await column(page, { ...OFF, lift: [0.05, 0.05, 0.05] })
    const gained = await column(page, { ...OFF, gain: [0.05, 0.05, 0.05] })

    // Selected by measured brightness rather than by row index. `readPixels` is
    // bottom-up, so the ramp arrives inverted and a "highlight" range chosen by
    // index is the shadows — which showed up as a comparison against nothing,
    // because every one of those rows was below the skip threshold.
    const meanChange = (after: number[], lo: number, hi: number): number => {
      let sum = 0
      let n = 0
      for (let i = 0; i < before.length; i++) {
        const b = before[i] ?? 0
        if (b < lo || b > hi) continue
        sum += ((after[i] ?? 0) - b) / b
        n++
      }
      expect(n, `no samples between ${lo} and ${hi}`).toBeGreaterThan(4)
      return sum / n
    }

    const SHADOW: [number, number] = [0.05, 0.2]
    const HIGHLIGHT: [number, number] = [0.7, 0.95]

    expect(meanChange(lifted, ...SHADOW)).toBeGreaterThan(meanChange(lifted, ...HIGHLIGHT))
    expect(meanChange(gained, ...HIGHLIGHT)).toBeGreaterThan(meanChange(gained, ...SHADOW))
  })
})
