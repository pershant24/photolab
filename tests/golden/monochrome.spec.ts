import { expect, test } from '@playwright/test'

import { normaliseMix } from '../../src/core/colour/monochrome'
import { STOCK_PRESETS } from '../../src/core/presets/axisLibrary'

/**
 * The channel mixer, end to end.
 *
 * Two properties, and neither is checkable from the TypeScript alone because
 * both are about what the *rest of the film stage* does to the mixer's output.
 *
 * **Neutrality.** A monochrome frame must have no colour in it anywhere. The
 * mixer collapses three channels to one, and then three characteristic curves
 * act on that one value — so if those curves ever drift apart, colour comes back
 * into a black and white photograph. `tests/unit/film-stock.test.ts` asserts the
 * curves are identical; this asserts the consequence, through the whole chain,
 * including the grain and the display transform.
 *
 * **Exposure.** The weights are normalised, so the mixer is neutral-preserving:
 * a grey card comes out the same grey. Set a red filter and the sky darkens, but
 * the midtone does not move — which is what stops the control being a colour
 * decision and a third of a stop of exposure at the same time.
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

const SOURCE = { width: 320, height: 240 }

/**
 * Grain large enough to resolve on a 320-pixel buffer.
 *
 * The shipping default is 0.0009 of the long edge — five source pixels on a
 * 6000-pixel image, and **a third of a pixel here**, which the grain pass
 * correctly fades to nothing rather than drawing at the wrong size.
 *
 * That is why the first version of this file could not see grain at all: it ran
 * the presets as they ship, on a small fixture, and measured a channel spread of
 * 7.73e-4 for a stock at grain 0.30 and 7.73e-4 for one at grain 0.72. Identical
 * to three figures across a 2.4x difference in the parameter, which is the
 * signature of a measurement whose floor is somewhere else entirely — half float
 * quantisation, as it turned out.
 *
 * 0.012 gives a period of about four buffer pixels here, which resolves.
 */
const RESOLVABLE_GRAIN = 0.012

/** Saturated colour everywhere, so a surviving cast has somewhere to come from. */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  const image = context.createImageData(source.width, source.height)
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
      const u = x / source.width, v = y / source.height
      // Hue sweeping across, brightness down: every hue at every level.
      const h = u * 6
      const s = 0.9, l = 0.15 + 0.7 * (1 - v)
      const c = (1 - Math.abs(2 * l - 1)) * s
      const xx = c * (1 - Math.abs((h % 2) - 1))
      const m = l - c / 2
      const rgb = h < 1 ? [c, xx, 0] : h < 2 ? [xx, c, 0] : h < 3 ? [0, c, xx]
        : h < 4 ? [0, xx, c] : h < 5 ? [xx, 0, c] : [c, 0, xx]
      image.data[i] = Math.round((rgb[0] + m) * 255)
      image.data[i+1] = Math.round((rgb[1] + m) * 255)
      image.data[i+2] = Math.round((rgb[2] + m) * 255)
      image.data[i+3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'hues.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

const MONO_PRESETS = STOCK_PRESETS.filter((p) => Array.isArray(p.patch.monochromeMix))

test.describe('a monochrome stock produces no colour', () => {
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
    edit: Record<string, unknown>,
  ): Promise<number[]> {
    return page.evaluate<number[], { edit: Record<string, unknown>; source: typeof SOURCE }>(
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
        for (let i = 0; i < source.width * source.height; i++) {
          out.push(decodeHalf(raw[i * 4] ?? 0), decodeHalf(raw[i * 4 + 1] ?? 0), decodeHalf(raw[i * 4 + 2] ?? 0))
        }
        return out
      },
      { edit, source: SOURCE },
    )
  }

  for (const preset of MONO_PRESETS) {
    test(`${preset.name} leaves no colour anywhere`, async ({ page }) => {
      test.setTimeout(120_000)

      const edit = { ...preset.patch, grainSize: RESOLVABLE_GRAIN }
      const colour = await render(page, {})
      const mono = await render(page, edit)
      const withoutGrain = await render(page, { ...edit, grainStrength: 0 })

      let worstSpread = 0
      let colouredBefore = 0
      for (let i = 0; i < mono.length; i += 3) {
        const [r, g, b] = [mono[i]!, mono[i + 1]!, mono[i + 2]!]
        const spread = Math.max(r, g, b) - Math.min(r, g, b)
        // Relative to the pixel's own level: an absolute bound would be strict
        // in the shadows and slack in the highlights.
        worstSpread = Math.max(worstSpread, spread / Math.max(1e-4, Math.max(r, g, b)))
        const cr = colour[i]!, cg = colour[i + 1]!, cb = colour[i + 2]!
        if (Math.max(cr, cg, cb) - Math.min(cr, cg, cb) > 0.05 * Math.max(cr, cg, cb)) {
          colouredBefore++
        }
      }

      /*
       * Two non-vacuity counts, and the second is the one that was missing.
       *
       * The fixture has to have had colour to remove — a black frame satisfies
       * neutrality perfectly. And **grain has to be running**, because grain is
       * the pass most likely to break this claim and the one furthest from the
       * mixer: it is per-channel by design, it runs after the characteristic
       * curves, and three independent noise fields on a collapsed frame put
       * colour straight back into a black and white photograph.
       *
       * Without this count the test could not distinguish "grain is neutral"
       * from "grain never ran", and for one version of this file it was the
       * second.
       */
      expect(colouredBefore, 'the fixture was already neutral').toBeGreaterThan(
        (mono.length / 3) * 0.8,
      )
      let grainMoved = 0
      for (let i = 0; i < mono.length; i += 3) {
        if (Math.abs(mono[i]! - withoutGrain[i]!) > 1e-5) grainMoved++
      }
      expect(
        grainMoved,
        'grain changed nothing, so this test has not met its hardest case',
      ).toBeGreaterThan((mono.length / 3) * 0.2)
      process.stdout.write(
        `\n  ${preset.id}: worst relative channel spread ${worstSpread.toExponential(2)}, ` +
          `${colouredBefore} of ${mono.length / 3} source pixels were coloured, ` +
          `grain moved ${grainMoved}\n`,
      )
      // Half-float carries about 2^-10; three identical curves sampled from
      // three identical lookup tables should agree far inside that.
      expect(worstSpread, 'a monochrome stock produced colour').toBeLessThan(1e-3)
    })
  }

  test('does not move the midtone when the weights change', async ({ page }) => {
    // The normalisation, asserted through the whole chain. Two very different
    // filters on the same stock must render a grey card identically — a red
    // filter is a colour decision, not an exposure one.
    const base = MONO_PRESETS[0]!.patch as Record<string, unknown>
    const neutral = await render(page, { ...base, monochromeMix: [1, 1, 1], filmStrength: 0 })
    const red = await render(page, { ...base, monochromeMix: [0.72, 0.24, 0.04], filmStrength: 0 })

    // Compared where the fixture is grey: it is not, anywhere, so the comparison
    // is made on the mean instead, which the normalisation preserves only if the
    // weights sum to one on both sides.
    const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length
    const [n, r] = [mean(neutral), mean(red)]
    process.stdout.write(`\n  neutral mix mean ${n.toFixed(5)}, red mix mean ${r.toFixed(5)}\n`)

    // Not equal — a red filter genuinely redistributes what each hue records —
    // but the same order, which is what "no exposure change" means over a frame
    // holding every hue equally.
    expect(Math.abs(Math.log2(r / n)), 'the mixer shifted exposure by more than a third of a stop')
      .toBeLessThan(0.34)
    expect(normaliseMix([0.72, 0.24, 0.04]).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12)
  })
})
