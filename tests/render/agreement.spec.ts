import { expect, test } from '@playwright/test'

import { ACESCG_TO_SRGB, SRGB_TO_ACESCG } from '../../src/core/colour/matrices'
import { srgbEotf, srgbOetf } from '../../src/core/colour/transfer'
import { mat3MulVec3 } from '../../src/core/colour/types'
import type { Vec3 } from '../../src/core/colour/types'
import {
  OUT_OF_GAMUT_PATCH_INDICES,
  PATCHES,
  PATCH_COUNT,
  patchCentreUv,
} from '../../src/render/testPattern'

/**
 * The shader compared against the pure TypeScript reference in
 * `src/core/colour/`, never against a previous render of itself. The reference
 * runs in Node, the shader runs in the browser, and only numbers cross between
 * them.
 *
 * # Why this is two legs and not one end-to-end check
 *
 * The chain applies `SRGB_TO_ACESCG` at ingest and `ACESCG_TO_SRGB` at display.
 * Comparing the final image against the original input therefore measures a
 * **round trip**, and a round trip cannot see the most likely defect at all.
 *
 * Both GLSL matrix literals come from one generator, so the realistic mistake is
 * a single convention error affecting both — GLSL's `mat3()` fills columns while
 * the TypeScript stores rows, and getting that backwards transposes each. But
 * `Mᵀ · (M⁻¹)ᵀ = (M⁻¹ · M)ᵀ = I`, so the round trip is **exactly** the identity.
 * Measured at 4.4e-16 deviation and **zero** code values of movement on the
 * canvas. Not approximately invisible: algebraically invisible, at any tolerance.
 *
 * So the chain is split, and each leg's expectation comes from what was actually
 * measured at the previous stage rather than from the original input:
 *
 * - **Leg 1** compares the measured ACEScg intermediate against
 *   `TS_ingest(encoded_in)`. This pins `SRGB_TO_ACESCG`.
 * - **Leg 2** compares the measured display output against
 *   `TS_display(acescg_measured)`. This pins `ACESCG_TO_SRGB`.
 *
 * Passing the original input to leg 2 instead of the measured intermediate would
 * reconstitute the round trip and give the cancellation straight back.
 *
 * # Two measured facts that shaped the design
 *
 * **Reading the canvas is not good enough for leg 2.** 8-bit output quantises at
 * 1/255 = 3.9e-3, and a 0.1% error in a display coefficient falls under that on
 * most patches. Leg 2 therefore renders the display pass into a half-float
 * target via `RenderOptions.finalTarget` — the same primitive tiled export will
 * use — which resolves 4.9e-4, about eight times finer.
 *
 * **Restricting leg 2 to in-gamut midtones would have cost an order of
 * magnitude.** It is the obvious way to avoid the clamp eating the signal, and
 * it is the wrong one: a display-matrix error shows up most strongly on
 * saturated patches, where a channel sits near zero and the encoding curve is at
 * its steepest. Measured on midtones only, a 1% error moved the result by 2 code
 * values and a 0.1% error by **none**; across all patches the same errors moved
 * it by 19 and 2. So leg 2 keeps every patch and skips only the individual
 * *channels* whose expected value clamps — which is decidable from the measured
 * intermediate, so it is a principled exclusion rather than a tuned one.
 */

const UVS = Array.from({ length: PATCH_COUNT }, (_, i) => [...patchCentreUv(i)])

/** Half float has an 11-bit significand, so relative precision is 2^-11. */
const FP16_RELATIVE = 2 ** -11

/**
 * The half-float noise floor for a matrix row, derived from the terms that make
 * up the result rather than from the result itself.
 *
 * Bounding it by the result alone is wrong for a channel that **cancels**, and
 * one of the out-of-gamut patches does exactly that: its red channel is the sum
 * of terms of magnitude 0.25 that come to zero. Each term carries its own fp16
 * quantisation error, those errors add rather than cancelling with the terms, and
 * the residual is 2.8e-4 against an expected value of exactly 0. A bound
 * proportional to the expected value is zero there, and no absolute floor chosen
 * without looking at the terms is defensible.
 *
 * So the scale is the sum of the absolute contributions, which is the standard
 * error-propagation bound for a dot product, and the result's own magnitude for
 * the case where it dominates.
 */
function rowTolerance(expected: number, contributions: readonly number[]): number {
  const scale = Math.max(
    Math.abs(expected),
    contributions.reduce((total, term) => total + Math.abs(term), 0),
  )
  // Twice the relative precision, for headroom over SwiftShader's fp32 rounding
  // and its `pow` differing slightly from JavaScript's.
  return 2 * FP16_RELATIVE * scale + 5e-6
}

/** The per-term contributions to row `row` of `matrix * vector`. */
function contributions(matrix: readonly number[], row: number, vector: Vec3): number[] {
  return [0, 1, 2].map((k) => (matrix[row * 3 + k] ?? 0) * (vector[k] ?? 0))
}

/**
 * `d(encoded)/d(linear)` for the sRGB OETF, so a tolerance derived in linear
 * light can be carried across the encode. The curve is steep near black — slope
 * 12.92 on the linear segment — so a bound that ignored it would be far too
 * tight there and far too loose near white.
 */
function encodeSlope(linear: number): number {
  const magnitude = Math.abs(linear)
  if (magnitude <= 0.0031308) return 12.92
  return (1.055 / 2.4) * Math.pow(magnitude, 1 / 2.4 - 1)
}

const linearise = (patch: Vec3): Vec3 => [srgbEotf(patch[0]), srgbEotf(patch[1]), srgbEotf(patch[2])]

/** What ingest must produce. */
const tsIngest = (patch: Vec3): Vec3 => mat3MulVec3(SRGB_TO_ACESCG, linearise(patch))

/** What display must produce from a given ACEScg value: matrix, clamp, encode. */
function tsDisplay(acescg: Vec3): Vec3 {
  const back = mat3MulVec3(ACESCG_TO_SRGB, acescg)
  const clamped: Vec3 = [
    Math.min(1, Math.max(0, back[0])),
    Math.min(1, Math.max(0, back[1])),
    Math.min(1, Math.max(0, back[2])),
  ]
  return [srgbOetf(clamped[0]), srgbOetf(clamped[1]), srgbOetf(clamped[2])]
}

/** Whether the display transform clamps this channel, from the measured ACEScg. */
function clampsChannel(acescg: Vec3, channel: number): boolean {
  const back = mat3MulVec3(ACESCG_TO_SRGB, acescg)[channel] ?? 0
  // A margin, so a channel sitting a hair inside the boundary is excluded too:
  // the shader and the reference could land either side of it.
  return back <= 1e-3 || back >= 1 - 1e-3
}

const DECODE_HALF = `(h) => {
  const sign = (h & 0x8000) ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x03ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
}`

interface RendererLike {
  graph: {
    passIds: string[]
    pool: { acquire(w: number, h: number): { framebuffer: unknown; width: number; height: number }; release(t: unknown): void }
    render(
      input: unknown,
      context: unknown,
      options?: {
        onPassComplete?: (id: string, target: unknown) => void
        finalTarget?: unknown
      },
    ): void
  }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  input: unknown
  source: { kind: string }
  passContext(): unknown
  syncSize(available?: { width: number; height: number }): boolean
  renderNow(available?: { width: number; height: number }): void
  stop(): void
}

/** Both legs measured from one render, so leg 2's input is genuinely leg 1's output. */
interface Legs {
  acescg: number[][]
  displayed: number[][]
}

async function measureBothLegs(page: import('@playwright/test').Page): Promise<Legs> {
  return page.evaluate<Legs, { uvs: number[][]; decodeSrc: string }>(
    ({ uvs, decodeSrc }) => {
      const decodeHalf = eval(decodeSrc) as (h: number) => number
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.syncSize()

      const gl = renderer.context.gl
      const canvas = renderer.context.canvas
      const acescg: number[][] = []
      const displayed: number[][] = []

      const sampleAt = (into: number[][]): void => {
        const pixel = new Uint16Array(4)
        for (const uv of uvs) {
          const x = Math.min(canvas.width - 1, Math.max(0, Math.round((uv[0] ?? 0) * canvas.width)))
          const y = Math.min(canvas.height - 1, Math.max(0, Math.round((uv[1] ?? 0) * canvas.height)))
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.HALF_FLOAT, pixel)
          into.push([decodeHalf(pixel[0] ?? 0), decodeHalf(pixel[1] ?? 0), decodeHalf(pixel[2] ?? 0)])
        }
      }

      // The display pass writes into a pooled half-float target rather than the
      // canvas, so leg 2 is not limited by 8-bit quantisation.
      const finalTarget = renderer.graph.pool.acquire(canvas.width, canvas.height)
      try {
        renderer.graph.render(
          renderer.input,
          renderer.passContext(),
          {
            finalTarget,
            // Fires while each pass's target is still bound, which is the only
            // moment its contents can be read.
            onPassComplete: (id) => {
              if (id === 'ingest') sampleAt(acescg)
              else if (id === 'display') sampleAt(displayed)
            },
          },
        )
      } finally {
        renderer.graph.pool.release(finalTarget)
      }

      return { acescg, displayed }
    },
    { uvs: UVS, decodeSrc: DECODE_HALF },
  )
}

test.describe('shader and reference agreement', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
  })

  test('leg 1: ingest produces the ACEScg the reference computes', async ({ page }) => {
    const { acescg } = await measureBothLegs(page)
    expect(acescg).toHaveLength(PATCH_COUNT)

    const failures: string[] = []
    for (let i = 0; i < PATCH_COUNT; i++) {
      const patch = PATCHES[i]
      const actual = acescg[i]
      if (!patch || !actual) {
        failures.push(`patch ${i}: missing`)
        continue
      }
      const linear = linearise(patch.encoded)
      const expected = tsIngest(patch.encoded)
      for (let c = 0; c < 3; c++) {
        const got = actual[c] ?? Number.NaN
        const want = expected[c] ?? Number.NaN
        if (!(Math.abs(got - want) <= rowTolerance(want, contributions(SRGB_TO_ACESCG, c, linear)))) {
          failures.push(
            `patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: ` +
              `expected ${want.toFixed(6)}, got ${got.toFixed(6)}, ` +
              `delta ${(got - want).toExponential(2)}`,
          )
        }
      }
    }
    expect(failures.join('\n')).toBe('')
  })

  test('leg 2: display produces what the reference computes from the measured ACEScg', async ({
    page,
  }) => {
    const { acescg, displayed } = await measureBothLegs(page)

    const failures: string[] = []
    let compared = 0
    for (let i = 0; i < PATCH_COUNT; i++) {
      const patch = PATCHES[i]
      const measured = acescg[i]
      const actual = displayed[i]
      if (!patch || !measured || !actual) {
        failures.push(`patch ${i}: missing`)
        continue
      }
      // The measured intermediate is the input, not the patch's sRGB value.
      // Using the latter would reconstitute the round trip this test exists to
      // avoid.
      const measuredVec = measured as unknown as Vec3
      const expected = tsDisplay(measuredVec)

      for (let c = 0; c < 3; c++) {
        if (clampsChannel(measuredVec, c)) continue
        compared++
        const got = actual[c] ?? Number.NaN
        const want = expected[c] ?? Number.NaN
        // The encode curve maps the linear result to the stored value, so the
        // tolerance is derived on the linear side and carried through its slope.
        const backLinear = mat3MulVec3(ACESCG_TO_SRGB, measuredVec)[c] ?? 0
        const linearTolerance = rowTolerance(
          backLinear,
          contributions(ACESCG_TO_SRGB, c, measuredVec),
        )
        const slope = encodeSlope(backLinear)
        if (!(Math.abs(got - want) <= linearTolerance * slope + 5e-6)) {
          failures.push(
            `patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: ` +
              `expected ${want.toFixed(6)}, got ${got.toFixed(6)}, ` +
              `delta ${(got - want).toExponential(2)}`,
          )
        }
      }
    }

    // A clamp-detection bug that excluded everything would otherwise leave this
    // test green while asserting nothing.
    expect(compared, 'unclamped channels available to compare').toBeGreaterThan(30)
    expect(failures.join('\n')).toBe('')
  })

  test('the display transform clamps out-of-gamut values rather than producing garbage', async ({
    page,
  }) => {
    // AP1 encloses Rec.709, so no sRGB input can produce an out-of-gamut ACEScg
    // value; these patches are synthesised backwards from the ACEScg they should
    // become. Negatives arrive for real once white balance and the film curves
    // land, so the display path's behaviour on them is pinned now rather than
    // discovered then.
    const { acescg } = await measureBothLegs(page)
    const canvas = await page.evaluate<number[][], { uvs: number[][] }>(({ uvs }) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.renderNow()
      const gl = renderer.context.gl
      const element = renderer.context.canvas
      const pixel = new Uint8Array(4)
      const out: number[][] = []
      for (const uv of uvs) {
        const x = Math.min(element.width - 1, Math.max(0, Math.round((uv[0] ?? 0) * element.width)))
        const y = Math.min(element.height - 1, Math.max(0, Math.round((uv[1] ?? 0) * element.height)))
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        out.push([pixel[0] ?? -1, pixel[1] ?? -1, pixel[2] ?? -1])
      }
      return out
    }, { uvs: UVS })

    expect(OUT_OF_GAMUT_PATCH_INDICES.length).toBeGreaterThanOrEqual(4)

    let sawNegative = false
    let sawAboveOne = false
    const failures: string[] = []

    for (const i of OUT_OF_GAMUT_PATCH_INDICES) {
      const patch = PATCHES[i]
      const measured = acescg[i]
      const shown = canvas[i]
      if (!patch || !measured || !shown) {
        failures.push(`patch ${i}: missing`)
        continue
      }
      const back = mat3MulVec3(ACESCG_TO_SRGB, measured as unknown as Vec3)
      for (let c = 0; c < 3; c++) {
        const linear = back[c] ?? 0
        const byte = shown[c] ?? -1
        if (linear < -1e-3) {
          sawNegative = true
          // Clamped to black, not wrapped, and not NaN rendered as noise.
          if (byte !== 0) {
            failures.push(
              `patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: linear ${linear.toFixed(4)} ` +
                `is negative and must clamp to 0, got ${byte}`,
            )
          }
        } else if (linear > 1 + 1e-3) {
          sawAboveOne = true
          if (byte !== 255) {
            failures.push(
              `patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: linear ${linear.toFixed(4)} ` +
                `is above 1 and must clamp to 255, got ${byte}`,
            )
          }
        }
      }
    }

    expect(sawNegative, 'the patch set must contain a negative channel').toBe(true)
    expect(sawAboveOne, 'the patch set must contain a value above 1.0').toBe(true)
    expect(failures.join('\n')).toBe('')
  })

  test('the canvas covers the clamp and the encode, not the matrices', async ({ page }) => {
    // Deliberately named for what it covers. This assertion compares the canvas
    // against an expectation derived from the original sRGB input, which makes it
    // an end-to-end round trip — and a round trip is exactly identity under a
    // consistent transpose of both matrices, and moves by at most one code value
    // under a 1% error in the ingest matrix. It is close to vacuous for matrix
    // correctness, and legs 1 and 2 above are what cover that. What it does cover,
    // and nothing else does: that the two passes compose, that the clamp runs,
    // and that the 8-bit encode lands where it should.
    const bytes = await page.evaluate<number[][], { uvs: number[][] }>(({ uvs }) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.renderNow()
      const gl = renderer.context.gl
      const element = renderer.context.canvas
      const pixel = new Uint8Array(4)
      const out: number[][] = []
      for (const uv of uvs) {
        const x = Math.min(element.width - 1, Math.max(0, Math.round((uv[0] ?? 0) * element.width)))
        const y = Math.min(element.height - 1, Math.max(0, Math.round((uv[1] ?? 0) * element.height)))
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        out.push([pixel[0] ?? -1, pixel[1] ?? -1, pixel[2] ?? -1])
      }
      return out
    }, { uvs: UVS })

    const failures: string[] = []
    for (let i = 0; i < PATCH_COUNT; i++) {
      const patch = PATCHES[i]
      const actual = bytes[i]
      if (!patch || !actual) continue
      const expected = tsDisplay(tsIngest(patch.encoded)).map((v) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255),
      )
      for (let c = 0; c < 3; c++) {
        const got = actual[c] ?? -1
        const want = expected[c] ?? -1
        // One code value of rounding either side, plus one for SwiftShader's
        // fp32 rounding, which differs between the LLVM backend used locally and
        // the Subzero backend used in CI.
        if (Math.abs(got - want) > 2) {
          failures.push(
            `patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: expected ${want}, got ${got}`,
          )
        }
      }
    }
    expect(failures.join('\n')).toBe('')
  })
})
