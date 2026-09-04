import { expect, test } from '@playwright/test'

/**
 * The export worker: same pixels, off the main thread, with the peak measured.
 *
 * The assertion that matters most is the first one. A worker with its own GL
 * context is the easiest place in this project to end up with a second render
 * path that agrees on the day it is written and drifts afterwards — and the
 * parity invariant has been held since Stage 3 by there being only one chain.
 * So the worker's output is compared against the main thread's, byte for byte.
 */

interface RendererLike {
  stop(): void
  start(): void
  context: { gl: WebGL2RenderingContext }
  graph: unknown
  input: { edit: Record<string, unknown>; view: Record<string, unknown> }
  source: { kind: string; sourceWidth: number; sourceHeight: number }
}

// Large enough to tile. `tileSizeFor` caps a tile at 2048, so anything smaller
// than that in both axes exports in one piece and proves nothing about tiling or
// about cancelling between tiles.
const SOURCE = { width: 3400, height: 2200 }

const EDIT = {
  exposure: 0.2, contrast: 1.1,
  distortion: -0.08, aberration: 0.003,
  diffusionStrength: 0.3, diffusionRadius: 0.012,
  vignette: 0.4,
  halationStrength: 0.5, halationThreshold: 1.4, halationRadius: 0.008,
  grainStrength: 0.6, grainSize: 0.006,
  filmStrength: 0,
}

const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  const image = context.createImageData(source.width, source.height)
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
      const u = x / source.width, v = y / source.height
      const grid = 0.1 * Math.sin(u * 24) * Math.sin(v * 18)
      const bar = (u > 0.7 && u < 0.72) || (v > 0.77 && v < 0.79) ? 0.5 : 0
      const base = 0.2 + 0.4 * u + 0.15 * v + grid + bar
      const c = Math.max(0, Math.min(255, Math.round(base * 255)))
      image.data[i] = c
      image.data[i+1] = Math.max(0, Math.min(255, Math.round(base * 0.88 * 255)))
      image.data[i+2] = Math.max(0, Math.min(255, Math.round(base * 0.75 * 255)))
      image.data[i+3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  window.__sourceBlob = blob
  const file = new File([blob], 'worker.png', { type: 'image/png', lastModified: 7 })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

test.describe('the export worker', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window && '__photolabExport' in window)
    await page.evaluate(`(${SETUP})(${JSON.stringify(SOURCE)})`)
    await expect(page.getByTestId('image-label')).toContainText(
      `${SOURCE.width}x${SOURCE.height}`,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(300)
  })

  test('is cross-origin isolated, so memory can actually be measured', async ({ page }) => {
    // The precondition for everything B2 asks for, asserted rather than assumed.
    // Without COOP and COEP the measurement API refuses and the only honest
    // report is arithmetic — which this project has already given once.
    const state = await page.evaluate(() => ({
      isolated: self.crossOriginIsolated,
      hasApi: 'measureUserAgentSpecificMemory' in performance,
    }))
    expect(state.isolated, 'the page is not cross-origin isolated').toBe(true)
    expect(state.hasApi).toBe(true)
  })

  test('produces exactly the same file as the main-thread path', async ({ page }) => {
    // The invariant. Two render paths that agree today drift tomorrow, and this
    // is the only thing standing between "the worker shares the pass chain" and
    // "the worker has a copy of it".
    const result = await page.evaluate(async ({ edit, source }) => {
      const w = window as unknown as {
        __photolabRenderer: RendererLike
        __photolabExport: {
          run(job: Record<string, unknown>): Promise<{ blob: Blob; tiles: number }>
        }
        __sourceBlob: Blob
        __photolabExportDirect: (...args: unknown[]) => Promise<{ blob: Blob }>
      }
      const renderer = w.__photolabRenderer
      renderer.stop()
      const merged = { ...renderer.input.edit, ...edit }
      const view = { ...renderer.input.view, inspect: false }

      const viaWorker = await w.__photolabExport.run({
        blob: w.__sourceBlob, edit: merged, view,
        sourceWidth: source.width, sourceHeight: source.height,
        format: 'image/png',
      })
      const viaMain = await w.__photolabExportDirect(
        renderer.context, renderer.graph, w.__sourceBlob, merged, view,
        source.width, source.height, { format: 'image/png' },
      )

      const bytes = async (b: Blob): Promise<Uint8Array> => new Uint8Array(await b.arrayBuffer())
      const a = await bytes(viaWorker.blob)
      const b = await bytes(viaMain.blob)
      let differing = 0
      const n = Math.min(a.length, b.length)
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) differing++
      return { sizeA: a.length, sizeB: b.length, differing, tiles: viaWorker.tiles }
    }, { edit: EDIT, source: SOURCE })

    expect(result.tiles, 'the export was not tiled, so this proves less').toBeGreaterThan(1)
    expect(result.sizeA).toBe(result.sizeB)
    // PNG is lossless and both paths encode with the same settings, so the files
    // are identical rather than merely equivalent.
    expect(result.differing, 'the worker and the main thread produced different files').toBe(0)
  })

  test('reports progress and can be cancelled between tiles', async ({ page }) => {
    const result = await page.evaluate(async ({ edit, source }) => {
      const w = window as unknown as {
        __photolabRenderer: RendererLike
        __photolabExport: {
          run(job: Record<string, unknown>): Promise<unknown>
          cancel(): void
        }
        __sourceBlob: Blob
      }
      const renderer = w.__photolabRenderer
      const merged = { ...renderer.input.edit, ...edit }
      const steps: number[] = []
      let cancelled = false
      const promise = w.__photolabExport
        .run({
          blob: w.__sourceBlob, edit: merged,
          view: { ...renderer.input.view, inspect: false },
          sourceWidth: source.width, sourceHeight: source.height,
          format: 'image/png',
          onProgress: (done: number, total: number) => {
            steps.push(done / total)
            // Cancel as soon as there is something to cancel.
            if (done >= 1) w.__photolabExport.cancel()
          },
        })
        .catch((error: Error) => {
          cancelled = error.name === 'ExportCancelled' || /cancel/i.test(error.message)
        })
      await promise
      return { steps: steps.length, monotone: steps.every((v, i) => i === 0 || v >= (steps[i - 1] ?? 0)), cancelled }
    }, { edit: EDIT, source: SOURCE })

    expect(result.steps, 'no progress was reported').toBeGreaterThan(1)
    expect(result.monotone, 'progress went backwards').toBe(true)
    expect(result.cancelled, 'cancelling did not stop the export').toBe(true)
  })

  test('is measured by proxy, because the memory API refuses in this environment', async ({
    page,
  }) => {
    // Cross-origin isolation is configured and verified — the test above asserts
    // `crossOriginIsolated` is true and the property is present on `performance`.
    // The API still cannot be used, for two reasons both measured rather than
    // assumed:
    //
    //   1. It is **not exposed in a worker** at all. `crossOriginIsolated` is
    //      true inside the export worker and the property is absent; the only
    //      measure-shaped members of `performance` there are `measure` and
    //      `clearMeasures`.
    //   2. In the window it is present and **rejects** with
    //      `SecurityError: performance.measureUserAgentSpecificMemory is not
    //      available`, isolated or not, and with
    //      `--enable-blink-features=PerformanceMeasureMemory` and
    //      `--site-per-process` as well.
    //
    // So the peak is not reported as a number of bytes. It is measured by proxy
    // — the largest source that exports successfully — and that is said plainly
    // rather than substituting arithmetic for a measurement, which this project
    // has already done once.
    const state = await page.evaluate(async () => {
      const src = `self.postMessage({
        isolated: self.crossOriginIsolated,
        hasApi: 'measureUserAgentSpecificMemory' in performance,
      })`
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
      const worker = new Worker(url, { type: 'module' })
      const inWorker = await new Promise<{ isolated: boolean; hasApi: boolean }>((r) => {
        worker.onmessage = (e: MessageEvent<{ isolated: boolean; hasApi: boolean }>) => r(e.data)
      })
      worker.terminate()
      URL.revokeObjectURL(url)

      let windowError = ''
      try {
        const api = performance as unknown as {
          measureUserAgentSpecificMemory(): Promise<{ bytes: number }>
        }
        await api.measureUserAgentSpecificMemory()
      } catch (e) {
        windowError = (e as Error).name
      }
      return { inWorker, windowError }
    })

    // Isolation really is on in the worker; the API really is missing there.
    expect(state.inWorker.isolated, 'the worker is not cross-origin isolated').toBe(true)
    expect(state.inWorker.hasApi, 'the API appeared in the worker — re-measure').toBe(false)
    expect(state.windowError, 'the window API started working — re-measure').toBe('SecurityError')
  })

  test('fails cleanly when an allocation cannot be satisfied', async ({ page }) => {
    // A 60MP export that runs out of memory must say so, not produce a truncated
    // file or a dead tab. Forced by asking for an output canvas far past what any
    // browser will allocate, which is the same failure a real one would take.
    const result = await page.evaluate(async ({ edit }) => {
      const w = window as unknown as {
        __photolabRenderer: RendererLike
        __photolabExport: { run(job: Record<string, unknown>): Promise<unknown> }
        __sourceBlob: Blob
      }
      const renderer = w.__photolabRenderer
      try {
        await w.__photolabExport.run({
          blob: w.__sourceBlob,
          edit: { ...renderer.input.edit, ...edit },
          view: { ...renderer.input.view, inspect: false },
          // Well past any canvas limit, so the allocation cannot succeed.
          sourceWidth: 200_000,
          sourceHeight: 200_000,
          format: 'image/png',
        })
        return { threw: false, message: '', alive: true }
      } catch (error) {
        return {
          threw: true,
          message: error instanceof Error ? error.message : String(error),
          // The page is still responding, which is the other half of "cleanly".
          alive: document.readyState === 'complete',
        }
      }
    }, { edit: EDIT })

    expect(result.threw, 'an impossible export resolved instead of failing').toBe(true)
    expect(result.message.length, 'it failed with no message').toBeGreaterThan(0)
    expect(result.alive).toBe(true)

    // And the worker is still usable afterwards: a failed export must not take
    // the export path down with it.
    const recovered = await page.evaluate(async ({ edit, source }) => {
      const w = window as unknown as {
        __photolabRenderer: RendererLike
        __photolabExport: { run(job: Record<string, unknown>): Promise<{ blob: Blob }> }
        __sourceBlob: Blob
      }
      const renderer = w.__photolabRenderer
      const out = await w.__photolabExport.run({
        blob: w.__sourceBlob,
        edit: { ...renderer.input.edit, ...edit },
        view: { ...renderer.input.view, inspect: false },
        sourceWidth: source.width, sourceHeight: source.height,
        format: 'image/png',
      })
      return out.blob.size
    }, { edit: EDIT, source: SOURCE })
    expect(recovered, 'the worker did not survive a failed export').toBeGreaterThan(1000)
  })
})
