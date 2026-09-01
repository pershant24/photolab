import { expect, test } from '@playwright/test'

import { applyContrast, applyExposure } from '../../src/core/colour/grade'
import { PATCHES, PATCH_COUNT, patchCentreUv } from '../../src/render/testPattern'

/**
 * Exposure and contrast, verified leg by leg against `src/core/colour/`.
 *
 * The chain is now five passes, and the method from §4 of
 * SHADER_CONVENTIONS.md extends to all of them: each leg's expectation is
 * computed from what was **measured** at the end of the previous pass, never
 * from the original input. Chaining expectations forward instead would make one
 * end-to-end comparison again, and an end-to-end comparison through a matrix and
 * its inverse cannot see a consistent convention error at any tolerance.
 *
 * A useful consequence of measuring between every pass: the shader and the
 * reference receive the *same* half-float input, because the shader sampled the
 * texel this test read back. There is no input quantisation error between them,
 * so the tolerance covers only the arithmetic and the storage of the result.
 */

const EXPOSURE = 1.35
const CONTRAST = 1.4

const UVS = Array.from({ length: PATCH_COUNT }, (_, i) => [...patchCentreUv(i)])

/** Half float has an 11-bit significand. */
const FP16_RELATIVE = 2 ** -11

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
    pool: {
      acquire(w: number, h: number): { framebuffer: unknown; width: number; height: number }
      release(t: unknown): void
    }
    render(
      input: unknown,
      context: unknown,
      options?: { onPassComplete?: (id: string, target: unknown) => void; finalTarget?: unknown },
    ): void
  }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  input: { source: unknown; edit: unknown; view: unknown }
  passContext(): unknown
  setEdit(next: { exposure: number; contrast: number }): void
  syncSize(available?: { width: number; height: number }): boolean
  renderNow(available?: { width: number; height: number }): void
  stop(): void
}

interface StoreLike {
  getState(): {
    edit: { exposure: number; contrast: number }
    setParameter(key: 'exposure' | 'contrast', value: number): void
    beginInteraction(): void
    endInteraction(): void
    undo(): void
    redo(): void
    reset(): void
  }
}

/** Every pass's output, sampled at each patch centre, from one render. */
type Legs = Record<string, number[][]>

async function measureLegs(
  page: import('@playwright/test').Page,
  edit: { exposure: number; contrast: number },
): Promise<{ legs: Legs; passIds: string[] }> {
  return page.evaluate<
    { legs: Legs; passIds: string[] },
    { uvs: number[][]; decodeSrc: string; edit: { exposure: number; contrast: number } }
  >(
    ({ uvs, decodeSrc, edit }) => {
      const decodeHalf = eval(decodeSrc) as (h: number) => number
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      renderer.stop()
      renderer.syncSize()

      const gl = renderer.context.gl
      const canvas = renderer.context.canvas
      const legs: Legs = {}
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

      // The final pass writes into a half-float target rather than the canvas,
      // so the last leg is not limited to 8-bit precision either.
      const finalTarget = renderer.graph.pool.acquire(canvas.width, canvas.height)
      try {
        renderer.graph.render(
          { ...renderer.input, edit },
          renderer.passContext(),
          {
            finalTarget,
            onPassComplete: (id) => {
              passIds.push(id)
              legs[id] = sample()
            },
          },
        )
      } finally {
        renderer.graph.pool.release(finalTarget)
      }

      return { legs, passIds }
    },
    { uvs: UVS, decodeSrc: DECODE_HALF, edit },
  )
}

/**
 * Tolerance on a value the shader computed from a half-float input this test
 * read back.
 *
 * The input is identical for both implementations, so there is no input
 * quantisation term. What remains is the fp16 storage of the result, and the
 * difference between the rasteriser's `log2`/`exp2` and JavaScript's — carried
 * across the operation by its local slope, per §5 of SHADER_CONVENTIONS.md. The
 * slope is measured numerically rather than derived by hand, which keeps it
 * correct across ACEScct's toe and its log segment without a special case.
 */
function tolerance(expected: number, localSlope: number, input: number): number {
  const storage = FP16_RELATIVE * Math.abs(expected)
  // A generous bound on a transcendental's error in fp32, carried by the slope.
  const arithmetic = Math.abs(localSlope) * 1e-6 * Math.max(Math.abs(input), 1e-3)
  return 2 * (storage + arithmetic) + 1e-5
}

function slopeOf(f: (x: number) => number, x: number): number {
  const h = Math.max(Math.abs(x) * 1e-4, 1e-6)
  return (f(x + h) - f(x - h)) / (2 * h)
}

function compareLeg(
  name: string,
  measuredIn: number[][],
  measuredOut: number[][],
  operation: (value: number) => number,
): string[] {
  const failures: string[] = []
  for (let i = 0; i < PATCH_COUNT; i++) {
    const patch = PATCHES[i]
    const from = measuredIn[i]
    const to = measuredOut[i]
    if (!patch || !from || !to) {
      failures.push(`${name}: patch ${i} missing`)
      continue
    }
    for (let c = 0; c < 3; c++) {
      const input = from[c] ?? Number.NaN
      const got = to[c] ?? Number.NaN
      const want = operation(input)
      const bound = tolerance(want, slopeOf(operation, input), input)
      if (!(Math.abs(got - want) <= bound)) {
        failures.push(
          `${name}: patch ${i} (${patch.label}) channel ${'rgb'[c] ?? '?'}: ` +
            `in ${input.toFixed(6)}, expected ${want.toFixed(6)}, got ${got.toFixed(6)}, ` +
            `delta ${(got - want).toExponential(2)}, bound ${bound.toExponential(2)}`,
        )
      }
    }
  }
  return failures
}

test.describe('exposure and contrast', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window && '__photolabStore' in window)
  })

  test('both passes run, in their physical stage positions', async ({ page }) => {
    const { passIds } = await measureLegs(page, { exposure: EXPOSURE, contrast: CONTRAST })
    expect(passIds).toEqual(['testPattern', 'ingest', 'exposure', 'contrast', 'display'])
  })

  test('a parameter at its identity value skips its pass entirely', async ({ page }) => {
    // Not an optimisation detail: a disabled pass is the one thing EditState
    // changes about graph structure, and it is what keeps an untouched slider
    // from costing a full-screen draw.
    const none = await measureLegs(page, { exposure: 0, contrast: 1 })
    expect(none.passIds).toEqual(['testPattern', 'ingest', 'display'])

    const onlyExposure = await measureLegs(page, { exposure: 1, contrast: 1 })
    expect(onlyExposure.passIds).toEqual(['testPattern', 'ingest', 'exposure', 'display'])

    const onlyContrast = await measureLegs(page, { exposure: 0, contrast: 1.2 })
    expect(onlyContrast.passIds).toEqual(['testPattern', 'ingest', 'contrast', 'display'])
  })

  test('exposure multiplies linear light by two to the stops', async ({ page }) => {
    const { legs } = await measureLegs(page, { exposure: EXPOSURE, contrast: CONTRAST })
    const failures = compareLeg('exposure', legs.ingest ?? [], legs.exposure ?? [], (v) =>
      applyExposure(v, EXPOSURE),
    )
    expect(failures.join('\n')).toBe('')
  })

  test('contrast matches the ACEScct reference, per channel', async ({ page }) => {
    const { legs } = await measureLegs(page, { exposure: EXPOSURE, contrast: CONTRAST })
    const failures = compareLeg('contrast', legs.exposure ?? [], legs.contrast ?? [], (v) =>
      applyContrast(v, CONTRAST),
    )
    expect(failures.join('\n')).toBe('')
  })

  test('agrees across the full range of both sliders', async ({ page }) => {
    // One value each would pass with a sign error on a term that happens to be
    // small there. The ends of both sliders are where a wrong branch in the
    // ACEScct toe shows up: a slope below 1 pulls values toward the pivot and a
    // slope above it pushes them through zero.
    const cases: readonly [number, number][] = [
      [-5, 0.01],
      [-4, 0.4],
      [-1, 0.9],
      [0.5, 1.1],
      [3, 1.9],
      [5, 2],
    ]

    const failures: string[] = []
    for (const [exposure, contrast] of cases) {
      const { legs } = await measureLegs(page, { exposure, contrast })
      failures.push(
        ...compareLeg(`exposure ${exposure}`, legs.ingest ?? [], legs.exposure ?? [], (v) =>
          applyExposure(v, exposure),
        ),
        ...compareLeg(`contrast ${contrast}`, legs.exposure ?? [], legs.contrast ?? [], (v) =>
          applyContrast(v, contrast),
        ),
      )
    }
    expect(failures.slice(0, 12).join('\n')).toBe('')
  })

  test('pivots contrast at middle grey, leaving it unmoved at any slope', async ({ page }) => {
    // The property the pivot exists for, measured on a real patch rather than
    // asserted about a constant. A pivot at the literal 0.18 in encoded space
    // sits two and a half stops low and would lift the whole image as it
    // steepens; this is what catches that.
    const midGrey = PATCHES.findIndex((p) => p.label.startsWith('middle grey'))
    expect(midGrey).toBeGreaterThanOrEqual(0)

    for (const contrast of [0.4, 1, 1.6, 2]) {
      const { legs } = await measureLegs(page, { exposure: 0, contrast })
      const before = (legs.ingest ?? [])[midGrey]
      const after = (legs.contrast ?? legs.ingest ?? [])[midGrey]
      expect(before, `contrast ${contrast}: no ingest sample`).toBeDefined()
      expect(after, `contrast ${contrast}: no output sample`).toBeDefined()
      if (!before || !after) continue

      for (let c = 0; c < 3; c++) {
        const from = before[c] ?? Number.NaN
        const to = after[c] ?? Number.NaN
        // Middle grey is 0.18 in ACEScg only because the patch was chosen to be
        // 0.18; assert against what was measured going in, not against 0.18.
        expect(Math.abs(to - from), `contrast ${contrast}, channel ${c}`).toBeLessThan(
          4 * FP16_RELATIVE * Math.abs(from) + 1e-5,
        )
      }
    }
  })
})

test.describe('crushed shadows are correct pre-tone-map behaviour', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window && '__photolabStore' in window)
  })

  test('contrast above 1 drives near-black negative, and the clamp shows it as black', async ({
    page,
  }) => {
    // Pinned deliberately. This will look like a bug the first time anyone drags
    // the slider on a dark photograph, and it is not one: the ACEScct toe is
    // signed, so steepening about middle grey takes values below the pivot
    // through zero.
    //
    // **This is not an open display bug.** The tone map landed in Stage 5 and
    // deliberately did not change it: the crushed figure — 39% of a night frame
    // at a contrast of 1.3 — was measured before and after and is identical,
    // because those pixels are already negative when the display transform
    // receives them. The clamp is reporting the grade's output faithfully.
    //
    // The fix belongs to the **film stage's toe**, which is what gives shadows a
    // floor to compress against instead of a cliff at zero. Anyone reading this
    // as unfinished display work should read docs/ARCHITECTURE.md first.
    const contrast = 1.5
    const nearBlack = PATCHES.findIndex((p) => p.label === 'just below the sRGB break')
    expect(nearBlack).toBeGreaterThanOrEqual(0)

    const { legs } = await measureLegs(page, { exposure: 0, contrast })
    const before = (legs.ingest ?? [])[nearBlack]
    const after = (legs.contrast ?? [])[nearBlack]
    expect(before).toBeDefined()
    expect(after).toBeDefined()
    if (!before || !after) return

    for (let c = 0; c < 3; c++) {
      expect(before[c], `channel ${c} starts positive`).toBeGreaterThan(0)
      expect(after[c], `channel ${c} is driven negative by contrast ${contrast}`).toBeLessThan(0)
    }

    // And the display transform renders that as black rather than as garbage.
    const canvas = await page.evaluate<number[], { uv: number[]; contrast: number }>(
      ({ uv, contrast }) => {
        const renderer = (window as unknown as { __photolabRenderer: RendererLike })
          .__photolabRenderer
        renderer.stop()
        renderer.setEdit({ exposure: 0, contrast })
        renderer.renderNow()
        const gl = renderer.context.gl
        const element = renderer.context.canvas
        const pixel = new Uint8Array(4)
        const x = Math.round((uv[0] ?? 0) * element.width)
        const y = Math.round((uv[1] ?? 0) * element.height)
        gl.readPixels(
          Math.min(element.width - 1, Math.max(0, x)),
          Math.min(element.height - 1, Math.max(0, y)),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
        )
        return [pixel[0] ?? -1, pixel[1] ?? -1, pixel[2] ?? -1]
      },
      { uv: [...patchCentreUv(nearBlack)], contrast },
    )

    expect(canvas, 'flat crushed black, not wrapped or undefined output').toEqual([0, 0, 0])
  })
})

test.describe('purity: the path to a state does not change the pixels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window && '__photolabStore' in window)
  })

  test('renders identically whether set directly or reached through a drag and an undo', async ({
    page,
  }) => {
    // The invariant the whole architecture rests on, now testable because the
    // passes consume the values. Asserted as byte equality rather than within a
    // tolerance: the renderer is a pure function of (source, EditState), so two
    // routes to one EditState must produce the same bytes, not merely similar
    // ones. Anything less would mean state was surviving between frames.
    const frames = await page.evaluate(() => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike })
        .__photolabRenderer
      const store = (window as unknown as { __photolabStore: StoreLike }).__photolabStore
      renderer.stop()

      const gl = renderer.context.gl
      const canvas = renderer.context.canvas

      const grab = (): number[] => {
        renderer.renderNow()
        const buffer = new Uint8Array(canvas.width * canvas.height * 4)
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buffer)
        return Array.from(buffer)
      }

      const target = { exposure: 1.35, contrast: 1.4 }

      // Route one: set directly.
      store.getState().reset()
      store.getState().setParameter('exposure', target.exposure)
      store.getState().setParameter('contrast', target.contrast)
      renderer.setEdit(store.getState().edit)
      const direct = grab()

      // Route two: drag past it, come back, overshoot, undo, redo.
      store.getState().reset()
      store.getState().beginInteraction()
      for (const value of [-4, -2, 0, 2, 4, target.exposure]) {
        store.getState().setParameter('exposure', value)
      }
      store.getState().endInteraction()
      store.getState().beginInteraction()
      for (const value of [0.2, 0.8, 1.9, target.contrast]) {
        store.getState().setParameter('contrast', value)
      }
      store.getState().endInteraction()
      store.getState().setParameter('exposure', -5)
      store.getState().undo()
      store.getState().redo()
      store.getState().undo()
      renderer.setEdit(store.getState().edit)
      const viaDrag = grab()

      let firstDifference = -1
      for (let i = 0; i < direct.length; i++) {
        if (direct[i] !== viaDrag[i]) {
          firstDifference = i
          break
        }
      }

      return {
        pixels: direct.length / 4,
        firstDifference,
        edit: store.getState().edit,
        target,
      }
    })

    expect(frames.edit, 'both routes must reach the same EditState').toEqual(frames.target)
    expect(frames.pixels).toBeGreaterThan(1000)
    expect(
      frames.firstDifference,
      `frames differ from byte ${frames.firstDifference}; the renderer is not a pure function of EditState`,
    ).toBe(-1)
  })
})
