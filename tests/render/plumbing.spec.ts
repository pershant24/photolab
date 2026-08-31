import { expect, test } from '@playwright/test'

import { ACESCG_TO_SRGB, SRGB_TO_ACESCG } from '../../src/core/colour/matrices'
import { srgbEotf, srgbOetf } from '../../src/core/colour/transfer'
import { mat3MulVec3 } from '../../src/core/colour/types'
import type { Vec3 } from '../../src/core/colour/types'
import { PATCH_COLOURS, PATCH_COUNT, patchCentreUv } from '../../src/render/testPattern'

/**
 * The shader is compared against the pure TypeScript reference, never against a
 * previous render of itself. The reference runs here in Node, the shader runs in
 * the browser, and only read-back numbers cross between them.
 *
 * ## Why the important assertion reads an intermediate buffer
 *
 * The obvious test — render to the canvas and check the pixels — is far weaker
 * than it looks, and this was measured rather than assumed. The chain applies
 * `SRGB_TO_ACESCG` and then `ACESCG_TO_SRGB`, so it is a round trip and an error
 * in either matrix very largely cancels. Perturbing one forward coefficient by
 * 1% moved the canvas by **at most one 8-bit code value**, and by nothing at all
 * on every saturated patch, because the display clamp removes the residual
 * exactly where it is largest. The canvas test passed the mutation.
 *
 * The same 1% error moves the ACEScg intermediate by 0.0093, about nineteen
 * times the half-float noise floor. So the matrices are pinned by reading the
 * ingest pass's output directly, in half float, before the display transform
 * gets a chance to undo it.
 *
 * The canvas test is kept, because it covers the display pass, the clamp and the
 * encode, which the intermediate test does not reach. Neither is redundant.
 */

const UVS = Array.from({ length: PATCH_COUNT }, (_, i) => [...patchCentreUv(i)])

/** Half float has an 11-bit significand, so relative precision is 2^-11. */
const FP16_RELATIVE = 2 ** -11

/**
 * Tolerance on an ACEScg value read back as half float, derived rather than
 * raised until green: twice the fp16 relative precision for headroom over
 * SwiftShader's fp32 rounding, plus a small absolute floor for channels that
 * cancel to near zero, where a relative bound means nothing.
 *
 * At a typical value of 0.6 this is 1.3e-3, against a measured 9.3e-3 signal
 * from a 1% coefficient error — so the smallest coefficient error this catches
 * is well under a tenth of a percent.
 */
function acescgTolerance(expected: number): number {
  return 2 * FP16_RELATIVE * Math.abs(expected) + 1e-4
}

function linearise(patch: Vec3): Vec3 {
  return [srgbEotf(patch[0]), srgbEotf(patch[1]), srgbEotf(patch[2])]
}

/** What the ingest pass must produce: linear ACEScg. */
function expectedAcescg(patch: Vec3): Vec3 {
  return mat3MulVec3(SRGB_TO_ACESCG, linearise(patch))
}

/** What the canvas must show: back to sRGB primaries, clamped, encoded. */
function expectedCanvasBytes(patch: Vec3): number[] {
  const back = mat3MulVec3(ACESCG_TO_SRGB, expectedAcescg(patch))
  const clamped = back.map((v) => Math.min(1, Math.max(0, v)))
  return clamped.map((v) => Math.round(Math.min(1, Math.max(0, srgbOetf(v))) * 255))
}

/** Serialised into the page; IEEE 754 binary16 to a JavaScript number. */
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
    compileCount: number
    allocationCount: number
    passIds: string[]
    render(
      state: { displayMode: string; patternPhase: number },
      context: unknown,
      options?: { onPassComplete?: (id: string, target: { framebuffer: unknown } | null) => void },
    ): void
  }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  passContext(): unknown
  setState(next: { displayMode: string; patternPhase: number }): void
  renderNow(): void
  syncSize(): boolean
  stop(): void
}

test.describe('WebGL2 plumbing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
  })

  test('ingest produces the ACEScg values the TypeScript reference computes', async ({ page }) => {
    const readback = await page.evaluate<number[][], { uvs: number[][]; decodeSrc: string }>(
      ({ uvs, decodeSrc }) => {
        const decodeHalf = eval(decodeSrc) as (h: number) => number
        const renderer = (window as unknown as { __photolabRenderer: RendererLike })
          .__photolabRenderer
        renderer.stop()
        renderer.syncSize()

        const gl = renderer.context.gl
        const canvas = renderer.context.canvas
        const samples: number[][] = []

        // Read while the ingest target is still bound. IMPLEMENTATION_COLOR_READ_TYPE
        // on an RGBA16F framebuffer is HALF_FLOAT, per tests/probe, so the read is
        // in half float and decoded here rather than resolved through RGBA8 —
        // which would clamp exactly the out-of-range values worth checking.
        renderer.graph.render(
          { displayMode: 'sdr', patternPhase: 0 },
          renderer.passContext(),
          {
            onPassComplete: (id) => {
              if (id !== 'ingest') return
              const pixel = new Uint16Array(4)
              for (const uv of uvs) {
                const x = Math.min(canvas.width - 1, Math.max(0, Math.round((uv[0] ?? 0) * canvas.width)))
                const y = Math.min(canvas.height - 1, Math.max(0, Math.round((uv[1] ?? 0) * canvas.height)))
                gl.readPixels(x, y, 1, 1, gl.RGBA, gl.HALF_FLOAT, pixel)
                samples.push([
                  decodeHalf(pixel[0] ?? 0),
                  decodeHalf(pixel[1] ?? 0),
                  decodeHalf(pixel[2] ?? 0),
                ])
              }
            },
          },
        )

        return samples
      },
      { uvs: UVS, decodeSrc: DECODE_HALF },
    )

    expect(readback).toHaveLength(PATCH_COUNT)

    const failures: string[] = []
    for (let i = 0; i < PATCH_COUNT; i++) {
      const patch = PATCH_COLOURS[i]
      const actual = readback[i]
      if (!patch || !actual) {
        failures.push(`patch ${i}: missing`)
        continue
      }
      const expected = expectedAcescg(patch)
      for (let c = 0; c < 3; c++) {
        const got = actual[c] ?? Number.NaN
        const want = expected[c] ?? Number.NaN
        const tolerance = acescgTolerance(want)
        if (!(Math.abs(got - want) <= tolerance)) {
          failures.push(
            `patch ${i} [${patch.join(', ')}] channel ${'rgb'[c] ?? '?'}: ` +
              `expected ${want.toFixed(6)}, got ${got.toFixed(6)}, ` +
              `delta ${(got - want).toExponential(2)}, tolerance ${tolerance.toExponential(2)}`,
          )
        }
      }
    }

    expect(failures.join('\n')).toBe('')
  })

  test('the canvas shows the display transform the reference predicts', async ({ page }) => {
    // Weaker than the intermediate test on the matrices, and the only test that
    // covers the clamp and the encode. Two patches sit outside the encodable
    // range precisely to exercise them.
    const readback = await page.evaluate<number[][], { uvs: number[][] }>(({ uvs }) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.setState({ displayMode: 'sdr', patternPhase: 0 })
      // Read in the SAME task as the draw: preserveDrawingBuffer is false, so
      // the drawing buffer is only valid until the browser composites.
      renderer.renderNow()

      const gl = renderer.context.gl
      const canvas = renderer.context.canvas
      const pixel = new Uint8Array(4)
      const out: number[][] = []
      for (const uv of uvs) {
        const x = Math.min(canvas.width - 1, Math.max(0, Math.round((uv[0] ?? 0) * canvas.width)))
        const y = Math.min(canvas.height - 1, Math.max(0, Math.round((uv[1] ?? 0) * canvas.height)))
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        out.push([pixel[0] ?? -1, pixel[1] ?? -1, pixel[2] ?? -1])
      }
      return out
    }, { uvs: UVS })

    const failures: string[] = []
    for (let i = 0; i < PATCH_COUNT; i++) {
      const patch = PATCH_COLOURS[i]
      const actual = readback[i]
      if (!patch || !actual) {
        failures.push(`patch ${i}: missing`)
        continue
      }
      const expected = expectedCanvasBytes(patch)
      for (let c = 0; c < 3; c++) {
        const got = actual[c] ?? -1
        const want = expected[c] ?? -1
        // One code value for the rounding either side, plus one for
        // SwiftShader's fp32 rounding, which differs between the LLVM backend
        // used locally and the Subzero backend used in CI.
        if (Math.abs(got - want) > 2) {
          failures.push(
            `patch ${i} [${patch.join(', ')}] channel ${'rgb'[c] ?? '?'}: expected ${want}, got ${got}`,
          )
        }
      }
    }
    expect(failures.join('\n')).toBe('')
  })

  test('clamps out-of-range values rather than producing garbage', async ({ page }) => {
    // Patch 14 is 1.2 encoded and patch 15 has a negative channel. Asserting the
    // clamped result explicitly, because "the tone map is not built yet" must
    // look like crushed black and blown white, not like undefined output.
    const readback = await page.evaluate<number[][], { uvs: number[][] }>(({ uvs }) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.renderNow()
      const gl = renderer.context.gl
      const canvas = renderer.context.canvas
      const pixel = new Uint8Array(4)
      const out: number[][] = []
      for (const uv of uvs) {
        const x = Math.round((uv[0] ?? 0) * canvas.width)
        const y = Math.round((uv[1] ?? 0) * canvas.height)
        gl.readPixels(
          Math.min(canvas.width - 1, Math.max(0, x)),
          Math.min(canvas.height - 1, Math.max(0, y)),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
        )
        out.push([pixel[0] ?? -1, pixel[1] ?? -1, pixel[2] ?? -1])
      }
      return out
    }, { uvs: UVS })

    expect(readback[14], 'an encoded value of 1.2 must clamp to white').toEqual([255, 255, 255])
    const negative = readback[15]
    expect(negative?.[0], 'a negative channel must clamp to black, not wrap').toBe(0)
  })

  test('a parameter change updates uniforms; only a variant change compiles', async ({ page }) => {
    const counts = await page.evaluate(() => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.setState({ displayMode: 'sdr', patternPhase: 0 })
      renderer.renderNow()

      const afterFirstFrame = renderer.graph.compileCount
      const allocationsAfterFirstFrame = renderer.graph.allocationCount

      for (let frame = 0; frame < 60; frame++) {
        renderer.setState({ displayMode: 'sdr', patternPhase: frame / 60 })
        renderer.renderNow()
      }
      const afterDrag = renderer.graph.compileCount
      const allocationsAfterDrag = renderer.graph.allocationCount

      renderer.setState({ displayMode: 'identity', patternPhase: 0 })
      renderer.renderNow()
      const afterVariant = renderer.graph.compileCount

      renderer.setState({ displayMode: 'sdr', patternPhase: 0 })
      renderer.renderNow()
      const afterReturningToKnownVariant = renderer.graph.compileCount

      return {
        passIds: renderer.graph.passIds,
        afterFirstFrame,
        afterDrag,
        afterVariant,
        afterReturningToKnownVariant,
        allocationsAfterFirstFrame,
        allocationsAfterDrag,
        glError: renderer.context.gl.getError(),
      }
    })

    expect(counts.glError, 'gl.getError() after rendering').toBe(0)
    expect(counts.passIds, 'passes run in physical stage order').toEqual([
      'testPattern',
      'ingest',
      'display',
    ])

    expect(counts.afterFirstFrame, 'one program per pass').toBe(3)
    expect(counts.afterDrag, '60 frames of a moving parameter must compile nothing').toBe(3)
    expect(counts.afterVariant, 'a compile-time variant compiles exactly once').toBe(4)
    expect(counts.afterReturningToKnownVariant, 'a known variant is reused').toBe(4)

    // Three passes ping-pong through two buffers, and a steady state allocates
    // none: at proxy size that would be hundreds of megabytes of churn a second.
    expect(counts.allocationsAfterFirstFrame).toBe(2)
    expect(counts.allocationsAfterDrag).toBe(2)
  })
})

test('reports rather than degrades when a half-float framebuffer is unavailable', async ({
  page,
}) => {
  // The behaviour that must never be a silent fallback, asserted by actually
  // removing the extensions rather than by reading the branch.
  await page.addInitScript(() => {
    // Patch getExtension on the WebGL2 prototype rather than getContext, so the
    // context is created normally and only the capability lookup is affected.
    /* eslint-disable @typescript-eslint/unbound-method -- deliberate prototype patch */
    const real = WebGL2RenderingContext.prototype.getExtension
    /* eslint-enable @typescript-eslint/unbound-method */
    WebGL2RenderingContext.prototype.getExtension = function patched(
      this: WebGL2RenderingContext,
      name: string,
    ) {
      if (name === 'EXT_color_buffer_float' || name === 'EXT_color_buffer_half_float') return null
      return real.call(this, name) as unknown
    } as typeof WebGL2RenderingContext.prototype.getExtension
  })

  await page.goto('/')

  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('high-precision colour')
  expect(await page.evaluate(() => '__photolabRenderer' in window)).toBe(false)
})
