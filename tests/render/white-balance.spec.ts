import { expect, test } from '@playwright/test'

import { whiteBalanceMatrix } from '../../src/core/colour/whiteBalance'
import { mat3MulVec3 } from '../../src/core/colour/types'
import type { Vec3 } from '../../src/core/colour/types'
import { PATCHES, PATCH_COUNT, patchCentreUv } from '../../src/render/testPattern'

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
  passContext(): unknown
  syncSize(): boolean
  stop(): void
}

async function measure(
  page: import('@playwright/test').Page,
  edit: Record<string, number>,
): Promise<{ before: number[][]; after: number[][]; passIds: string[] }> {
  return page.evaluate<
    { before: number[][]; after: number[][]; passIds: string[] },
    { uvs: number[][]; decodeSrc: string; edit: Record<string, number> }
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
              if (id === 'whiteBalance') {
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

test.describe('white balance', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
  })

  test('is skipped entirely at the neutral setting', async ({ page }) => {
    // The strongest form of "neutral is an exact identity": the pass does not
    // run, so there is no arithmetic that could be almost right. Anything less
    // would mean every unedited photograph is altered by a correction nobody
    // asked for.
    const neutral = await measure(page, { temperature: 6500, tint: 0 })
    expect(neutral.passIds).not.toContain('whiteBalance')

    for (const edit of [
      { temperature: 6501, tint: 0 },
      { temperature: 6500, tint: 1 },
      { temperature: 3200, tint: -20 },
    ]) {
      const shifted = await measure(page, edit)
      expect(shifted.passIds, `${JSON.stringify(edit)}`).toContain('whiteBalance')
    }
  })

  test('runs in the scene stage, before exposure', async ({ page }) => {
    const { passIds } = await measure(page, { temperature: 3200, tint: 0, exposure: 1 })
    expect(passIds.indexOf('whiteBalance')).toBeLessThan(passIds.indexOf('exposure'))
    expect(passIds.indexOf('ingest')).toBeLessThan(passIds.indexOf('whiteBalance'))
  })

  test('matches the reference matrix across the parameter range', async ({ page }) => {
    const cases: Record<string, number>[] = [
      { temperature: 2500, tint: 0 },
      { temperature: 3200, tint: -40 },
      { temperature: 5000, tint: 25 },
      { temperature: 9000, tint: 0 },
      { temperature: 12000, tint: 80 },
    ]

    const failures: string[] = []
    for (const edit of cases) {
      const { before, after } = await measure(page, edit)
      const matrix = whiteBalanceMatrix(edit.temperature ?? 0, edit.tint ?? 0)

      for (let i = 0; i < PATCH_COUNT; i++) {
        const patch = PATCHES[i]
        const input = before[i]
        const output = after[i]
        if (!patch || !input || !output) continue
        const expected = mat3MulVec3(matrix, input as unknown as Vec3)

        for (let c = 0; c < 3; c++) {
          const got = output[c] ?? Number.NaN
          const want = expected[c] ?? Number.NaN
          // A matrix row is a dot product, so the bound scales by the sum of the
          // absolute contributions rather than by the result — the cancellation
          // rule from SHADER_CONVENTIONS.md section 5, which matters here because
          // an adaptation matrix has negative off-diagonal terms.
          const contributions = [0, 1, 2].reduce(
            (total, k) => total + Math.abs((matrix[c * 3 + k] ?? 0) * (input[k] ?? 0)),
            0,
          )
          const bound = 4 * FP16_RELATIVE * Math.max(Math.abs(want), contributions) + 1e-4
          if (!(Math.abs(got - want) <= bound)) {
            failures.push(
              `${JSON.stringify(edit)} patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: ` +
                `expected ${want.toFixed(6)}, got ${got.toFixed(6)}, delta ${(got - want).toExponential(2)}`,
            )
          }
        }
      }
    }
    expect(failures.slice(0, 8).join('\n')).toBe('')
  })
})
