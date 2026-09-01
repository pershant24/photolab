import { expect, test } from '@playwright/test'

/**
 * How long a frame of the interactive chain actually takes, at several
 * resolutions, on a 12MP source.
 *
 * A probe rather than a test: it records a measurement and asserts only that the
 * measurement happened. The number that matters is a judgement — whether the
 * drag proxy earns the complexity it costs — and that judgement needs figures
 * from the machine it will run on, not from CI.
 *
 * **The figures this produces under `npm run test:golden` are SwiftShader
 * figures.** SwiftShader is a software rasteriser; it is one to two orders of
 * magnitude slower than any GPU this application will meet, and its numbers say
 * nothing about whether a real drag holds frame rate. They are recorded because
 * a *relative* comparison across resolutions is still informative, and because a
 * sudden change in them is a signal. For an absolute answer, run this against
 * the platform's real driver.
 *
 * ## The barrier is a readback, and `gl.finish()` is not usable
 *
 * WebGL commands are queued, not executed, so timing a `render()` call measures
 * how long it took to *submit* the work — a few microseconds regardless of how
 * much work it is. Something has to force the queue to drain before the clock is
 * read.
 *
 * The obvious candidate does not work. **`gl.finish()` does not synchronise in
 * this ANGLE/SwiftShader configuration**, and it fails silently: 400 frames at
 * 2048x1536 "completed" in 1.6ms, which is 4µs for three full-screen passes over
 * three megapixels. The same 100 frames terminated by a one-pixel `readPixels`
 * took 30.5 seconds — 305ms per frame, which is a believable software-rasteriser
 * figure. Both numbers came from the same code on the same machine minutes
 * apart; the first was pure fiction produced by a barrier that was not one.
 *
 * So the barrier here is a one-pixel `readPixels`, which cannot be deferred
 * because its result is returned synchronously. It costs about 3ms on its own,
 * which is why the frame count is chosen to make each run about a second long:
 * the barrier is then under half a percent of the measurement rather than most
 * of it.
 */

interface Measurement {
  width: number
  height: number
  megapixels: number
  frames: number
  msPerFrame: number
  impliedFps: number
}

interface RendererLike {
  graph: {
    pool: { acquire(w: number, h: number): unknown; release(t: unknown): void }
    render(input: unknown, context: unknown, options?: { finalTarget?: unknown }): void
  }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement; renderer?: string; capabilities: { renderer: string } }
  input: { source: { kind: string }; edit: Record<string, unknown>; view: Record<string, unknown> }
  stop(): void
}

const SOURCE = { width: 4000, height: 3000 }

/**
 * The resolutions worth knowing about:
 * a drag proxy in a typical window, a typical canvas, the proxy budget stated in
 * CLAUDE.md, and the full source for reference.
 */
const RESOLUTIONS: readonly [number, number][] = [
  [512, 384],
  [1024, 768],
  [2048, 1536],
  [4000, 3000],
]

test('frame time across proxy resolutions on a 12MP source', async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto('/')
  await page.waitForFunction(() => '__photolabRenderer' in window)

  // A real photograph's worth of pixels, generated so no fixture is committed.
  await page.evaluate<void, { width: number; height: number }>(async ({ width, height }) => {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no 2d context')
    const gradient = context.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, '#12305f')
    gradient.addColorStop(0.5, '#c98a4b')
    gradient.addColorStop(1, '#f2eede')
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    const file = new File([blob], 'timing.jpg', { type: 'image/jpeg' })
    const input = document.querySelector<HTMLInputElement>('[data-testid="image-input"]')
    if (!input) throw new Error('no file input')
    const transfer = new DataTransfer()
    transfer.items.add(file)
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, SOURCE)

  await expect(page.getByTestId('image-label')).toContainText(
    `${SOURCE.width}x${SOURCE.height}`,
    { timeout: 60_000 },
  )

  const report = await page.evaluate<
    { renderer: string; measurements: Measurement[]; glError: number },
    { resolutions: [number, number][]; source: { width: number; height: number } }
  >(({ resolutions, source }) => {
    const renderer = (window as unknown as { __photolabRenderer: RendererLike }).__photolabRenderer
    renderer.stop()
    const gl = renderer.context.gl
    const measurements: Measurement[] = []

    for (const [width, height] of resolutions) {
      const target = renderer.graph.pool.acquire(width, height) as { framebuffer: WebGLFramebuffer }
      const context = {
        resolution: [width, height] as const,
        imageSize: [source.width, source.height] as const,
        sourceRect: [0, 0, source.width, source.height] as const,
      }
      const scratch = new Uint16Array(4)

      /** Forces the queue to drain. See the note on gl.finish() above. */
      const sync = (): void => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.HALF_FLOAT, scratch)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      }

      const frame = (exposure: number): void => {
        renderer.graph.render(
          { ...renderer.input, edit: { ...renderer.input.edit, exposure, contrast: 1 } },
          context,
          { finalTarget: target },
        )
      }

      // Warm up: the driver's first draw at a new size is not representative.
      for (let i = 0; i < 3; i++) frame(0)
      sync()

      // One timed frame, to choose a frame count that makes the run about a
      // second long. Fixed counts either take minutes on a software rasteriser
      // or measure the clock's resolution on a real GPU.
      const probeStart = performance.now()
      frame(0.1)
      sync()
      const single = Math.max(performance.now() - probeStart, 0.05)
      const frames = Math.min(200, Math.max(3, Math.round(1000 / single)))

      // The exposure moves every frame, as it would during a drag, so nothing
      // can be skipped as unchanged.
      sync()
      const start = performance.now()
      for (let i = 0; i < frames; i++) frame((i % 20) * 0.05)
      sync()
      const elapsed = performance.now() - start

      renderer.graph.pool.release(target)

      const msPerFrame = elapsed / frames
      measurements.push({
        width,
        height,
        megapixels: Number(((width * height) / 1e6).toFixed(2)),
        frames,
        msPerFrame: Number(msPerFrame.toFixed(3)),
        impliedFps: Number((1000 / msPerFrame).toFixed(1)),
      })
    }

    return {
      renderer: renderer.context.capabilities.renderer,
      measurements,
      glError: gl.getError(),
    }
  }, { resolutions: RESOLUTIONS.map(([w, h]) => [w, h]), source: SOURCE })

  const rows = report.measurements
    .map(
      (m) =>
        `  ${String(`${m.width}x${m.height}`).padEnd(11)} ${String(m.megapixels).padStart(5)} MP  ` +
        `${String(m.msPerFrame).padStart(9)} ms/frame  ${String(m.impliedFps).padStart(7)} fps  ` +
        `(${m.frames} frames)`,
    )
    .join('\n')

  console.log(
    `\nFrame time, 12MP source, ingest + display chain\n` +
      `Renderer: ${report.renderer}\n${rows}\n` +
      `  (16.7 ms/frame is the 60Hz budget)\n`,
  )

  expect(report.glError, 'gl.getError() after the measurement').toBe(0)
  for (const measurement of report.measurements) {
    expect(Number.isFinite(measurement.msPerFrame)).toBe(true)
    expect(measurement.msPerFrame).toBeGreaterThan(0)
  }
})
