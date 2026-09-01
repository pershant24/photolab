import { expect, test } from '@playwright/test'

import { evaluateCurve } from '../../src/core/colour/curve'
import { FILM_STOCKS } from '../../src/core/colour/filmStock'
import { decodeACEScct, encodeACEScct } from '../../src/core/colour/transfer'
import { splitControlPoints } from '../../src/core/state/editState'
import { PATCHES, PATCH_COUNT, patchCentreUv } from '../../src/render/testPattern'

const STOCK = FILM_STOCKS[0]
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
    passIds: string[]
    pool: { acquire(w: number, h: number): unknown; release(t: unknown): void }
    render(input: unknown, context: unknown, options?: Record<string, unknown>): void
  }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  input: { source: unknown; edit: Record<string, unknown>; view: Record<string, unknown> }
  filmBakeCount: number
  passContext(): unknown
  syncSize(): boolean
  renderNow(): void
  stop(): void
}

async function measure(
  page: import('@playwright/test').Page,
  edit: Record<string, unknown>,
): Promise<{ before: number[][]; after: number[][]; passIds: string[] }> {
  return page.evaluate<
    { before: number[][]; after: number[][]; passIds: string[] },
    { uvs: number[][]; decodeSrc: string; edit: Record<string, unknown> }
  >(
    ({ uvs, decodeSrc, edit }) => {
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
          { ...renderer.input, edit: { ...renderer.input.edit, ...edit } },
          renderer.passContext(),
          {
            finalTarget,
            onPassComplete: (id: string) => {
              passIds.push(id)
              if (id === 'filmCurves') {
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
    { uvs: UVS, decodeSrc: DECODE_HALF, edit },
  )
}

const FP16_RELATIVE = 2 ** -11

function stockEdit(strength = 1): Record<string, unknown> {
  return {
    filmCurveRed: [...(STOCK?.red ?? [])],
    filmCurveGreen: [...(STOCK?.green ?? [])],
    filmCurveBlue: [...(STOCK?.blue ?? [])],
    filmStrength: strength,
  }
}

test.describe('film characteristic curves', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
  })

  test('runs in the film stage, and is skipped at the identity', async ({ page }) => {
    const off = await measure(page, {})
    expect(off.passIds).not.toContain('filmCurves')

    const on = await measure(page, stockEdit())
    expect(on.passIds).toContain('filmCurves')
    // Film before grade: a colourist works on a developed negative.
    expect(on.passIds.indexOf('filmCurves')).toBeLessThan(on.passIds.indexOf('display'))

    const zeroStrength = await measure(page, stockEdit(0))
    expect(zeroStrength.passIds, 'zero strength costs no pass').not.toContain('filmCurves')
  })

  test('matches direct spline evaluation, per channel', async ({ page }) => {
    for (const strength of [1, 0.45]) {
      const { before, after } = await measure(page, stockEdit(strength))
      const channels = [STOCK?.red ?? [], STOCK?.green ?? [], STOCK?.blue ?? []]

      const failures: string[] = []
      for (let i = 0; i < PATCH_COUNT; i++) {
        const patch = PATCHES[i]
        const input = before[i]
        const output = after[i]
        if (!patch || !input || !output) continue

        for (let c = 0; c < 3; c++) {
          const { xs, ys } = splitControlPoints(channels[c] ?? [])
          const linear = input[c] ?? Number.NaN
          const encoded = encodeACEScct(linear)
          const blended = encoded + strength * (evaluateCurve(xs, ys, encoded) - encoded)
          const expected = decodeACEScct(blended)
          const got = output[c] ?? Number.NaN

          // The lookup table's interpolation error lives in the curve's output,
          // so the decode's slope is evaluated there — the "carry the bound by
          // the local slope, at the right point" step from section 5.
          const slope =
            Math.abs(decodeACEScct(blended + 1e-5) - decodeACEScct(blended - 1e-5)) / 2e-5
          const bound = 2 * (slope * 2 ** -13 + FP16_RELATIVE * Math.abs(expected)) + 1e-4

          if (!(Math.abs(got - expected) <= bound)) {
            failures.push(
              `strength ${strength} patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: ` +
                `expected ${expected.toFixed(6)}, got ${got.toFixed(6)}, ` +
                `delta ${(got - expected).toExponential(2)}, bound ${bound.toExponential(2)}`,
            )
          }
        }
      }
      expect(failures.slice(0, 8).join('\n')).toBe('')
    }
  })

  test('bakes three tables once, and not again per frame', async ({ page }) => {
    const counts = await page.evaluate<
      { afterFirst: number; afterFrames: number; afterStrength: number; afterCurveChange: number },
      Record<string, unknown>
    >((edit) => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      const render = (patch: Record<string, unknown>): void => {
        renderer.graph.render(
          { ...renderer.input, edit: { ...renderer.input.edit, ...edit, ...patch } },
          renderer.passContext(),
        )
      }

      render({})
      const afterFirst = renderer.filmBakeCount
      for (let i = 0; i < 40; i++) render({})
      const afterFrames = renderer.filmBakeCount

      // Strength is a uniform, so dragging it must not rebake anything.
      for (let i = 0; i < 40; i++) render({ filmStrength: i / 40 })
      const afterStrength = renderer.filmBakeCount

      // Moving one channel's control point rebakes that channel only.
      const red = [...((edit.filmCurveRed as number[]) ?? [])]
      red[3] = (red[3] ?? 0) + 0.01
      render({ filmCurveRed: red })
      render({ filmCurveRed: red })
      const afterCurveChange = renderer.filmBakeCount

      return { afterFirst, afterFrames, afterStrength, afterCurveChange }
    }, stockEdit())

    expect(counts.afterFirst, 'three channels, three bakes').toBe(3)
    expect(counts.afterFrames, '40 frames with no change must not rebake').toBe(3)
    expect(counts.afterStrength, 'strength is a uniform, not a curve').toBe(3)
    expect(counts.afterCurveChange, 'one channel changed, one channel rebaked').toBe(4)
  })
})
