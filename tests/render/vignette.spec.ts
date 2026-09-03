import { expect, test } from '@playwright/test'

import { VIGNETTE_REACH, frameRadius, vignetteMultiplier } from '../../src/core/colour/lens'

/**
 * The vignette shader against the TypeScript reference, across the frame.
 *
 * The other lens tests cover the identity and tiling. Neither would notice a
 * `cos^2` where a `cos^4` was meant: it is exactly 1 at the centre either way, it
 * is exactly the identity at zero either way, and it tiles identically either
 * way. The shape is the effect, and this is what measures it.
 *
 * Rendered on a flat frame so the falloff is the only thing varying, and read
 * back through the sRGB transfer function rather than as a ratio of encoded
 * values — a 0.36 linear multiplier reads as 0.66 encoded, which is exactly the
 * sort of number that looks like a bug in a screenshot and is not.
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

const SOURCE = { width: 300, height: 200 }
const OFF = {
  distortion: 0, aberration: 0, diffusionStrength: 0, vignette: 0,
  halationStrength: 0, grainStrength: 0, filmStrength: 0, exposure: 0, contrast: 1,
}

/** Flat mid-grey, so the vignette is the only thing that varies across the frame. */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  context.fillStyle = 'rgb(160, 160, 160)'
  context.fillRect(0, 0, source.width, source.height)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'flat.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

test.describe('the vignette shape', () => {
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

  /** The whole frame, top-down, in linear display primaries. */
  async function frame(
    page: import('@playwright/test').Page,
    edit: Record<string, number>,
  ): Promise<number[]> {
    return page.evaluate<number[], { edit: Record<string, number>; source: { width: number; height: number } }>(
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
            view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
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
        // Flipped to top-down here, so callers index in image coordinates.
        const out: number[] = []
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            out.push(decodeHalf(raw[((height - 1 - y) * width + x) * 4] ?? 0))
          }
        }
        return out
      },
      { edit, source: SOURCE },
    )
  }

  test('matches the cos^4 reference across the whole frame', async ({ page }) => {
    const AMOUNT = 0.8
    const plain = await frame(page, OFF)
    const vignetted = await frame(page, { ...OFF, vignette: AMOUNT })

    // The readback is display-encoded, so the ratio of encoded values is NOT the
    // multiplier. Linearised first — 0.36 linear reads as 0.66 encoded, and
    // comparing the encoded ratio to the reference would report a 45% error on a
    // correct vignette.
    const srgbToLinear = (v: number): number =>
      v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)

    let worst = 0
    let worstAt = ''
    let compared = 0
    for (let y = 2; y < SOURCE.height - 2; y += 3) {
      for (let x = 2; x < SOURCE.width - 2; x += 3) {
        const i = y * SOURCE.width + x
        const before = srgbToLinear(plain[i] ?? 0)
        const after = srgbToLinear(vignetted[i] ?? 0)
        if (before < 1e-3) continue
        const measured = after / before
        // Pixel centres, which is what the shader samples.
        const r = frameRadius(x + 0.5, y + 0.5, SOURCE.width, SOURCE.height)
        const expected = vignetteMultiplier(r, AMOUNT, VIGNETTE_REACH)
        const error = Math.abs(measured - expected)
        if (error > worst) { worst = error; worstAt = `(${x}, ${y}) r=${r.toFixed(3)}` }
        compared++
      }
    }

    expect(compared).toBeGreaterThan(5_000)
    // Half float carries about 11 bits and the value passes through an encode and
    // a decode, so the floor is a few times 2^-11. This is well inside that.
    expect(worst, `worst ${worst.toExponential(2)} at ${worstAt}`).toBeLessThan(0.01)
  })

  test('is weaker at the middle of an edge than at a corner', async ({ page }) => {
    // The property that separates a frame-radius vignette from one measured
    // against the half-width: on a 3:2 frame the middle of the long edge is at
    // radius 0.83 and the corner at 1.0, so the corner must be darker. A vignette
    // normalised by the half-width would put them equal.
    const plain = await frame(page, OFF)
    const vignetted = await frame(page, { ...OFF, vignette: 0.9 })
    const at = (x: number, y: number): number => {
      const i = y * SOURCE.width + x
      return (vignetted[i] ?? 0) / Math.max(plain[i] ?? 1, 1e-6)
    }
    const corner = at(2, 2)
    const midEdge = at(SOURCE.width - 3, Math.floor(SOURCE.height / 2))
    expect(corner).toBeLessThan(midEdge)
    expect(at(Math.floor(SOURCE.width / 2), Math.floor(SOURCE.height / 2))).toBeCloseTo(1, 3)
  })
})
