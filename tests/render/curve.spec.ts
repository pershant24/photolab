import { expect, test } from '@playwright/test'

import { evaluateCurve } from '../../src/core/colour/curve'
import { decodeACEScct, encodeACEScct } from '../../src/core/colour/transfer'
import { TONE_CURVE_DOMAIN, splitControlPoints } from '../../src/core/state/editState'
import { PATCHES, PATCH_COUNT, patchCentreUv } from '../../src/render/testPattern'

/**
 * The curve pass, compared against direct PCHIP evaluation rather than against
 * the lookup table it samples.
 *
 * That distinction is the point. Comparing the shader's LUT sampling against a
 * TypeScript LUT sampling would agree even if both were shifted by half a texel,
 * because both would be shifted the same way. Comparing against the spline
 * itself is what catches a wrong remap, a wrong resolution, and the half-texel
 * offset that is the classic lookup table bug — it moves the entire curve by a
 * fraction of a sample and looks completely plausible.
 */

/**
 * A pronounced S over the tone curve's real domain, so a small systematic offset
 * shows as a large value error.
 *
 * The domain starts at `encodeACEScct(0)`, not at zero, which is what makes this
 * exercise the shader's remap: with a `[0, 1]` domain the remap is the identity
 * and a shader ignoring the domain passes. That mutation was run against a unit
 * domain and did pass.
 */
const [DOMAIN_LO] = TONE_CURVE_DOMAIN
const span = 1 - DOMAIN_LO
const CONTROL_POINTS = [
  DOMAIN_LO, DOMAIN_LO,
  DOMAIN_LO + span * 0.25, DOMAIN_LO + span * 0.12,
  DOMAIN_LO + span * 0.5, DOMAIN_LO + span * 0.5,
  DOMAIN_LO + span * 0.75, DOMAIN_LO + span * 0.88,
  1, 1,
]

const UVS = Array.from({ length: PATCH_COUNT }, (_, i) => [...patchCentreUv(i)])

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
    pool: { acquire(w: number, h: number): unknown; release(t: unknown): void }
    render(input: unknown, context: unknown, options?: Record<string, unknown>): void
    passIds: string[]
  }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  input: { source: unknown; edit: Record<string, unknown>; view: Record<string, unknown> }
  curveBakeCount: number
  passContext(): unknown
  syncSize(): boolean
  renderNow(): void
  stop(): void
}

/** The value entering the curve pass, and the value leaving it. */
async function measure(
  page: import('@playwright/test').Page,
  points: number[],
): Promise<{ before: number[][]; after: number[][]; passIds: string[] }> {
  return page.evaluate<
    { before: number[][]; after: number[][]; passIds: string[] },
    { uvs: number[][]; decodeSrc: string; points: number[] }
  >(
    ({ uvs, decodeSrc, points }) => {
      const decodeHalf = eval(decodeSrc) as (h: number) => number
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.syncSize()

      const gl = renderer.context.gl
      const canvas = renderer.context.canvas
      let previous: number[][] = []
      let before: number[][] = []
      const after: number[][] = []
      const passIds: string[] = []

      const sample = (): number[][] => {
        const pixel = new Uint16Array(4)
        const out: number[][] = []
        for (const uv of uvs) {
          const x = Math.min(canvas.width - 1, Math.max(0, Math.round((uv[0] ?? 0) * canvas.width)))
          const y = Math.min(canvas.height - 1, Math.max(0, Math.round((uv[1] ?? 0) * canvas.height)))
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.HALF_FLOAT, pixel)
          out.push([decodeHalf(pixel[0] ?? 0), decodeHalf(pixel[1] ?? 0), decodeHalf(pixel[2] ?? 0)])
        }
        return out
      }

      const finalTarget = renderer.graph.pool.acquire(canvas.width, canvas.height)
      try {
        renderer.graph.render(
          {
            ...renderer.input,
            edit: { ...renderer.input.edit, toneCurve: points },
            view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
          },
          renderer.passContext(),
          {
            finalTarget,
            onPassComplete: (id: string) => {
              passIds.push(id)
              if (id === 'toneCurve') {
                before = previous
                after.push(...sample())
                return
              }
              previous = sample()
            },
          },
        )
      } finally {
        renderer.graph.pool.release(finalTarget)
      }

      return { before, after, passIds }
    },
    { uvs: UVS, decodeSrc: DECODE_HALF, points },
  )
}

const FP16_RELATIVE = 2 ** -11

test.describe('tone curve', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window && '__photolabStore' in window)
  })

  test('is skipped at the identity and runs when the curve moves', async ({ page }) => {
    const identity = await measure(page, [DOMAIN_LO, DOMAIN_LO, 1, 1])
    expect(identity.passIds).not.toContain('toneCurve')

    const shaped = await measure(page, CONTROL_POINTS)
    expect(shaped.passIds).toContain('toneCurve')
    // In the grade stage, after contrast and before display.
    expect(shaped.passIds.indexOf('toneCurve')).toBeLessThan(shaped.passIds.indexOf('display'))
  })

  test('matches direct spline evaluation, not the table it samples', async ({ page }) => {
    const { before, after } = await measure(page, CONTROL_POINTS)
    const { xs, ys } = splitControlPoints(CONTROL_POINTS)

    const failures: string[] = []
    for (let i = 0; i < PATCH_COUNT; i++) {
      const patch = PATCHES[i]
      const input = before[i]
      const output = after[i]
      if (!patch || !input || !output) {
        failures.push(`patch ${i}: missing`)
        continue
      }
      for (let c = 0; c < 3; c++) {
        const linear = input[c] ?? Number.NaN
        // The curve is applied in ACEScct, where the control points live.
        const curveOutput = evaluateCurve(xs, ys, encodeACEScct(linear))
        const expected = decodeACEScct(curveOutput)
        const got = output[c] ?? Number.NaN

        // Two terms, both derived, per SHADER_CONVENTIONS.md section 5.
        //
        // The lookup table's interpolation error is bounded by the resolution
        // derivation at 2^-13, and it lives in the curve's **output**, so the
        // decode's slope has to be evaluated there rather than at its input.
        // Getting that wrong understates the bound by a factor of two at the top
        // of the range, because the decode is exponential and its slope is
        // proportional to the value it produces — which is exactly the "carry
        // the bound across the nonlinearity by its local slope" step, applied at
        // the wrong point.
        const slope =
          Math.abs(decodeACEScct(curveOutput + 1e-5) - decodeACEScct(curveOutput - 1e-5)) / 2e-5
        const bound = 2 * (slope * 2 ** -13 + FP16_RELATIVE * Math.abs(expected)) + 1e-4

        if (!(Math.abs(got - expected) <= bound)) {
          failures.push(
            `patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: ` +
              `in ${linear.toFixed(5)}, expected ${expected.toFixed(6)}, got ${got.toFixed(6)}, ` +
              `delta ${(got - expected).toExponential(2)}, bound ${bound.toExponential(2)}`,
          )
        }
      }
    }
    expect(failures.slice(0, 10).join('\n')).toBe('')
  })

  test('rebakes once per control point change, never per frame', async ({ page }) => {
    // The constraint that makes the whole exception affordable. A rebake per
    // frame would put a variable-length loop over control points, and a throwing
    // bounds check, on the hot path.
    const counts = await page.evaluate<
      { afterFirst: number; afterFrames: number; afterChange: number; afterOtherParam: number },
      number[]
    >((points) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      const store = (window as unknown as {
        __photolabStore: { getState(): { setParameter(k: string, v: number): void; applyPatch(p: unknown): void } }
      }).__photolabStore
      renderer.stop()

      store.getState().applyPatch({ toneCurve: points })
      renderer.renderNow()
      const afterFirst = renderer.curveBakeCount

      // Sixty frames with nothing changing.
      for (let i = 0; i < 60; i++) renderer.renderNow()
      const afterFrames = renderer.curveBakeCount

      // One control point moved.
      const moved = [...points]
      moved[3] = (moved[3] ?? 0) + 0.08
      store.getState().applyPatch({ toneCurve: moved })
      renderer.renderNow()
      renderer.renderNow()
      const afterChange = renderer.curveBakeCount

      // An unrelated parameter moved, sixty times.
      for (let i = 0; i < 60; i++) {
        store.getState().setParameter('exposure', -2 + i / 30)
        renderer.renderNow()
      }
      const afterOtherParam = renderer.curveBakeCount

      return { afterFirst, afterFrames, afterChange, afterOtherParam }
    }, CONTROL_POINTS)

    expect(counts.afterFirst, 'one bake for the first use').toBe(1)
    expect(counts.afterFrames, '60 frames with no change must not rebake').toBe(1)
    expect(counts.afterChange, 'moving a control point rebakes exactly once').toBe(2)
    expect(counts.afterOtherParam, 'an unrelated parameter must not rebake').toBe(2)
  })
})
