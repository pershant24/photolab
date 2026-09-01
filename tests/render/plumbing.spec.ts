import { expect, test } from '@playwright/test'

/**
 * The render graph's structural guarantees: pass ordering, the recompile
 * boundary, buffer reuse, and the one failure that must never be silent.
 *
 * Colour correctness is not tested here — see `agreement.spec.ts`.
 */

interface RendererLike {
  graph: { compileCount: number; allocationCount: number; passIds: string[] }
  context: { gl: WebGL2RenderingContext; canvas: HTMLCanvasElement }
  setEdit(next: { exposure: number; contrast: number }): void
  setView(next: { displayMode: string }): void
  renderNow(): void
  stop(): void
}

test('a parameter change updates uniforms; only a variant change compiles', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => '__photolabRenderer' in window)

  const counts = await page.evaluate(() => {
    const renderer = (window as unknown as { __photolabRenderer: RendererLike }).__photolabRenderer
    renderer.stop()
    renderer.setView({ displayMode: 'sdr' })
    renderer.renderNow()

    const afterFirstFrame = renderer.graph.compileCount
    const allocationsAfterFirstFrame = renderer.graph.allocationCount

    for (let frame = 0; frame < 60; frame++) {
      renderer.setEdit({ exposure: -5 + (10 * frame) / 60, contrast: 1 })
      renderer.renderNow()
    }
    const afterDrag = renderer.graph.compileCount
    const allocationsAfterDrag = renderer.graph.allocationCount

    renderer.setView({ displayMode: 'identity' })
    renderer.renderNow()
    const afterVariant = renderer.graph.compileCount

    renderer.setView({ displayMode: 'sdr' })
    renderer.renderNow()
    const afterReturningToKnownVariant = renderer.graph.compileCount

    return {
      passIds: renderer.graph.passIds,
      afterFirstFrame,
      afterDrag,
      afterVariant,
      afterReturningToKnownVariant,
      allocationsAfterFirstFrame,
      allocationsAfterDrag,
      glError: renderer.context.gl.getError(),
    }
  })

  expect(counts.glError, 'gl.getError() after rendering').toBe(0)

  // Registration order in renderer.ts is deliberately shuffled, so this asserts
  // the stage sort rather than restating an array.
  expect(counts.passIds, 'passes run in physical stage order').toEqual([
    'testPattern',
    'imageSource',
    'ingest',
    'display',
  ])

  // Three passes run with no image loaded: imageSource is disabled, and a
  // disabled pass costs neither a program nor a draw.
  expect(counts.afterFirstFrame, 'one program per enabled pass').toBe(3)
  expect(counts.afterDrag, '60 frames of a moving parameter must compile nothing').toBe(3)
  expect(counts.afterVariant, 'a compile-time variant compiles exactly once').toBe(4)
  expect(counts.afterReturningToKnownVariant, 'a known variant is reused').toBe(4)

  // The chain ping-pongs through two buffers however many passes it has, and a
  // steady state allocates none: at proxy size that would be hundreds of
  // megabytes of churn a second.
  expect(counts.allocationsAfterFirstFrame).toBe(2)
  expect(counts.allocationsAfterDrag).toBe(2)
})

test('reports rather than degrades when a half-float framebuffer is unavailable', async ({
  page,
}) => {
  // The behaviour that must never be a silent fallback, asserted by actually
  // removing the extensions rather than by reading the branch. An RGBA8 fallback
  // would keep producing images and they would be quietly wrong.
  await page.addInitScript(() => {
    /* eslint-disable @typescript-eslint/unbound-method -- deliberate prototype patch */
    const real = WebGL2RenderingContext.prototype.getExtension
    /* eslint-enable @typescript-eslint/unbound-method */
    WebGL2RenderingContext.prototype.getExtension = function patched(
      this: WebGL2RenderingContext,
      name: string,
    ) {
      if (name === 'EXT_color_buffer_float' || name === 'EXT_color_buffer_half_float') return null
      return real.call(this, name) as unknown
    } as typeof WebGL2RenderingContext.prototype.getExtension
  })

  await page.goto('/')

  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('high-precision colour')
  expect(await page.evaluate(() => '__photolabRenderer' in window)).toBe(false)
})
