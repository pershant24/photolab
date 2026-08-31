import { expect, test } from '@playwright/test'

import { PROXY_LONG_EDGE, proxySize } from '../../src/render/decodeProtocol'

/**
 * Loading a real image through the decoder, the upload and the full graph.
 *
 * The fixtures are generated in the browser rather than committed, so there are
 * no large binaries in the repository and the sizes can be chosen to sit either
 * side of the limits that matter. The 60MP case is the point of the exercise: its
 * long edge exceeds `MAX_TEXTURE_SIZE`, which is 8192 under SwiftShader and on a
 * great many integrated and mobile GPUs, so it could not be uploaded as a single
 * texture. It works because the decoder resizes before anything reaches the GPU.
 */

/** Flat blocks: JPEG is near-exact on flat areas, so colour survives the codec. */
const BLOCKS: readonly (readonly [number, number, number])[] = [
  [32, 64, 192],
  [220, 180, 60],
  [16, 16, 16],
  [240, 240, 240],
]

interface RendererLike {
  source: { kind: string; width?: number; height?: number; sourceWidth?: number; sourceHeight?: number }
  passContext(): { resolution: readonly [number, number]; imageSize: readonly [number, number]; sourceRect: readonly [number, number, number, number] }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement; capabilities: { maxTextureSize: number } }
  renderNow(available?: { width: number; height: number }): void
  stop(): void
}

async function loadGenerated(
  page: import('@playwright/test').Page,
  width: number,
  height: number,
): Promise<void> {
  await page.evaluate<void, { width: number; height: number; blocks: number[][] }>(
    async ({ width, height, blocks }) => {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      const bandHeight = height / blocks.length
      blocks.forEach((rgb, i) => {
        context.fillStyle = `rgb(${rgb[0] ?? 0}, ${rgb[1] ?? 0}, ${rgb[2] ?? 0})`
        context.fillRect(0, i * bandHeight, width, bandHeight)
      })

      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
      const file = new File([blob], `generated-${width}x${height}.jpg`, { type: 'image/jpeg' })

      const input = document.querySelector<HTMLInputElement>('[data-testid="image-input"]')
      if (!input) throw new Error('no file input')
      const transfer = new DataTransfer()
      transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { width, height, blocks: BLOCKS.map((b) => [...b]) },
  )

  await expect(page.getByTestId('image-label')).toContainText(`${width}x${height}`, {
    timeout: 60_000,
  })
}

test.describe('image loading', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
  })

  test('a 12MP JPEG loads, decodes to proxy size, and renders its colours', async ({ page }) => {
    await loadGenerated(page, 4000, 3000)

    const state = await page.evaluate(() => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike }).__photolabRenderer
      renderer.stop()
      renderer.renderNow()

      const gl = renderer.context.gl
      const canvas = renderer.context.canvas
      const pixel = new Uint8Array(4)
      // One sample from the middle of each of the four bands. Texture coordinates
      // are bottom-up, so band 0 (the top of the image) is at the top of the
      // readback range too once the y flip at upload is accounted for.
      const samples: number[][] = []
      for (let band = 0; band < 4; band++) {
        const y = Math.round(canvas.height * (1 - (band + 0.5) / 4))
        gl.readPixels(
          Math.round(canvas.width / 2),
          Math.min(canvas.height - 1, Math.max(0, y)),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
        )
        samples.push([pixel[0] ?? -1, pixel[1] ?? -1, pixel[2] ?? -1])
      }

      return {
        kind: renderer.source.kind,
        proxyWidth: renderer.source.width ?? -1,
        proxyHeight: renderer.source.height ?? -1,
        sourceWidth: renderer.source.sourceWidth ?? -1,
        sourceHeight: renderer.source.sourceHeight ?? -1,
        context: renderer.passContext(),
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        samples,
        glError: gl.getError(),
      }
    })

    expect(state.glError).toBe(0)
    expect(state.kind).toBe('image')

    // The proxy, not the source, is what reached the GPU.
    const expectedProxy = proxySize(4000, 3000)
    expect([state.proxyWidth, state.proxyHeight]).toEqual([expectedProxy.width, expectedProxy.height])
    expect(Math.max(state.proxyWidth, state.proxyHeight)).toBe(PROXY_LONG_EDGE)

    // uImageSize and uSourceRect carry the TRUE dimensions, not the proxy's.
    // Spatial parameters are defined against the image the user sees, and export
    // needs them; a proxy-sized uImageSize would make every spatial effect change
    // strength between preview and export.
    expect(state.sourceWidth).toBe(4000)
    expect(state.sourceHeight).toBe(3000)
    expect(state.context.imageSize).toEqual([4000, 3000])
    expect(state.context.sourceRect).toEqual([0, 0, 4000, 3000])

    // The canvas is letterboxed to the image's aspect, which is what keeps
    // buffer-to-source scaling isotropic; the graph asserts that per pass.
    expect(state.canvasWidth / state.canvasHeight).toBeCloseTo(4000 / 3000, 2)

    // Colour survives decode, upload, ingest and display. The tolerance is for
    // JPEG at quality 0.95 on flat blocks plus the 8-bit round trip.
    for (let band = 0; band < BLOCKS.length; band++) {
      const expected = BLOCKS[band]
      const actual = state.samples[band]
      expect(expected, `band ${band} fixture`).toBeDefined()
      expect(actual, `band ${band} sample`).toBeDefined()
      if (!expected || !actual) continue
      for (let c = 0; c < 3; c++) {
        expect(
          Math.abs((actual[c] ?? -1) - (expected[c] ?? -1)),
          `band ${band} channel ${'rgb'[c] ?? '?'}: expected ~${expected[c]}, got ${actual[c]}`,
        ).toBeLessThanOrEqual(4)
      }
    }
  })

  test('a source whose long edge exceeds MAX_TEXTURE_SIZE loads anyway', async ({ page }) => {
    // 9504x6336 is 60MP at 3:2, the largest input this project accepts. Its long
    // edge is above the 8192 limit SwiftShader reports, so uploading it whole
    // would fail. Decoding straight to proxy size means the oversized texture is
    // never created, and the limit is never reached.
    const limit = await page.evaluate(
      () => (window as unknown as { __photolabRenderer: RendererLike }).__photolabRenderer.context
        .capabilities.maxTextureSize,
    )
    expect(limit, 'the guard is only meaningful if the limit is genuinely below the source')
      .toBeLessThan(9504)

    await loadGenerated(page, 9504, 6336)

    const state = await page.evaluate(() => {
      const renderer = (window as unknown as { __photolabRenderer: RendererLike }).__photolabRenderer
      renderer.stop()
      renderer.renderNow()
      return {
        kind: renderer.source.kind,
        proxyWidth: renderer.source.width ?? -1,
        proxyHeight: renderer.source.height ?? -1,
        context: renderer.passContext(),
        glError: renderer.context.gl.getError(),
        maxTextureSize: renderer.context.capabilities.maxTextureSize,
      }
    })

    expect(state.glError).toBe(0)
    expect(state.kind).toBe('image')
    expect(Math.max(state.proxyWidth, state.proxyHeight)).toBe(PROXY_LONG_EDGE)
    expect(state.proxyWidth).toBeLessThanOrEqual(state.maxTextureSize)
    expect(state.context.imageSize).toEqual([9504, 6336])
  })

  test('reports a file it cannot decode instead of failing silently', async ({ page }) => {
    await page.evaluate(() => {
      const file = new File([new Uint8Array([1, 2, 3, 4])], 'broken.jpg', { type: 'image/jpeg' })
      const input = document.querySelector<HTMLInputElement>('[data-testid="image-input"]')
      if (!input) throw new Error('no file input')
      const transfer = new DataTransfer()
      transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await expect(page.getByTestId('load-error')).toBeVisible({ timeout: 30_000 })
    // The test pattern is still on screen: a failed load must not leave a blank
    // canvas or a half-updated state.
    expect(await page.evaluate(
      () => (window as unknown as { __photolabRenderer: RendererLike }).__photolabRenderer.source.kind,
    )).toBe('pattern')
  })
})
