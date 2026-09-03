import { readFileSync } from 'node:fs'

import { test } from '@playwright/test'

/**
 * How to get a tile of a source larger than `MAX_TEXTURE_SIZE` onto the GPU.
 *
 * Deferred since Stage 3 and blocking now. `MAX_TEXTURE_SIZE` is 8192 on the
 * software rasteriser and 16384 on the measured Metal device, and a 60MP source
 * at 3:2 is roughly 9600x6400 — so on a meaningful share of real hardware the
 * full-resolution texture cannot be created at all. The interactive path
 * sidesteps it by decoding to proxy size. Export cannot.
 *
 * Two candidates, and the answer has to be **pixels**, not the absence of an
 * error. A sub-rect upload that silently ignores its offsets produces a texture
 * full of the wrong part of the photograph and throws nothing.
 *
 * The fixture encodes its own coordinates: red is `x mod 256`, green is
 * `y mod 256`, blue names the 256-pixel block. Any single pixel therefore
 * identifies where in the source it came from, so "did the right region land"
 * is a decidable question rather than an impression.
 */

const SOURCE = { width: 9600, height: 6400 }
const HUGE = '<scratchpad>/huge.png'

/** Tiles a 9600x6400 source needs at 2048, which is a realistic export tiling. */
const TILE = 2048

test('how to upload a tile of a source larger than MAX_TEXTURE_SIZE', async ({ page }) => {
  test.setTimeout(600_000)
  await page.goto('/')
  await page.waitForFunction(() => '__photolabRenderer' in window)

  const png = readFileSync(HUGE).toString('base64')
  await page.evaluate((data) => {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    ;(window as unknown as { __huge: Blob }).__huge = new Blob([bytes], { type: 'image/png' })
  }, png)

  const report = await page.evaluate(async ({ source, tile }) => {
    const gl = (window as unknown as {
      __photolabRenderer: { context: { gl: WebGL2RenderingContext } }
    }).__photolabRenderer.context.gl
    const blob = (window as unknown as { __huge: Blob }).__huge
    const lines: string[] = []
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    lines.push(`MAX_TEXTURE_SIZE ${maxTexture}; source ${source.width}x${source.height}`)
    lines.push(`source exceeds it: ${Math.max(source.width, source.height) > maxTexture}`)

    const memory = (): number => {
      const p = performance as unknown as { memory?: { usedJSHeapSize: number } }
      return p.memory ? p.memory.usedJSHeapSize / 1e6 : Number.NaN
    }

    /**
     * Total memory the agent attributes to this page, bitmaps included.
     *
     * `performance.memory` only sees the JS heap, and an ImageBitmap is not on
     * it — so the JS heap reading is not evidence of anything and saying so is
     * the point. This one does see it, when the page is cross-origin isolated.
     */
    const agentMemory = async (): Promise<string> => {
      const p = performance as unknown as {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>
      }
      if (!p.measureUserAgentSpecificMemory) {
        return `unavailable (crossOriginIsolated: ${String(self.crossOriginIsolated)})`
      }
      try {
        return `${((await p.measureUserAgentSpecificMemory()).bytes / 1e6).toFixed(0)} MB`
      } catch (error) {
        return `refused: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    /** Read a tile texture back and say where its top-left pixel came from. */
    const originOf = (texture: WebGLTexture, w: number, h: number): [number, number, number] => {
      const fb = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      const px = new Uint8Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fb)
      void w
      void h
      return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0]
    }

    /** What the fixture's pattern says a pixel at (x, y) should be. */
    const expected = (x: number, y: number): [number, number, number] => [
      x % 256,
      y % 256,
      (Math.floor(x / 256) * 16 + Math.floor(y / 256)) % 256,
    ]

    const tilesAcross = Math.ceil(source.width / tile)
    const tilesDown = Math.ceil(source.height / tile)
    const rects: [number, number, number, number][] = []
    for (let ty = 0; ty < tilesDown; ty++) {
      for (let tx = 0; tx < tilesAcross; tx++) {
        const x = tx * tile
        const y = ty * tile
        rects.push([x, y, Math.min(tile, source.width - x), Math.min(tile, source.height - y)])
      }
    }
    lines.push(`tiling: ${tilesAcross}x${tilesDown} = ${rects.length} tiles of ${tile}`)

    // ---------------------------------------------------------------- option 1
    // UNPACK_ROW_LENGTH / SKIP_PIXELS / SKIP_ROWS with an ImageBitmap source.
    // Needs the whole bitmap resident, which is the memory question.
    lines.push('')
    lines.push('--- option 1: pixel store parameters on a full ImageBitmap ---')
    const beforeBitmap = memory()
    const decodeStart = performance.now()
    let full: ImageBitmap | null = null
    let option1Error: string | null = null
    try {
      full = await createImageBitmap(blob)
    } catch (error) {
      option1Error = error instanceof Error ? error.message : String(error)
    }
    const decodeMs = performance.now() - decodeStart
    if (!full) {
      lines.push(`full decode FAILED: ${option1Error ?? 'unknown'}`)
    } else {
      lines.push(`full decode ${decodeMs.toFixed(0)} ms, bitmap ${full.width}x${full.height}`)
      lines.push(`  agent-reported memory holding the bitmap: ${await agentMemory()}`)
      lines.push(
        `JS heap before ${beforeBitmap.toFixed(0)} MB, after ${memory().toFixed(0)} MB ` +
          '(an ImageBitmap lives outside the JS heap, so this understates it; ' +
          `the bitmap itself is ${(source.width * source.height * 4) / 1e6} MB of RGBA)`,
      )

      let wrong = 0
      let threw: string | null = null
      const start = performance.now()
      for (const [x, y, w, h] of rects) {
        const texture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        try {
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, source.width)
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x)
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, full)
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
        } catch (error) {
          threw ??= error instanceof Error ? error.message : String(error)
        }
        const got = originOf(texture, w, h)
        const want = expected(x, y)
        if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
          if (wrong === 0) {
            lines.push(
              `  first wrong tile at source (${x}, ${y}): read [${got.join(', ')}], ` +
                `expected [${want.join(', ')}] -> that pixel is actually from ` +
                `(x mod 256 = ${got[0]}, y mod 256 = ${got[1]})`,
            )
          }
          wrong++
        }
        gl.deleteTexture(texture)
      }
      const elapsed = performance.now() - start
      lines.push(`  glError ${gl.getError()}, threw: ${threw ?? 'no'}`)
      lines.push(`  wrong tiles: ${wrong} of ${rects.length}`)
      lines.push(`  ${elapsed.toFixed(0)} ms for ${rects.length} tiles (${(elapsed / rects.length).toFixed(1)} ms each)`)
      full.close()
    }

    // ---------------------------------------------------------------- option 2
    // createImageBitmap(blob, sx, sy, sw, sh): a decode per tile, no full bitmap.
    lines.push('')
    lines.push('--- option 2: createImageBitmap with a crop rectangle ---')
    let wrong2 = 0
    const start2 = performance.now()
    for (const [x, y, w, h] of rects) {
      const bitmap = await createImageBitmap(blob, x, y, w, h)
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      const got = originOf(texture, w, h)
      const want = expected(x, y)
      if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
        if (wrong2 === 0) {
          lines.push(
            `  first wrong tile at source (${x}, ${y}): read [${got.join(', ')}], expected [${want.join(', ')}]`,
          )
        }
        wrong2++
      }
      gl.deleteTexture(texture)
      bitmap.close()
    }
    const elapsed2 = performance.now() - start2
    lines.push(`  glError ${gl.getError()}`)
    lines.push(`  wrong tiles: ${wrong2} of ${rects.length}`)
    lines.push(`  ${elapsed2.toFixed(0)} ms for ${rects.length} tiles (${(elapsed2 / rects.length).toFixed(1)} ms each)`)
    lines.push(`  peak JS heap ${memory().toFixed(0)} MB (no full-resolution bitmap is ever held)`)

    return lines.join('\n')
  }, { source: SOURCE, tile: TILE })

  console.log('PROBE\n' + report)
})
