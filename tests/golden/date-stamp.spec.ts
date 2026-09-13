import { expect, test } from '@playwright/test'

import {
  DATE_STAMP_HEIGHT,
  THINNEST_FEATURE,
  bufferEdgeForFeature,
  stampWidth,
} from '../../src/core/colour/dateStamp'
import { STOCK_PRESETS } from '../../src/core/presets/axisLibrary'
import { srgbEotf } from '../../src/core/colour/transfer'
import { DEFAULT_EDIT_STATE } from '../../src/core/state/editState'

/**
 * The date stamp's physics: that it is light on film rather than text on a
 * picture, and that the difference is observable.
 *
 * # What this file is for, and why it is not optional
 *
 * The stamp injects before halation and before the characteristic curves. That
 * is the entire design — it is why the stamp bleeds, why it sits in the stock's
 * shoulder, and why the pass is nineteen lines instead of a compositor. And it
 * is held up by **one thing**: a position in a registration list.
 *
 * `tests/unit/pass-positions.test.ts` asserts that position. What it cannot
 * assert is that the position does what it is claimed to do. A future refactor
 * that moved the stamp into the grade stage would fail that unit test, someone
 * would update the constraint to match, and every other test in this repository
 * would stay green while the stamp quietly became a caption.
 *
 * So the consequence is measured here rather than inferred: **with halation on
 * the stamp bleeds, and with halation off it does not.** Only a stamp that is
 * upstream of halation can do that.
 *
 * # The frame is flat and dark on purpose
 *
 * Every other fixture in this directory has structure everywhere, because those
 * tests measure how an effect treats a picture. This one measures light the
 * stamp adds to an otherwise empty frame, so anything else bright enough to
 * halate would contaminate it. At 40/255 the background is 0.019 linear and the
 * threshold below is 0.36, so the only thing in the frame that scatters is the
 * stamp — which is what makes "these pixels rose" attributable.
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

const SOURCE = { width: 640, height: 480 }

/** Flat and dark: the stamp is to be the only thing bright enough to scatter. */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  context.fillStyle = 'rgb(40, 40, 40)'
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
}

/**
 * `88 88 88`, at a radiance that clears the halation threshold with room over.
 *
 * The strength is not a taste decision. The threshold is in stops from middle
 * grey, so 1.0 stop is 0.36 linear and the smoothstep reaches one at 0.51. The
 * tint's luminance under AP1 weights is 0.494, so a strength of 4 gives 1.98 —
 * nearly four times the ceiling. That headroom is deliberate: a stamp that only
 * just cleared the threshold would make a failure here ambiguous between "the
 * injection point moved" and "the stamp is a little dim".
 */
const STAMP = {
  ...OFF,
  dateStampStrength: 4,
  dateStampYear: 1988,
  dateStampMonth: 8,
  dateStampDay: 8,
}

const HALATION = { halationStrength: 1, halationThreshold: 1, halationRadius: 0.02 }

/** The stamp's bounding box in source pixels, from the same constants the shader uses. */
const BOX = (() => {
  const cap = DATE_STAMP_HEIGHT * Math.max(SOURCE.width, SOURCE.height)
  const width = stampWidth() * cap
  const right = DEFAULT_EDIT_STATE.dateStampPosition[0]! * SOURCE.width
  const centreY = DEFAULT_EDIT_STATE.dateStampPosition[1]! * SOURCE.height
  return { left: right - width, right, top: centreY - cap / 2, bottom: centreY + cap / 2, cap }
})()

test.describe('the date stamp is light on film', () => {
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

  /** Render at a given buffer size and return RGB triples as floats. */
  async function render(
    page: import('@playwright/test').Page,
    edit: Record<string, number>,
    buffer: { width: number; height: number } = SOURCE,
    view: Record<string, unknown> = {},
  ): Promise<{ rgb: number[]; width: number; height: number }> {
    return page.evaluate<
      { rgb: number[]; width: number; height: number },
      {
        edit: Record<string, number>
        source: { width: number; height: number }
        buffer: { width: number; height: number }
        view: Record<string, unknown>
      }
    >(({ edit, source, buffer, view }) => {
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
      const target = renderer.graph.pool.acquire(buffer.width, buffer.height)
      renderer.graph.render(
        {
          ...renderer.input,
          edit: { ...renderer.input.edit, ...edit },
          // The display transform off, so the measurement is in linear working
          // space. A tone-mapped reading would compress exactly the values this
          // test is about.
          view: { ...renderer.input.view, toneMap: false, gamutCompress: false, ...view },
        },
        {
          resolution: [buffer.width, buffer.height] as const,
          imageSize: [source.width, source.height] as const,
          sourceRect: [0, 0, source.width, source.height] as const,
        },
        { finalTarget: target },
      )
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
      const raw = new Uint16Array(buffer.width * buffer.height * 4)
      gl.readPixels(0, 0, buffer.width, buffer.height, gl.RGBA, gl.HALF_FLOAT, raw)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      renderer.graph.pool.release(target)
      const rgb: number[] = []
      for (let i = 0; i < buffer.width * buffer.height; i++) {
        rgb.push(decodeHalf(raw[i * 4] ?? 0), decodeHalf(raw[i * 4 + 1] ?? 0), decodeHalf(raw[i * 4 + 2] ?? 0))
      }
      return { rgb, width: buffer.width, height: buffer.height }
    }, { edit, source: SOURCE, buffer, view })
  }

  test('bleeds warm light when halation is on, and does not when it is off', async ({ page }) => {
    test.setTimeout(120_000)

    const baseline = await render(page, OFF)
    const plain = await render(page, STAMP)
    const halated = await render(page, { ...STAMP, ...HALATION })

    // The region the bleed must appear in: near the stamp, but NOT lit by it.
    // "Not lit" is taken from the render rather than from the geometry — a pixel
    // the unhalated stamp left bit-identical to the baseline is a pixel no
    // segment covers, and that is exactly the population whose only possible
    // source of light is scattering.
    const index = (x: number, y: number): number =>
      ((SOURCE.height - 1 - y) * SOURCE.width + x) * 3
    const reach = Math.round(HALATION.halationRadius * Math.hypot(SOURCE.width, SOURCE.height))
    const ring: number[] = []
    for (let y = Math.max(0, Math.round(BOX.top) - reach); y < Math.min(SOURCE.height, Math.round(BOX.bottom) + reach); y++) {
      for (let x = Math.max(0, Math.round(BOX.left) - reach); x < Math.min(SOURCE.width, Math.round(BOX.right) + reach); x++) {
        const i = index(x, y)
        const unlit =
          plain.rgb[i] === baseline.rgb[i] &&
          plain.rgb[i + 1] === baseline.rgb[i + 1] &&
          plain.rgb[i + 2] === baseline.rgb[i + 2]
        if (unlit) ring.push(i)
      }
    }

    // Non-vacuity, as a count and before anything is concluded from the ring.
    // A ring of four pixels would satisfy every assertion below and mean nothing.
    expect(ring.length, 'no unlit pixels near the stamp to measure bleed on').toBeGreaterThan(2000)

    // THE HALF THAT MUST BE ZERO. With halation off the stamp adds light to the
    // pixels its segments cover and to no others, so this is exact rather than
    // within a tolerance — it is the same population the ring was defined by.
    for (const i of ring) {
      expect(plain.rgb[i], `an unlit pixel moved with halation off`).toBe(baseline.rgb[i])
    }

    // THE HALF THAT MUST NOT BE. Every one of those pixels is now receiving
    // light that came from the stamp, scattered off the film base, which can
    // only happen if the stamp reached the emulsion before halation did.
    let raised = 0
    let warmth = 0
    for (const i of ring) {
      if (halated.rgb[i]! > baseline.rgb[i]! + 1e-4) raised++
      warmth +=
        halated.rgb[i]! - baseline.rgb[i]! - (halated.rgb[i + 2]! - baseline.rgb[i + 2]!)
    }
    const fraction = raised / ring.length
    process.stdout.write(
      `\n  ${raised} of ${ring.length} unlit pixels near the stamp were raised by halation ` +
        `(${(fraction * 100).toFixed(1)}%)\n`,
    )
    expect(
      fraction,
      'halation added nothing around the stamp, so the stamp is not upstream of it',
    ).toBeGreaterThan(0.5)

    // And it is warm, which is the other half of looking right: the scattered
    // light carries the LED's own colour, so red gains more than blue.
    expect(warmth / ring.length, 'the bleed is not warmer than it is cool').toBeGreaterThan(0)
  })

  test('is developed by the characteristic curves, not painted over them', async ({ page }) => {
    test.setTimeout(120_000)

    // The second thing the injection point buys. A stock's curves act on the
    // stamp's own pixels, so the same stamp on two stocks is not the same
    // orange — which is what it means for it to be recorded on film rather than
    // drawn on a photograph.
    const stock = STOCK_PRESETS[0]!
    const withCurves = { ...STAMP, ...(stock.patch as Record<string, number>), filmStrength: 1 }
    const withoutCurves = { ...withCurves, filmStrength: 0 }

    const a = await render(page, withCurves)
    const b = await render(page, withoutCurves)

    const index = (x: number, y: number): number =>
      ((SOURCE.height - 1 - y) * SOURCE.width + x) * 3
    let moved = 0
    let counted = 0
    for (let y = Math.round(BOX.top); y < Math.round(BOX.bottom); y++) {
      for (let x = Math.round(BOX.left); x < Math.round(BOX.right); x++) {
        const i = index(x, y)
        counted++
        if (Math.abs(a.rgb[i]! - b.rgb[i]!) > 1e-3) moved++
      }
    }
    process.stdout.write(
      `\n  ${stock.name}: ${moved} of ${counted} pixels in the stamp's box changed with filmStrength\n`,
    )
    expect(counted, 'the stamp box is empty').toBeGreaterThan(1000)
    expect(
      moved,
      'the film curves left the stamp untouched, so it is downstream of them',
    ).toBeGreaterThan(counted / 10)
  })

  test('reports the buffer size below which the segments stop resolving', async ({ page }) => {
    test.setTimeout(180_000)

    /*
     * The same question grain and halation each answered: below some buffer size
     * the preview cannot represent the feature, so it stops being a preview of
     * it. Reported rather than asserted tightly — the measured size is the
     * deliverable.
     *
     * # Why this one render uses the identity display path
     *
     * The first version of this measurement read 100% at every size down to a
     * 40-pixel buffer, where a segment is a ninth of a pixel across. That was
     * not the stamp surviving; it was the metric saturating. The display pass
     * encodes to sRGB and clamps at 1.0, and the stamp's radiance is 4.0, so
     * even a pixel with half the coverage still clipped to white and the peak
     * read identical everywhere.
     *
     * A measurement whose value cannot move is worth nothing whatever it
     * reports, and it passed its own assertion while doing it. `identity` drops
     * the tone map, the gamut compressor and the clamp, so the half-float target
     * carries a value that is free to fall.
     *
     * It is not raw working space, though, and the difference matters here. What
     * it leaves is the matrix into display primaries and the sRGB encode —
     * verified rather than assumed: the full-resolution peak reads 2.172, and
     * encoding the AP1-to-sRGB red row applied to `4 * [1, 0.32, 0.12]` gives
     * 2.1684, which is that value to half-float precision.
     *
     * The encode is a power function, so ratios taken on it are not ratios of
     * light — half the coverage reads as 74% of the peak, and a floor defined on
     * that would be a statement about sRGB rather than about the stamp. So the
     * decode is applied first. The matrix that remains is linear, and a ratio is
     * blind to it.
     */
    const DEBUG_VIEW = { displayMode: 'identity' }

    const peak = (frame: { rgb: number[] }): number => {
      // A loop, not `Math.max(...rgb)`: the full frame is 921,600 values and
      // spreading it into an argument list overflows the stack.
      let best = -Infinity
      for (const v of frame.rgb) if (v > best) best = v
      return srgbEotf(best)
    }

    const full = await render(page, STAMP, SOURCE, DEBUG_VIEW)
    const reference = peak(full)
    // Non-vacuity, before any ratio below is believed: the full-resolution stamp
    // has to actually reach the radiance it was set to, or every ratio is a
    // fraction of nothing.
    // In display primaries the stamp's red is 5.98 at full coverage. Anything
    // near that says the segments are fully formed at full resolution, which is
    // what every ratio below is a fraction of.
    expect(reference, 'the stamp did not reach full coverage at full resolution').toBeGreaterThan(5)

    /*
     * Two statistics were tried. The second is reported and the first is not,
     * and the reason is worth keeping because it is the occupancy rule wearing a
     * different hat.
     *
     * A **resolved fraction** — how much of the stamp's bounding box reaches half
     * the full radiance — looked like the principled choice. It is not. It read
     * 24, 18, 36, 22, 0 percent down the sizes below, *rising* at a buffer four
     * times coarser than full. The reason is that blurring does not dim adjacent
     * segments, it merges them: two bars a gap apart become one wider bar that
     * still clears any brightness threshold easily. So the statistic measures
     * whether light survived, which it does, and not whether structure did,
     * which is the question.
     *
     * The **peak** is what is reported. It is phase-noisy in the middle of the
     * range — the brightest single pixel depends on whether a pixel centre lands
     * on a segment centre — so the assertion is on the ends, where the
     * separation is unambiguous, and the middle is printed rather than trusted.
     */
    const rows: string[] = []
    let smallest = 1
    for (const divisor of [1, 2, 4, 8, 16]) {
      const buffer = {
        width: Math.round(SOURCE.width / divisor),
        height: Math.round(SOURCE.height / divisor),
      }
      const frame = await render(page, STAMP, buffer, DEBUG_VIEW)
      const ratio = peak(frame) / reference
      smallest = ratio
      rows.push(
        `    ${String(buffer.width).padStart(4)}px buffer  ` +
          `segment ${(THINNEST_FEATURE * DATE_STAMP_HEIGHT * buffer.width).toFixed(2)}px  ` +
          `peak ${(ratio * 100).toFixed(0)}% of full`,
      )
    }
    process.stdout.write(
      `\n  the date stamp against buffer size (identity display, unclamped):\n` +
        `${rows.join('\n')}\n` +
        `  one buffer pixel per segment at ${bufferEdgeForFeature(1).toFixed(0)}px on the long edge\n` +
        `  at the 2048px interactive proxy a segment is ` +
        `${(THINNEST_FEATURE * DATE_STAMP_HEIGHT * 2048).toFixed(1)}px\n`,
    )

    // The amplitude must fall once the segment is well under a buffer pixel, or
    // the measurement is not measuring the thing it names. At the smallest size
    // a segment is a ninth of a pixel across.
    expect(smallest, 'the stamp kept its full amplitude at a segment of 0.11px').toBeLessThan(0.6)

    // At the interactive proxy — 2048 on the long edge — the thinnest feature is
    // nearly six buffer pixels, so the preview represents the stamp faithfully
    // and this is not a parameter that has to be judged in the 1:1 inspector the
    // way grain does. That is the useful conclusion, and it is why the floor is
    // reported rather than guarded tightly.
    expect(THINNEST_FEATURE * DATE_STAMP_HEIGHT * 2048).toBeGreaterThan(5)
    // The geometric floor: 350 pixels on the long edge, which is smaller than
    // any buffer this renderer uses, the drag proxy included.
    expect(bufferEdgeForFeature(1)).toBeLessThan(400)
  })
})
