import { expect, test } from '@playwright/test'

/**
 * The lens stage against tiling, at a scale other than 1:1.
 *
 * Three of these four passes move pixels or read neighbours, and the fourth reads
 * its own position in the full frame. All four are therefore wrong in a way that
 * is **invisible on a full-frame render and appears on export**, which is the
 * failure `uSourceRect` exists for.
 *
 * Every comparison here varies origin **and** scale together, per the rule the
 * grain work established: a formulation can be right whenever the origin is zero
 * and right whenever the scale is one, and wrong when neither is. Running these
 * at 1:1 would leave that class untested for four new passes at once.
 */

interface RendererLike {
  stop(): void
  context: { gl: WebGL2RenderingContext }
  graph: {
    pool: { acquire(w: number, h: number): { framebuffer: unknown }; release(t: unknown): void }
    render(input: unknown, viewport: unknown, options: unknown): void
    requiredOverlap(input: unknown): number
  }
  input: { edit: Record<string, unknown>; view: Record<string, unknown> }
}

const SOURCE = { width: 480, height: 360 }

/**
 * A frame with structure everywhere, including into the corners.
 *
 * Corners matter more here than anywhere before: displacement grows as the cube
 * of the radius for distortion and linearly for aberration, so a fixture with a
 * feature only in the middle would leave the largest error untested. Smooth,
 * because a hard edge resampled at two rates disagrees for reasons that are the
 * source texture's rather than the pass's.
 */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  const image = context.createImageData(source.width, source.height)
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
      const u = x / source.width, v = y / source.height
      // Broad smooth structure plus a gentle grid, so displacement is visible
      // without any hard edge to alias.
      const grid = 0.12 * (Math.sin(u * 18.0) * Math.sin(v * 14.0))
      const base = 0.25 + 0.45 * u + 0.2 * v + grid
      image.data[i] = Math.max(0, Math.min(255, Math.round(base * 255)))
      image.data[i+1] = Math.max(0, Math.min(255, Math.round((base * 0.85 + 0.08) * 255)))
      image.data[i+2] = Math.max(0, Math.min(255, Math.round((base * 0.7 + 0.15) * 255)))
      image.data[i+3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'lens.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

const OFF = {
  distortion: 0, aberration: 0, diffusionStrength: 0, vignette: 0,
  halationStrength: 0, grainStrength: 0, filmStrength: 0, exposure: 0, contrast: 1,
}

/** Each effect on its own, so a failure names one pass. */
const CASES = {
  distortion: { ...OFF, distortion: 0.18 },
  barrel: { ...OFF, distortion: -0.18 },
  aberration: { ...OFF, aberration: 0.008 },
  diffusion: { ...OFF, diffusionStrength: 0.7, diffusionRadius: 0.02 },
  vignette: { ...OFF, vignette: 0.8 },
  everything: {
    ...OFF, distortion: -0.12, aberration: 0.005,
    diffusionStrength: 0.5, diffusionRadius: 0.015, vignette: 0.6,
  },
} as const

test.describe('the lens stage under tiling', () => {
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
   * Render whole and as 2x2 tiles, both at `scale`, and report the worst
   * disagreement inside the tiles' own regions.
   */
  async function compare(
    page: import('@playwright/test').Page,
    edit: Record<string, number>,
    scale: number,
    overlapOverride: number | null = null,
  ): Promise<{ worst: number; spread: number; samples: number; overlap: number }> {
    return page.evaluate<
      { worst: number; spread: number; samples: number; overlap: number },
      {
        edit: Record<string, number>
        source: { width: number; height: number }
        scale: number
        overlapOverride: number | null
      }
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
      const declared = renderer.graph.requiredOverlap(input)
      const overlap = overlapOverride ?? declared

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
      let lo = Infinity
      let hi = -Infinity
      for (const v of whole.pixels) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }

      // The split is deliberately OFF-CENTRE, and far out.
      //
      // A 2x2 split through the middle puts every interior seam where the radius
      // is smallest, and radial displacement goes as r^3 for distortion — so the
      // seams land exactly where the effect displaces least, the declared overlap
      // never matters, and starving it to two pixels changes nothing. Measured:
      // identical disagreement at every overlap from 55 down to 2.
      //
      // The largest displacement is at the corners, and the corners sit on the
      // image boundary where every tiling clamps the same way. So a tile test for
      // a radial effect has to put its seams out where the radius is large, or it
      // measures the one region the effect cannot get wrong.
      const splitX = 400
      const splitY = 300
      const tiles = [
        [0, 0, splitX, splitY],
        [splitX, 0, source.width - splitX, splitY],
        [0, splitY, splitX, source.height - splitY],
        [splitX, splitY, source.width - splitX, source.height - splitY],
      ] as const

      let worst = 0
      let samples = 0
      for (const [x0, y0, w0, h0] of tiles) {
        const ex0 = Math.max(0, x0 - overlap)
        const ey0 = Math.max(0, y0 - overlap)
        const ex1 = Math.min(source.width, x0 + w0 + overlap)
        const ey1 = Math.min(source.height, y0 + h0 + overlap)
        const tile = renderRect(ex0, ey0, ex1 - ex0, ey1 - ey0)

        for (let sy = y0; sy < y0 + h0; sy += 3) {
          for (let sx = x0; sx < x0 + w0; sx += 3) {
            const wx = Math.round((sx + 0.5) * scale - 0.5)
            const wy = whole.height - 1 - Math.round((sy + 0.5) * scale - 0.5)
            const tx = Math.round((sx - ex0 + 0.5) * scale - 0.5)
            const ty = tile.height - 1 - Math.round((sy - ey0 + 0.5) * scale - 0.5)
            if (wx < 0 || wy < 0 || tx < 0 || ty < 0) continue
            if (wx >= whole.width || wy >= whole.height) continue
            if (tx >= tile.width || ty >= tile.height) continue
            worst = Math.max(
              worst,
              Math.abs((whole.pixels[wy * whole.width + wx] ?? 0) - (tile.pixels[ty * tile.width + tx] ?? 0)),
            )
            samples++
          }
        }
      }
      return { worst, spread: hi - lo, samples, overlap: declared }
    }, { edit, source: SOURCE, scale, overlapOverride })
  }

  /**
   * Derived, not tuned.
   *
   * The two renders sample the same field at the same rate but from different
   * origins, so the disagreement is bilinear interpolation landing on different
   * sub-texel positions — first order in the sampling offset, which rounding
   * bounds at half a buffer pixel. Against a frame whose own dynamic range is the
   * spread, and with the half-float floor added.
   */
  const tolerance = (spread: number): number => 0.02 * spread + 2 ** -10

  for (const [name, edit] of Object.entries(CASES)) {
    test(`${name} tiles at 2:1 the same as it renders whole`, async ({ page }) => {
      const result = await compare(page, edit, 2)
      expect(result.samples).toBeGreaterThan(5_000)
      // Not vacuous: the effect has to be doing something to the frame.
      expect(result.spread, 'the frame is flat, so nothing is being compared').toBeGreaterThan(0.05)
      expect(
        result.worst,
        `worst ${result.worst.toExponential(2)} over ${result.samples} samples, overlap ${result.overlap}px`,
      ).toBeLessThan(tolerance(result.spread))
    })
  }

  test('declares an overlap large enough, and starving it shows', async ({ page }) => {
    // The overlap is a function of the parameter and the frame diagonal rather
    // than a constant, because the displacement grows with radius. Starving it
    // must produce a visible seam, or the declared value is not being relied on
    // and the test above would pass with no overlap at all.
    const edit = CASES.distortion
    const good = await compare(page, edit, 2)
    const starved = await compare(page, edit, 2, 2)

    // The declared overlap is the corner bound, 55 pixels here, and is therefore
    // conservative for seams that are not at a corner. Measured against these
    // seams: correct at 20 and above, 3.4e-2 at 8, 6.1e-2 at none. Conservative
    // is the right direction — an under-declared overlap is a seam in an export
    // and an over-declared one is wasted margin.
    expect(good.overlap, 'distortion declared no overlap').toBeGreaterThan(20)
    expect(starved.worst, 'a starved overlap must disagree').toBeGreaterThan(good.worst * 5)
    expect(starved.worst).toBeGreaterThan(tolerance(good.spread))
  })

  test('every lens pass is exactly the identity at its neutral', async ({ page }) => {
    // Bit-identical, not close. The vignette is the one to watch: its multiplier
    // is mix(1, falloff, amount), which at amount 0 is 1*(1-0) + falloff*0 and
    // returns 1 exactly. Written as 1 - amount*(1 - falloff) it would not, and
    // every unedited photograph would be very slightly darker toward the corners.
    const frame = async (edit: Record<string, number>): Promise<number[]> =>
      page.evaluate<number[], { edit: Record<string, number>; source: { width: number; height: number } }>(
        ({ edit, source }) => {
          const renderer = (window as unknown as { __photolabRenderer: RendererLike })
            .__photolabRenderer
          renderer.stop()
          const gl = renderer.context.gl
          const target = renderer.graph.pool.acquire(source.width, source.height)
          renderer.graph.render(
            {
              ...renderer.input,
              edit: { ...renderer.input.edit, ...edit },
              view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
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
          return Array.from(raw)
        },
        { edit, source: SOURCE },
      )

    const before = await frame(OFF)
    const after = await frame({
      ...OFF,
      distortion: 0, aberration: 0, diffusionStrength: 0, diffusionRadius: 0.01, vignette: 0,
    })
    expect(after).toEqual(before)
  })

  test('each effect on its own actually changes the frame', async ({ page }) => {
    // Six full-frame renders plus a baseline, which is 8 seconds locally — 27% of
    // the default 30s timeout, and this repository's CI runners have been three
    // times slower than this machine. Raised deliberately rather than left to
    // drift into a timeout, which is what the headroom reporter exists to catch.
    test.setTimeout(120_000)
    // The counterpart to the identity test, and the thing that stops all of the
    // above passing because nothing runs. A pass that was never enabled would
    // satisfy every tiling assertion perfectly.
    //
    // Counted as pixels that moved, not as a change in the frame's dynamic range:
    // a geometric pass rearranges the picture without necessarily altering its
    // minimum or maximum at all, and the first version of this measured the range
    // and reported that distortion did nothing.
    const frame = async (edit: Record<string, number>): Promise<number[]> =>
      page.evaluate<number[], { edit: Record<string, number>; source: { width: number; height: number } }>(
        ({ edit, source }) => {
          const renderer = (window as unknown as { __photolabRenderer: RendererLike })
            .__photolabRenderer
          renderer.stop()
          const gl = renderer.context.gl
          const target = renderer.graph.pool.acquire(source.width, source.height)
          renderer.graph.render(
            {
              ...renderer.input,
              edit: { ...renderer.input.edit, ...edit },
              view: { ...renderer.input.view, toneMap: false, gamutCompress: false },
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
          return Array.from(raw)
        },
        { edit, source: SOURCE },
      )

    const before = await frame(OFF)
    for (const [name, edit] of Object.entries(CASES)) {
      const after = await frame(edit)
      let moved = 0
      for (let i = 0; i < before.length; i += 4) {
        if (before[i] !== after[i] || before[i + 1] !== after[i + 1]) moved++
      }
      expect(moved, `${name} left the frame unchanged`).toBeGreaterThan(1000)
    }
  })
})
