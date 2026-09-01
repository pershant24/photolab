import { expect, test } from '@playwright/test'

import {
  DEFAULT_DISPLAY_SETTINGS,
  displayTransform,
  displayTransformIdentity,
} from '../../src/core/colour/display'
import type { DisplaySettings } from '../../src/core/colour/display'
import type { Vec3 } from '../../src/core/colour/types'
import { PATCHES, PATCH_COUNT, patchCentreUv } from '../../src/render/testPattern'

/**
 * The display transform's two operator stages, against the reference.
 *
 * The leg's input is the **measured** ACEScg intermediate, so this pins the
 * operators without the ingest matrix in the way — the same construction the
 * two-leg harness uses, extended to the last pass. The final pass renders into a
 * half-float target rather than the canvas, so the comparison is not limited to
 * 8-bit quantisation.
 */

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
    compileCount: number
    pool: { acquire(w: number, h: number): unknown; release(t: unknown): void }
    render(input: unknown, context: unknown, options?: Record<string, unknown>): void
  }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  input: { source: unknown; edit: unknown; view: Record<string, unknown> }
  passContext(): unknown
  syncSize(): boolean
  stop(): void
}

async function measure(
  page: import('@playwright/test').Page,
  view: Record<string, unknown>,
  edit: { exposure: number; contrast: number },
): Promise<{ acescg: number[][]; displayed: number[][] }> {
  return page.evaluate<
    { acescg: number[][]; displayed: number[][] },
    { uvs: number[][]; decodeSrc: string; view: Record<string, unknown>; edit: unknown }
  >(
    ({ uvs, decodeSrc, view, edit }) => {
      const decodeHalf = eval(decodeSrc) as (h: number) => number
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.syncSize()

      const gl = renderer.context.gl
      const canvas = renderer.context.canvas
      // What display actually receives is the output of the last pass before it,
      // which is not ingest once exposure or contrast are in the chain. Sampling
      // ingest instead would compare the display transform against an input it
      // never saw.
      let acescg: number[][] = []
      let previous: number[][] = []
      const displayed: number[][] = []

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
          { ...renderer.input, edit, view: { ...renderer.input.view, ...view } },
          renderer.passContext(),
          {
            finalTarget,
            onPassComplete: (id: string) => {
              if (id === 'display') {
                acescg = previous
                displayed.push(...sample())
                return
              }
              previous = sample()
            },
          },
        )
      } finally {
        renderer.graph.pool.release(finalTarget)
      }

      return { acescg, displayed }
    },
    { uvs: UVS, decodeSrc: DECODE_HALF, view, edit },
  )
}

const FP16_RELATIVE = 2 ** -11

function compare(
  acescg: number[][],
  displayed: number[][],
  settings: DisplaySettings | null,
): string[] {
  const failures: string[] = []
  for (let i = 0; i < PATCH_COUNT; i++) {
    const patch = PATCHES[i]
    const measured = acescg[i]
    const actual = displayed[i]
    if (!patch || !measured || !actual) {
      failures.push(`patch ${i}: missing`)
      continue
    }
    const input = measured as unknown as Vec3
    const expected = settings ? displayTransform(input, settings) : displayTransformIdentity(input)

    for (let c = 0; c < 3; c++) {
      const got = actual[c] ?? Number.NaN
      const want = expected[c] ?? Number.NaN
      // The shader read the same half-float texel this test read back, so there
      // is no input quantisation term. What remains is fp16 storage of the
      // result and the rasteriser's transcendentals, carried by the encode
      // curve's slope, which is steepest near black.
      const bound = 4 * FP16_RELATIVE * Math.abs(want) + 2e-4
      if (!(Math.abs(got - want) <= bound)) {
        failures.push(
          `patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: ` +
            `acescg ${input[c]?.toFixed(5) ?? '?'}, expected ${want.toFixed(6)}, ` +
            `got ${got.toFixed(6)}, delta ${(got - want).toExponential(2)}`,
        )
      }
    }
  }
  return failures
}

test.describe('display transform', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
  })

  test('matches the reference with both stages on', async ({ page }) => {
    const { acescg, displayed } = await measure(
      page,
      { displayMode: 'sdr', toneMap: true, gamutCompress: true },
      { exposure: 1.2, contrast: 1.5 },
    )
    expect(compare(acescg, displayed, DEFAULT_DISPLAY_SETTINGS).join('\n')).toBe('')
  })

  test('matches the reference with the tone map alone', async ({ page }) => {
    // Each stage addressed on its own, so a failure names which one is wrong
    // rather than which patch.
    const { acescg, displayed } = await measure(
      page,
      { displayMode: 'sdr', toneMap: true, gamutCompress: false },
      { exposure: 0.8, contrast: 1.3 },
    )
    const settings = { ...DEFAULT_DISPLAY_SETTINGS, gamutCompress: false }
    expect(compare(acescg, displayed, settings).join('\n')).toBe('')
  })

  test('matches the reference with gamut compression alone', async ({ page }) => {
    const { acescg, displayed } = await measure(
      page,
      { displayMode: 'sdr', toneMap: false, gamutCompress: true },
      { exposure: 0, contrast: 1.4 },
    )
    const settings = { ...DEFAULT_DISPLAY_SETTINGS, toneMap: false }
    expect(compare(acescg, displayed, settings).join('\n')).toBe('')
  })

  test('keeps the identity path free of both stages', async ({ page }) => {
    // The path the two-leg harness addresses the matrix through. It must remain
    // matrix and encode only: no compression, no roll-off, no clamp.
    const { acescg, displayed } = await measure(
      page,
      { displayMode: 'identity' },
      { exposure: 0, contrast: 1 },
    )
    expect(compare(acescg, displayed, null).join('\n')).toBe('')
  })

  test('recovers highlights that the clamp alone flattens', async ({ page }) => {
    // The measurement this stage exists for, at the level of individual patches:
    // values a clamp makes identical must come out ordered and distinguishable.
    const edit = { exposure: 2.5, contrast: 1 }

    const clamped = await measure(
      page,
      { displayMode: 'sdr', toneMap: false, gamutCompress: false },
      edit,
    )
    const mapped = await measure(
      page,
      { displayMode: 'sdr', toneMap: true, gamutCompress: true },
      edit,
    )

    // Two neutral patches that differ in brightness and both blow out at +2.5 EV.
    const half = PATCHES.findIndex((p) => p.label === 'half encoded grey')
    const white = PATCHES.findIndex((p) => p.label === 'white')
    expect(half).toBeGreaterThanOrEqual(0)
    expect(white).toBeGreaterThanOrEqual(0)

    const clampedHalf = clamped.displayed[half]?.[0] ?? Number.NaN
    const clampedWhite = clamped.displayed[white]?.[0] ?? Number.NaN
    const mappedHalf = mapped.displayed[half]?.[0] ?? Number.NaN
    const mappedWhite = mapped.displayed[white]?.[0] ?? Number.NaN

    expect(clampedHalf, 'both clip to display white without the operator').toBeCloseTo(1, 3)
    expect(clampedWhite).toBeCloseTo(1, 3)

    expect(mappedWhite, 'the roll-off keeps them apart').toBeGreaterThan(mappedHalf + 0.01)
    expect(mappedWhite).toBeLessThan(1)
  })

  test('switching a stage compiles once; changing its parameter compiles nothing', async ({
    page,
  }) => {
    const counts = await page.evaluate(() => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      const render = (view: Record<string, unknown>): void => {
        renderer.graph.render(
          { ...renderer.input, view: { ...renderer.input.view, ...view } },
          renderer.passContext(),
        )
      }

      render({ displayMode: 'sdr', toneMap: true, gamutCompress: true })
      const base = renderer.graph.compileCount

      // Sixty frames of a moving knee, as a control on it would produce.
      for (let i = 0; i < 60; i++) {
        render({ displayMode: 'sdr', toneMap: true, gamutCompress: true, toneMapKnee: 0.3 + i / 200 })
      }
      const afterParameterDrag = renderer.graph.compileCount

      render({ displayMode: 'sdr', toneMap: false, gamutCompress: true })
      const afterToggle = renderer.graph.compileCount
      render({ displayMode: 'sdr', toneMap: true, gamutCompress: true })
      const afterReturning = renderer.graph.compileCount

      return { base, afterParameterDrag, afterToggle, afterReturning }
    })

    expect(counts.afterParameterDrag, 'the knee is a uniform, not a variant').toBe(counts.base)
    expect(counts.afterToggle, 'toggling a stage is a new variant, compiled once').toBe(
      counts.base + 1,
    )
    expect(counts.afterReturning, 'a known variant is reused').toBe(counts.base + 1)
  })
})
