import { expect, test } from '@playwright/test'

/**
 * Tiled rendering, and the overlap a spatial kernel needs.
 *
 * Step 7 of the add-a-pass recipe, and halation is the first pass with a
 * non-zero overlap. A kernel reads outside the tile it writes, so each tile must
 * be expanded by the kernel's extent before rendering and cropped back
 * afterwards. Too little overlap and the kernel runs off the edge of what the
 * tile has, which shows as a seam — a visible line at every tile boundary that
 * reads like a compression artifact rather than like a bug.
 *
 * **This test carries more weight than the two-resolution one.** On a full-frame
 * render the correct radius expression and the wrong one — reading `uResolution`
 * instead of `uSourceRect` — reduce to the same value, so the two-resolution
 * test passes either way. That was measured, not assumed. Only a tile, where the
 * buffer covers part of the source rather than all of it, separates them.
 */

const SOURCE = { width: 1600, height: 1200 }
// Pinned, deliberately, rather than inherited from DEFAULT_EDIT_STATE.
//
// The tolerance below is derived assuming there is a blurred halo to compare. A
// shipping default raised above this synthetic source's peak would drive the
// measured disagreement to zero and make this test pass trivially — a test that
// passes because the effect is off is worse than no test. See tests/README.md.
const EDIT = { halationStrength: 0.8, halationThreshold: 1.2, halationRadius: 0.012 }

/** Buffer pixels per source pixel. 1:1 keeps the comparison free of resampling. */
const SCALE = 1

interface RendererLike {
  graph: {
    pool: {
      acquire(w: number, h: number): { framebuffer: unknown }
      release(t: unknown): void
    }
    render(input: unknown, context: unknown, options?: Record<string, unknown>): void
    requiredOverlap(input: unknown): number
  }
  context: { gl: WebGL2RenderingContext }
  input: { source: unknown; edit: Record<string, unknown>; view: Record<string, unknown> }
  stop(): void
}

const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  const image = context.createImageData(source.width, source.height)
  // Two smooth sources, deliberately placed so one straddles a tile boundary:
  // a halo that never crosses a seam cannot reveal a missing overlap.
  // Placed so the STEEP part of each halo crosses a tile boundary, not the peak.
  // A lamp centred exactly on a seam is nearly symmetric about it, so clamping
  // there barely changes anything — the first version put one at (0.5, 0.5) and
  // a starved overlap produced no measurable disagreement at all.
  const lamps = [
    { x: source.width * 0.5, y: source.height * 0.44, s: source.height * 0.055 },
    { x: source.width * 0.42, y: source.height * 0.5, s: source.height * 0.05 },
  ]
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      let v = 0
      for (const l of lamps) {
        const dx = x - l.x, dy = y - l.y
        v = Math.max(v, Math.exp(-(dx * dx + dy * dy) / (2 * l.s * l.s)))
      }
      const c = Math.round(14 + 241 * v)
      const i = (y * source.width + x) * 4
      image.data[i] = c; image.data[i+1] = c; image.data[i+2] = c; image.data[i+3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'lamps.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

test.describe('tiled rendering', () => {
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

  /**
   * Render the source whole, then as four tiles with the given overlap, and
   * report the largest disagreement inside the tiles' own regions.
   */
  async function compare(
    page: import('@playwright/test').Page,
    overlapOverride: number | null,
  ): Promise<{ worst: number; spread: number; declaredOverlap: number; samples: number }> {
    return page.evaluate<
      { worst: number; spread: number; declaredOverlap: number; samples: number },
      { edit: Record<string, number>; source: { width: number; height: number }; scale: number; overlapOverride: number | null }
    >(({ edit, source, scale, overlapOverride }) => {
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

      const input = {
        ...renderer.input,
        edit: { ...renderer.input.edit, ...edit },
        view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
      }
      const declaredOverlap = renderer.graph.requiredOverlap(input)
      const overlap = overlapOverride ?? declaredOverlap

      /** Render one source rect into its own buffer and read it back. */
      const renderRect = (
        rx: number, ry: number, rw: number, rh: number,
      ): { pixels: Float32Array; width: number; height: number } => {
        const width = Math.round(rw * scale)
        const height = Math.round(rh * scale)
        const target = renderer.graph.pool.acquire(width, height)
        renderer.graph.render(
          input,
          {
            resolution: [width, height] as const,
            imageSize: [source.width, source.height] as const,
            sourceRect: [rx, ry, rw, rh] as const,
          },
          { finalTarget: target },
        )
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer as WebGLFramebuffer)
        const raw = new Uint16Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, raw)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        renderer.graph.pool.release(target)
        const pixels = new Float32Array(width * height)
        for (let i = 0; i < width * height; i++) pixels[i] = decodeHalf(raw[i * 4] ?? 0)
        return { pixels, width, height }
      }

      const whole = renderRect(0, 0, source.width, source.height)
      let lo = Infinity, hi = -Infinity
      for (const v of whole.pixels) { if (v < lo) lo = v; if (v > hi) hi = v }

      const halfW = source.width / 2
      const halfH = source.height / 2
      let worst = 0
      let samples = 0

      for (const [tx, ty] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x0 = (tx ?? 0) * halfW
        const y0 = (ty ?? 0) * halfH
        // Expand by the overlap, clamped to the image.
        const ex0 = Math.max(0, x0 - overlap)
        const ey0 = Math.max(0, y0 - overlap)
        const ex1 = Math.min(source.width, x0 + halfW + overlap)
        const ey1 = Math.min(source.height, y0 + halfH + overlap)
        const tile = renderRect(ex0, ey0, ex1 - ex0, ey1 - ey0)

        // Compare the tile's own region — the part that survives the crop —
        // against the same region of the whole render. Sampled on a grid so the
        // comparison is quick and covers the seams.
        // Sampled right up to the boundary. A seam is a line AT the edge, so a
        // grid that stops short of it measures the one place the error is not.
        const STEP = 5
        for (let sy = y0; sy < y0 + halfH; sy += STEP) {
          for (let sx = x0; sx < x0 + halfW; sx += STEP) {
            // readPixels is bottom-up, so a source row maps to height - 1 - row.
            const wx = Math.round(sx * scale)
            const wy = whole.height - 1 - Math.round(sy * scale)
            const txp = Math.round((sx - ex0) * scale)
            const typ = tile.height - 1 - Math.round((sy - ey0) * scale)
            if (wx < 0 || wy < 0 || txp < 0 || typ < 0) continue
            if (wx >= whole.width || wy >= whole.height) continue
            if (txp >= tile.width || typ >= tile.height) continue
            const a = whole.pixels[wy * whole.width + wx] ?? 0
            const b = tile.pixels[typ * tile.width + txp] ?? 0
            worst = Math.max(worst, Math.abs(a - b))
            samples++
          }
        }
      }

      return { worst, spread: hi - lo, declaredOverlap, samples }
    }, { edit: EDIT, source: SOURCE, scale: SCALE, overlapOverride })
  }

  test('four tiles with the declared overlap match the whole frame', async ({ page }) => {
    const result = await compare(page, null)

    // The declared overlap must actually cover the kernel: radius as a fraction
    // of the long edge, in source pixels.
    const expected = Math.ceil(EDIT.halationRadius * SOURCE.width) + 1
    expect(result.declaredOverlap, 'overlap is derived from the radius').toBe(expected)

    expect(result.samples, 'the comparison must cover the tiles').toBeGreaterThan(1000)
    expect(result.spread, 'the frame must contain a halo to compare').toBeGreaterThan(0.05)

    // Half-float storage plus the rasteriser's own rounding. There is no
    // resampling term: the tiles render at 1:1 with the whole frame, so the same
    // source pixel lands on the same buffer pixel in both.
    const tolerance = 4 * 2 ** -11 * result.spread + 1e-4
    expect(
      result.worst,
      `worst disagreement ${result.worst.toExponential(2)} over ${result.samples} samples`,
    ).toBeLessThan(tolerance)
  })

  test('too little overlap shows as a seam', async ({ page }) => {
    // The mutation, kept as a test. An overlap smaller than the kernel leaves it
    // reading past the edge of what the tile has, and the error appears at the
    // boundary rather than spread through the tile — which is what makes a seam
    // a line rather than a haze.
    const good = await compare(page, null)
    const starved = await compare(page, 1)

    // Measured: the declared overlap disagrees by 4.9e-4, which is one
    // half-float step and therefore as close as the format allows; a one-pixel
    // overlap disagrees by 4.9e-3, ten times worse. In eight-bit terms that is
    // about one code value on this image — a faint seam rather than an obvious
    // one, because the part of the halo crossing the boundary here is its tail.
    // A brighter source closer to a seam produces a worse one; the mechanism is
    // the same and the factor of ten is what identifies it.
    expect(starved.worst, 'a starved overlap must disagree').toBeGreaterThan(good.worst * 5)
    expect(starved.worst).toBeGreaterThan(2e-3)
  })
})
