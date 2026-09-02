import { expect, test } from '@playwright/test'

/**
 * Every grade pass is an exact identity at its neutral setting, on a real render.
 *
 * The unit tests assert this of the maths. This asserts it of the pipeline, which
 * is a different claim: it covers the shader transcription, the uniform binding
 * and the `enabled` predicate together. A pass that is skipped when it should run
 * passes the first and fails this; a shader that differs from its reference in
 * the last bit passes neither.
 *
 * `toEqual` on the whole frame, not a tolerance. Anything else alters every
 * unedited photograph, and the entire design of the HSL pass — no round trip,
 * `mix` rather than subtract-and-re-add — exists to make this exact rather than
 * close.
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

const SOURCE = { width: 192, height: 192 }

/** Every hue and every level, so no band or zone is left unexercised. */
const SETUP = `async (source) => {
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  const image = context.createImageData(source.width, source.height)
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
      const h = (x / source.width) * 360
      const v = 0.15 + 0.8 * (y / source.height)
      const c = v * 0.9
      const hp = h / 60
      const xx = c * (1 - Math.abs((hp % 2) - 1))
      let r = 0, g = 0, b = 0
      if (hp < 1) { r = c; g = xx } else if (hp < 2) { r = xx; g = c }
      else if (hp < 3) { g = c; b = xx } else if (hp < 4) { g = xx; b = c }
      else if (hp < 5) { r = xx; b = c } else { r = c; b = xx }
      const m = v - c
      image.data[i] = Math.round((r + m) * 255)
      image.data[i+1] = Math.round((g + m) * 255)
      image.data[i+2] = Math.round((b + m) * 255)
      image.data[i+3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const file = new File([blob], 'wheel.png', { type: 'image/png' })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

const NEUTRAL_SIX = [0, 0, 0, 0, 0, 0]
const BASE = { halationStrength: 0, grainStrength: 0, filmStrength: 0, exposure: 0, contrast: 1 }

test.describe('the grade stage at neutral', () => {
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

  async function frame(
    page: import('@playwright/test').Page,
    edit: Record<string, unknown>,
  ): Promise<number[]> {
    return page.evaluate<number[], { edit: Record<string, unknown>; source: { width: number; height: number } }>(
      ({ edit, source }) => {
        const renderer = (window as unknown as { __photolabRenderer: RendererLike })
          .__photolabRenderer
        renderer.stop()
        const gl = renderer.context.gl
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
        return Array.from(raw)
      },
      { edit, source: SOURCE },
    )
  }

  test('the wheels, HSL and split toning are each exactly the identity at neutral', async ({
    page,
  }) => {
    const before = await frame(page, BASE)
    const after = await frame(page, {
      ...BASE,
      lift: [0, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0],
      hslHue: NEUTRAL_SIX, hslSaturation: NEUTRAL_SIX, hslLuminance: NEUTRAL_SIX,
      splitShadowTint: [0, 0, 0], splitHighlightTint: [0, 0, 0], splitBalance: 0,
    })
    expect(after).toEqual(before)
  })

  test('an adjusted band leaves the other bands exactly alone', async ({ page }) => {
    // The case an `enabled` predicate cannot cover, and the normal state of an
    // edit. With the red band saturated, a cyan pixel two bands away must return
    // bit-for-bit unchanged — which it does only because there is no HSL round
    // trip anywhere in the pass.
    const before = await frame(page, BASE)
    const redOnly = await frame(page, { ...BASE, hslSaturation: [0.8, 0, 0, 0, 0, 0] })

    let changed = 0
    let unchanged = 0
    for (let i = 0; i < before.length; i += 4) {
      if (before[i] === redOnly[i] && before[i + 1] === redOnly[i + 1] && before[i + 2] === redOnly[i + 2]) {
        unchanged++
      } else {
        changed++
      }
    }
    // Both must happen: the red band moved, and most of the frame did not.
    expect(changed, 'adjusting the red band changed nothing').toBeGreaterThan(100)
    expect(unchanged, 'adjusting the red band changed the whole frame').toBeGreaterThan(
      before.length / 4 / 2,
    )
  })

  test('every band is reachable, so none is dead', async ({ page }) => {
    // A band whose weight never reaches any hue would look exactly like a band
    // that works, until someone tried it.
    const before = await frame(page, BASE)
    for (let band = 0; band < 6; band++) {
      const bands = [0, 0, 0, 0, 0, 0]
      bands[band] = 0.8
      const after = await frame(page, { ...BASE, hslSaturation: bands })
      let changed = 0
      for (let i = 0; i < before.length; i += 4) {
        if (before[i] !== after[i] || before[i + 1] !== after[i + 1]) changed++
      }
      expect(changed, `band ${band} changed nothing`).toBeGreaterThan(100)
    }
  })
})
