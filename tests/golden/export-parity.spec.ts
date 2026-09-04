import { expect, test } from '@playwright/test'

/**
 * Preview and export produce the same picture.
 *
 * The stage's central assertion, and the first time parity is *measured* rather
 * than maintained by construction. Every spatial pass declares an overlap and
 * every one has been tested — but always against a fixture built to exercise
 * that one pass. Export is where grain determinism across boundaries, the
 * vignette's frame position, distortion's radial overlap and two Gaussian
 * kernels all have to hold at once.
 *
 * # What is being compared, and what is deliberately not
 *
 * The reference leg renders the **whole frame at 1:1 from a full-resolution
 * texture**, not through the interactive proxy. That is the only way the
 * comparison means what it should.
 *
 * `ARCHITECTURE.md` §4 records a deviation: the proxy is produced by
 * resize-at-decode, which downsamples *encoded* 8-bit data rather than linear
 * light, so preview and export are documented as not bit-identical in fine
 * detail. Comparing against the real proxy would measure that deviation and the
 * seams together, fail for the documented reason, and say nothing about tiling.
 * Rendering both legs from the same pixels leaves tiling as the only difference,
 * which is what this test is for.
 *
 * # Scope
 *
 * Grain is pinned **above the representable limit**, per the Stage 7 D3
 * decision. Below it the preview correctly fades grain out and the export draws
 * it, and that divergence is intended rather than a defect — a parity test that
 * included it would be asserting the opposite of what was decided.
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

/** Fits inside `MAX_TEXTURE_SIZE` on both backends, so a 1:1 reference exists. */
const SOURCE = { width: 3000, height: 2000 }

/**
 * Everything at once, which is the condition export actually runs under.
 *
 * Grain at 0.004 of the long edge is 12 source pixels, comfortably above the
 * two-buffer-pixel limit at 1:1 — the scope stated above.
 */
const EVERYTHING = {
  exposure: 0.2, contrast: 1.1,
  distortion: -0.12, aberration: 0.003,
  diffusionStrength: 0.4, diffusionRadius: 0.015,
  vignette: 0.5,
  halationStrength: 0.6, halationThreshold: 1.6, halationRadius: 0.008,
  grainStrength: 0.7, grainSize: 0.004,
  filmStrength: 0,
}

/**
 * Settings that make one pass the binding overlap, so its mutation is visible.
 *
 * `requiredOverlap` is a maximum, and the contributions are wildly unequal: at
 * the settings above, distortion asks for 272 source pixels and aberration for
 * 8. Dropping aberration's contribution from the maximum would change the
 * maximum by nothing, the seam would not appear, and the mutation would look
 * like a weak test rather than an arithmetic accident. So each pass is isolated
 * and given a parameter large enough to bind.
 */
const ISOLATED: Record<string, { edit: Record<string, number>; overlap: number }> = {
  distortion: { edit: { distortion: 0.15 }, overlap: 272 },
  aberration: { edit: { aberration: 0.01 }, overlap: 20 },
  // A separable blur is two passes each declaring the same reach, so the sum
  // counts it twice — which is right: the chain genuinely needs both.
  diffusion: { edit: { diffusionStrength: 0.8, diffusionRadius: 0.04 }, overlap: 242 },
  halation: {
    // The threshold is deliberately low. At 1.2 EV nothing near the tile
    // boundary is above it, so the halo is zero exactly where the seam would be
    // and starving the overlap changed nothing — the seam-placement rule again,
    // this time about a tonal threshold rather than a radius. An effect has to
    // be present at the boundary for a boundary test to mean anything.
    edit: { halationStrength: 0.9, halationThreshold: 0.2, halationRadius: 0.03 },
    overlap: 182,
  },
}

const OFF = {
  exposure: 0, contrast: 1, distortion: 0, aberration: 0,
  diffusionStrength: 0, vignette: 0, halationStrength: 0, grainStrength: 0, filmStrength: 0,
}

/**
 * A frame with structure into the corners and a high-contrast edge off-centre.
 *
 * The edge is deliberately placed away from the frame's middle, per the
 * seam-placement rule: radial displacement goes as `r^3`, so a feature at the
 * centre is where distortion moves it least.
 */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  const image = context.createImageData(source.width, source.height)
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
      const u = x / source.width, v = y / source.height
      const grid = 0.1 * Math.sin(u * 22.0) * Math.sin(v * 16.0)
      // A bright bar at 72% across and a dark one at 78% down: high contrast at
      // large radius, where every spatial pass displaces most.
      //
      // Plus one ENDING at x = 2045, just inside the tile boundary at x = 2048.
      //
      // Lateral aberration at its maximum displaces only about 5 pixels at this
      // radius, so a starved overlap is visible only if the correct sample and
      // the clamped one land on opposite sides of an edge. For a pixel just past
      // the boundary the red channel should read x = 2042.5 and, clamped, reads
      // x = 2048 — so the edge has to fall between those two. A bar merely
      // straddling the seam puts both samples inside it and shows nothing, which
      // is what the first attempt did: 2 code values against a bar of 2.
      const seam = (u > 0.6700 && u < 0.68167) ? 0.5 : 0
      const bar = (u > 0.71 && u < 0.735) || (v > 0.775 && v < 0.795) ? 0.55 : 0
      const base = 0.2 + 0.4 * u + 0.15 * v + grid + bar + seam
      image.data[i] = Math.max(0, Math.min(255, Math.round(base * 255)))
      image.data[i+1] = Math.max(0, Math.min(255, Math.round((base * 0.88 + 0.05) * 255)))
      image.data[i+2] = Math.max(0, Math.min(255, Math.round((base * 0.75 + 0.1) * 255)))
      image.data[i+3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  window.__sourceBlob = blob
  const file = new File([blob], 'parity.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

test.describe('preview and export agree', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000)
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
    await page.evaluate(`(${SETUP})(${JSON.stringify(SOURCE)})`)
    await expect(page.getByTestId('image-label')).toContainText(
      `${SOURCE.width}x${SOURCE.height}`,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(300)
  })

  /**
   * Export, and render the same state whole at 1:1, and report the worst
   * disagreement.
   */
  async function compare(
    page: import('@playwright/test').Page,
    edit: Record<string, number>,
    overlapOverride: number | null,
  ): Promise<{ worst: number; differing: number; total: number; spread: number; overlap: number; tiles: number; hotspots: string[] }> {
    return page.evaluate<
      { worst: number; differing: number; total: number; spread: number; overlap: number; tiles: number; hotspots: string[] },
      { edit: Record<string, number>; source: { width: number; height: number }; overlapOverride: number | null }
    >(async ({ edit, source, overlapOverride }) => {
      const w = window as unknown as {
        __photolabRenderer: RendererLike
        __photolabExportDirect: (...args: unknown[]) => Promise<{ blob: Blob; overlap: number; tiles: number }>
        __sourceBlob: Blob
      }
      const renderer = w.__photolabRenderer
      renderer.stop()
      const gl = renderer.context.gl
      const view = { ...renderer.input.view, inspect: false }
      const merged = { ...renderer.input.edit, ...edit }

      // ---- the export leg
      const result = await w.__photolabExportDirect(
        renderer.context, renderer.graph, w.__sourceBlob, merged, view,
        source.width, source.height,
        { format: 'image/png', ...(overlapOverride === null ? {} : { overlap: overlapOverride }) },
      )
      const exported = await createImageBitmap(result.blob)
      const exportCanvas = new OffscreenCanvas(source.width, source.height)
      const exportContext = exportCanvas.getContext('2d')
      if (!exportContext) throw new Error('no 2d context')
      exportContext.drawImage(exported, 0, 0)
      const exportPixels = exportContext.getImageData(0, 0, source.width, source.height).data
      exported.close()

      // ---- the reference leg: the whole frame, 1:1, from a full-resolution
      // texture. NOT the interactive proxy: that would fold in the documented
      // proxy-decode gamma deviation and the comparison would stop being about
      // tiling.
      const full = await createImageBitmap(w.__sourceBlob, {
        imageOrientation: 'from-image',
        colorSpaceConversion: 'none',
      })
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, full)
      full.close()

      const target = renderer.graph.pool.acquire(source.width, source.height)
      renderer.graph.render(
        {
          source: {
            kind: 'image', texture,
            width: source.width, height: source.height,
            sourceWidth: source.width, sourceHeight: source.height,
            textureRect: [0, 0, source.width, source.height],
          },
          edit: merged,
          view,
        },
        {
          resolution: [source.width, source.height] as const,
          imageSize: [source.width, source.height] as const,
          sourceRect: [0, 0, source.width, source.height] as const,
        },
        { finalTarget: target },
      )
      gl.bindFramebuffer(gl.FRAMEBUFFER, (target as { framebuffer: WebGLFramebuffer }).framebuffer)
      const raw = new Uint16Array(source.width * source.height * 4)
      gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.HALF_FLOAT, raw)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      renderer.graph.pool.release(target)
      gl.deleteTexture(texture)

      const decodeHalf = (h: number): number => {
        const sign = h & 0x8000 ? -1 : 1
        const exponent = (h >> 10) & 0x1f
        const fraction = h & 0x3ff
        if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
        if (exponent === 31) return fraction ? NaN : sign * Infinity
        return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
      }

      // Sampled on a grid rather than every pixel: six million comparisons in a
      // page evaluate is slow enough to matter and adds nothing.
      let worst = 0
      let differing = 0
      let total = 0
      let lo = 255
      let hi = 0
      const hotspots: string[] = []
      const STEP = 3
      for (let y = 0; y < source.height; y += STEP) {
        for (let x = 0; x < source.width; x += STEP) {
          // readPixels is bottom-up; the exported canvas is top-down.
          const refIndex = ((source.height - 1 - y) * source.width + x) * 4
          const outIndex = (y * source.width + x) * 4
          const reference = Math.max(0, Math.min(255, Math.round(decodeHalf(raw[refIndex] ?? 0) * 255)))
          const got = exportPixels[outIndex] ?? 0
          if (got < lo) lo = got
          if (got > hi) hi = got
          const delta = Math.abs(reference - got)
          if (delta > worst) worst = delta
          if (delta > 2) {
            differing++
            if (hotspots.length < 25) hotspots.push(`${x},${y}:${delta}`)
          }
          total++
        }
      }
      return { worst, differing, total, spread: hi - lo, overlap: result.overlap, tiles: result.tiles, hotspots }
    }, { edit, source: SOURCE, overlapOverride })
  }

  test('a tiled export matches a whole-frame render, with everything enabled', async ({ page }) => {
    const result = await compare(page, EVERYTHING, null)

    // Not vacuous: the frame has real range and the export really was tiled.
    expect(result.spread, 'the exported frame is flat').toBeGreaterThan(80)
    expect(result.tiles, 'the export was not actually tiled').toBeGreaterThan(1)
    expect(result.total).toBeGreaterThan(200_000)

    // 8-bit code values. The export resolves through RGBA8 and the reference is
    // read as half float and quantised here, so a difference of one is rounding
    // and nothing else. Two allows for the resolve and the readback disagreeing
    // on a boundary; anything above that is a seam.
    console.log(`PARITY worst=${result.worst} differing=${result.differing}/${result.total} overlap=${result.overlap} tiles=${result.tiles}`)
    console.log('HOTSPOTS ' + result.hotspots.join(' '))
    expect(
      result.worst,
      `worst ${result.worst} code values, ${result.differing} of ${result.total} samples differ, overlap ${result.overlap}px across ${result.tiles} tiles`,
    ).toBeLessThanOrEqual(2)
  })

  test.describe('starving one pass at a time shows its seam', () => {
    for (const [name, { edit, overlap }] of Object.entries(ISOLATED)) {
      test(`${name}`, async ({ page }) => {
        // Each pass isolated and given a parameter large enough that its own
        // overlap is the binding maximum — otherwise dropping its contribution
        // changes nothing and the mutation is meaningless.
        const settings = { ...OFF, ...edit }
        const good = await compare(page, settings, null)
        expect(good.overlap, `${name} asked for a different overlap`).toBe(overlap)
        expect(good.worst, `${name} does not tile correctly to begin with`).toBeLessThanOrEqual(2)

        // Now the same export with that overlap dropped to nothing.
        const starved = await compare(page, settings, 0)
        expect(
          starved.worst,
          `${name} with no overlap: worst ${starved.worst}, ${starved.differing} samples differ`,
        ).toBeGreaterThan(2)
      })
    }
  })
})

/**
 * A source too large to render whole, which is the case export exists for.
 *
 * 9600×6400 exceeds `MAX_TEXTURE_SIZE` on the software rasteriser, so there is
 * no whole-frame reference to compare against — the texture cannot be created.
 * Two exports at **different tile sizes** put their seams in different places
 * instead, so any seam appears in one and not the other. Agreement between them
 * is evidence that neither has one.
 *
 * Separate from the suite above because it builds a 48MP fixture, which is slow
 * enough to be worth isolating from tests that run on every change.
 *
 * # What this test is for, and what it deliberately leaves to the other one
 *
 * Its distinct contribution is that the source **does not fit on the GPU** — the
 * upload path and the tiling at real scale. Whether every pass is individually
 * right under tiling is the previous test's job, and that one is stronger because
 * it has a true whole-frame reference to compare against.
 *
 * So the effect set here is trimmed: grain, distortion, aberration, the vignette
 * and one Gaussian kernel. Diffusion is dropped, being a second kernel that costs
 * three passes of ten taps per tile and adds nothing this test can see that
 * halation does not. The first version ran everything at 61MP, took 1.7 minutes
 * locally on the software rasteriser and **timed out in CI**, which is a test
 * that runs nowhere rather than a thorough one.
 */
test.describe('a source larger than MAX_TEXTURE_SIZE', () => {
  const HUGE = { width: 8448, height: 5632 }

  test('two different tilings of an oversized source agree', async ({ page }) => {
    // 331 seconds of 600 on CI — 55%, after already being trimmed from 1.7
    // minutes locally to 34. The local figure was misleading: CI runs this ten
    // times slower, not three. Raised rather than trimmed further, because what
    // is left is the part that gives the test its purpose.
    test.setTimeout(1_800_000)
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)

    const result = await page.evaluate(async ({ source, edit }) => {
      const w = window as unknown as {
        __photolabRenderer: RendererLike
        __photolabExportDirect: (...args: unknown[]) => Promise<{
          blob: Blob; overlap: number; tiles: number; uploadPath: string
        }>
      }
      const renderer = w.__photolabRenderer
      renderer.stop()
      const maxTexture = renderer.context.gl.getParameter(
        renderer.context.gl.MAX_TEXTURE_SIZE,
      ) as number

      // Built row by row so the whole 246MB of pixel data never exists at once.
      const canvas = new OffscreenCanvas(source.width, source.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      // The x-dependent terms are computed once rather than 48 million times.
      // The row loop then does three multiplies per pixel instead of two sines.
      const row = context.createImageData(source.width, 1)
      const rampX = new Float64Array(source.width)
      const gridX = new Float64Array(source.width)
      const barX = new Float64Array(source.width)
      for (let x = 0; x < source.width; x++) {
        const u = x / source.width
        rampX[x] = 0.2 + 0.4 * u
        gridX[x] = 0.1 * Math.sin(u * 40)
        barX[x] = u > 0.71 && u < 0.72 ? 0.5 : 0
      }
      for (let y = 0; y < source.height; y++) {
        const v = y / source.height
        const gridY = Math.sin(v * 30)
        const rampY = 0.15 * v
        const barY = v > 0.78 && v < 0.79 ? 0.5 : 0
        for (let x = 0; x < source.width; x++) {
          const i = x * 4
          const base = (rampX[x] ?? 0) + rampY + (gridX[x] ?? 0) * gridY + Math.max(barX[x] ?? 0, barY)
          const c = base < 0 ? 0 : base > 1 ? 255 : (base * 255) | 0
          row.data[i] = c
          row.data[i + 1] = (c * 0.88) | 0
          row.data[i + 2] = (c * 0.75) | 0
          row.data[i + 3] = 255
        }
        context.putImageData(row, 0, y)
      }
      const blob = await canvas.convertToBlob({ type: 'image/png' })

      const merged = { ...renderer.input.edit, ...edit }
      const view = { ...renderer.input.view, inspect: false }
      const run = async (tileSize: number): Promise<Uint8ClampedArray> => {
        const out = await w.__photolabExportDirect(
          renderer.context, renderer.graph, blob, merged, view,
          source.width, source.height,
          { format: 'image/png', tileSize },
        )
        const bitmap = await createImageBitmap(out.blob)
        const c = new OffscreenCanvas(source.width, source.height)
        const cx = c.getContext('2d')
        if (!cx) throw new Error('no 2d context')
        cx.drawImage(bitmap, 0, 0)
        bitmap.close()
        return cx.getImageData(0, 0, source.width, source.height).data
      }

      const a = await run(2048)
      // A different size, so the seams land somewhere else entirely.
      const b = await run(1536)

      let worst = 0
      let differing = 0
      let total = 0
      for (let y = 0; y < source.height; y += 6) {
        for (let x = 0; x < source.width; x += 6) {
          const i = (y * source.width + x) * 4
          const delta = Math.abs((a[i] ?? 0) - (b[i] ?? 0))
          if (delta > worst) worst = delta
          if (delta > 2) differing++
          total++
        }
      }
      return {
        worst, differing, total, maxTexture,
        exceeds: Math.max(source.width, source.height) > maxTexture,
      }
    }, {
      source: HUGE,
      edit: {
        distortion: -0.1, aberration: 0.004,
        // Diffusion deliberately off; see the note above.
        diffusionStrength: 0,
        vignette: 0.5,
        halationStrength: 0.6, halationThreshold: 0.6, halationRadius: 0.006,
        grainStrength: 0.7, grainSize: 0.002,
        filmStrength: 0, exposure: 0.2, contrast: 1.1,
      },
    })

    console.log(`HUGE ${JSON.stringify(result)}`)
    expect(result.total).toBeGreaterThan(1_000_000)
    // Two tilings of the same picture are the same picture. Grain is included
    // and is the strictest part: it is a hash of the source coordinate, so a
    // tiling that shifted it by one pixel would disagree everywhere at once.
    expect(
      result.worst,
      `worst ${result.worst} code values, ${result.differing} of ${result.total} samples differ`,
    ).toBeLessThanOrEqual(2)
  })
})
