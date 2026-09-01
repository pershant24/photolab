import { expect, test } from '@playwright/test'

/**
 * Grain must be a function of the SOURCE coordinate, not of the buffer.
 *
 * # Why this needs tiles, and why a full-frame test cannot do it
 *
 * On a full-frame render the buffer covers the whole source, so the buffer
 * coordinate and the source coordinate differ by a constant scale and nothing
 * distinguishes seeding on one from seeding on the other. This is the same
 * degeneracy that let a wrong halation radius pass `two-resolution.spec.ts`, and
 * before that let a transposed matrix pass a round trip: **a test that only
 * exercises the degenerate case cannot detect an error that vanishes there.**
 *
 * Tiles break it. A tile's buffer origin is its own, so buffer-seeded grain draws
 * a different pattern at the same source pixel depending on which tile that pixel
 * came from — which in an export is a visible discontinuity at every tile
 * boundary, and reads as a compression artifact rather than as a bug.
 *
 * Two comparisons, because they fail differently:
 *
 * 1. Tiles against the whole frame. Catches any offset between the two.
 * 2. Two tiles with DIFFERENT origins, compared where they overlap. This is the
 *    one that cannot be satisfied by a globally shifted but internally consistent
 *    pattern — a seam-continuity check alone would accept that.
 *
 * # The tolerance
 *
 * Not zero, for the two cross-render comparisons. The source pixel is computed as
 * `rect.xy + flipped * rect.zw`, and `0 + t * 300` and `131 + t * 169` do not
 * round identically even where they are mathematically equal, so the noise
 * interpolant differs in its last bits. Buffers are RGBA16F, whose ulp at these
 * values is `2^-13`; the observed disagreement is exactly four of them.
 *
 * `2^-10` is eight ulps — headroom over what floating point can account for, and
 * still 100 times below the 0.113 that seeding on buffer coordinates produces.
 *
 * The repeatability comparison IS exact, and stays exact: it runs identical
 * arithmetic on identical inputs, so anything but zero there is a real defect.
 */

/** Eight half-float ulps at the magnitudes involved. See above. */
const CROSS_RENDER_TOLERANCE = 2 ** -10

interface RendererLike {
  stop(): void
  context: { gl: WebGL2RenderingContext }
  graph: {
    pool: { acquire(w: number, h: number): { framebuffer: unknown }; release(t: unknown): void }
    render(input: unknown, viewport: unknown, options: unknown): void
  }
  input: { edit: Record<string, unknown>; view: Record<string, unknown> }
}

const SOURCE = { width: 400, height: 300 }

/**
 * Grain at full amplitude everywhere.
 *
 * A flat middle-grey source, so the density modulation is at its peak over the
 * whole frame and any disagreement is unambiguously the grain rather than the
 * picture. `grainSize` 0.01 of a 400px long edge is a 4-pixel period, comfortably
 * above the 2-buffer-pixel band limit at 1:1, so the fade is not involved.
 */
const EDIT = { grainStrength: 1, grainSize: 0.01, halationStrength: 0, filmStrength: 0 }

/** sRGB 118 decodes to roughly middle grey. */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  context.fillStyle = 'rgb(118, 118, 118)'
  context.fillRect(0, 0, source.width, source.height)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'flat.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

test.describe('grain is deterministic in source coordinates', () => {
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
   * Render a set of source rects at 1:1 and report agreement.
   *
   * `mode` chooses which pair of renders is compared, so the two questions share
   * one readback harness rather than two copies of it.
   */
  async function measure(
    page: import('@playwright/test').Page,
    mode: 'tiles-vs-whole' | 'tile-vs-tile' | 'repeat',
  ): Promise<{ worst: number; spread: number; samples: number }> {
    return page.evaluate<
      { worst: number; spread: number; samples: number },
      {
        edit: Record<string, number>
        source: { width: number; height: number }
        mode: string
      }
    >(({ edit, source, mode }) => {
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

      /** Render one source rect at 1:1 and read back the red channel. */
      const renderRect = (
        rx: number, ry: number, rw: number, rh: number,
      ): { pixels: Float32Array; width: number; height: number } => {
        const width = Math.round(rw)
        const height = Math.round(rh)
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

      /** Value at a source pixel within a render covering `rect`. */
      const at = (
        render: { pixels: Float32Array; width: number; height: number },
        rect: readonly [number, number, number, number],
        sx: number,
        sy: number,
      ): number | null => {
        const x = Math.round(sx - rect[0])
        // readPixels is bottom-up, so a source row maps to height - 1 - row.
        const y = render.height - 1 - Math.round(sy - rect[1])
        if (x < 0 || y < 0 || x >= render.width || y >= render.height) return null
        return render.pixels[y * render.width + x] ?? null
      }

      let worst = 0
      let samples = 0
      let lo = Infinity
      let hi = -Infinity

      const note = (a: number, b: number): void => {
        worst = Math.max(worst, Math.abs(a - b))
        samples++
      }
      const spreadOf = (render: { pixels: Float32Array }): void => {
        for (const v of render.pixels) {
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }

      const WHOLE = [0, 0, source.width, source.height] as const

      if (mode === 'repeat') {
        // Same EditState, same source, twice. Grain seeded on anything that moves
        // between frames — time, a frame counter, a draw index — fails here, and
        // would take undo and export-matches-preview with it.
        const first = renderRect(WHOLE[0], WHOLE[1], WHOLE[2], WHOLE[3])
        const second = renderRect(WHOLE[0], WHOLE[1], WHOLE[2], WHOLE[3])
        spreadOf(first)
        for (let i = 0; i < first.pixels.length; i++) {
          note(first.pixels[i] ?? 0, second.pixels[i] ?? 0)
        }
        return { worst, spread: hi - lo, samples }
      }

      if (mode === 'tiles-vs-whole') {
        const whole = renderRect(WHOLE[0], WHOLE[1], WHOLE[2], WHOLE[3])
        spreadOf(whole)
        // Deliberately not halves: origins that are not multiples of the grain
        // period, so a buffer-seeded lattice lands out of phase rather than
        // coincidentally in phase.
        const tiles = [
          [0, 0, 173, 131],
          [173, 0, 227, 131],
          [0, 131, 173, 169],
          [173, 131, 227, 169],
        ] as const
        for (const rect of tiles) {
          const tile = renderRect(rect[0], rect[1], rect[2], rect[3])
          for (let sy = rect[1]; sy < rect[1] + rect[3]; sy += 3) {
            for (let sx = rect[0]; sx < rect[0] + rect[2]; sx += 3) {
              const a = at(whole, WHOLE, sx, sy)
              const b = at(tile, rect, sx, sy)
              if (a === null || b === null) continue
              note(a, b)
            }
          }
        }
        return { worst, spread: hi - lo, samples }
      }

      // tile-vs-tile: two rects with DIFFERENT origins that overlap in the
      // middle. Neither is the whole frame, so a pattern that is merely
      // self-consistent per tile cannot satisfy this.
      // Different in BOTH axes. An earlier version varied only x, and so shared
      // a y extent — which meant it shared, and could not see, a y-flip error
      // that the tiles-against-whole comparison caught immediately.
      const left = [0, 0, 250, 220] as const
      const right = [150, 80, 250, 220] as const
      const a = renderRect(left[0], left[1], left[2], left[3])
      const b = renderRect(right[0], right[1], right[2], right[3])
      spreadOf(a)
      for (let sy = 80; sy < 220; sy += 3) {
        for (let sx = 150; sx < 250; sx += 3) {
          const va = at(a, left, sx, sy)
          const vb = at(b, right, sx, sy)
          if (va === null || vb === null) continue
          note(va, vb)
        }
      }
      return { worst, spread: hi - lo, samples }
    }, { edit: EDIT, source: SOURCE, mode })
  }

  test('the grain is actually there to be measured', async ({ page }) => {
    // Guards every assertion below against the vacuity that would make them all
    // pass trivially: if grain were disabled, off-screen, or fully attenuated by
    // the band limit, a flat source would render flat and every comparison would
    // agree perfectly for the wrong reason.
    const result = await measure(page, 'repeat')
    expect(result.spread, 'a flat source rendered flat — no grain to compare').toBeGreaterThan(
      0.004,
    )
  })

  test('the same EditState renders identically twice', async ({ page }) => {
    const result = await measure(page, 'repeat')
    expect(result.samples).toBeGreaterThan(100_000)
    // Bit-identical, not merely close. Purity is not a tolerance.
    expect(result.worst).toBe(0)
  })

  test('a tile computes the same grain at a source pixel as the whole frame', async ({ page }) => {
    const result = await measure(page, 'tiles-vs-whole')
    expect(result.samples).toBeGreaterThan(10_000)
    expect(
      result.worst,
      `worst disagreement ${result.worst.toExponential(2)} over ${result.samples} samples`,
    ).toBeLessThan(CROSS_RENDER_TOLERANCE)
  })

  test('two tiles with different origins agree where they overlap', async ({ page }) => {
    const result = await measure(page, 'tile-vs-tile')
    expect(result.samples).toBeGreaterThan(1_000)
    expect(
      result.worst,
      `worst disagreement ${result.worst.toExponential(2)} over ${result.samples} samples`,
    ).toBeLessThan(CROSS_RENDER_TOLERANCE)
  })
})
