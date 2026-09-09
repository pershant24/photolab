import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

import { STOCK_PRESETS } from '../../src/core/presets/axisLibrary'
import { applyAxisPreset } from '../../src/core/state/axes'
import { DEFAULT_EDIT_STATE } from '../../src/core/state/editState'

/**
 * The README's images, rendered from the shipping presets rather than by hand.
 *
 * # Why this is a test and not a script
 *
 * The Part E census quotes figures per grade, and those grades are pinned as
 * literals so that retuning the library cannot silently invalidate a published
 * table. The README images are the same class of artifact and did not get the
 * same treatment: they were rendered once, by hand, with ad-hoc settings, and
 * the presets they claim to show were retuned underneath them.
 *
 * Pinning is the wrong answer here, because the README's *purpose* is to show
 * what the application currently does. So the images regenerate from the preset
 * definitions, and staleness is a test failure rather than something someone
 * has to notice.
 *
 * # The tolerance, and why there is one
 *
 * `two-resolution.spec.ts` records why this directory avoids committed
 * reference images: they fail across SwiftShader backends and Playwright bumps
 * for reasons unrelated to any change. That argument applies here too, so this
 * does not compare pixels.
 *
 * It compares mean CIELAB ΔE, at a threshold chosen to sit between the two
 * things it must separate. Encoder and backend drift move a JPEG by well under
 * one ΔE. A preset retune moves it by 5 to 20 — measured, in the Part B tuning
 * table, where the smallest deliberate change was 4.2 and most were above 8. A
 * threshold of 2 catches every retune in that table and none of the noise.
 *
 * # Regenerating
 *
 *     UPDATE_README_IMAGES=1 npx playwright test tests/render/readme-images.spec.ts
 *
 * The source is `original.jpg` itself, which is committed. That makes the whole
 * thing self-contained: the "Original" panel in the README is the input, and the
 * three stock panels are that input through each stock preset, so the comparison
 * the README is making is exactly the one the reader sees.
 */

const DIR = 'docs/images'
const SOURCE = `${DIR}/original.jpg`
const UPDATE = process.env.UPDATE_README_IMAGES === '1'

/** Above encoder noise, far below any preset change worth making. */
const MAX_DELTA_E = 2

const TARGETS = STOCK_PRESETS.map((preset) => ({
  file: `${DIR}/${preset.id.replace(/^stock-/, '')}.jpg`,
  preset,
}))

function meanDeltaE(a: Buffer, b: Buffer): number {
  // Decoding happens in the page; this only runs on raw RGB triples.
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  const lab = (r: number, g: number, bl: number): [number, number, number] => {
    const [rl, gl, b2] = [r, g, bl].map((c) =>
      c / 255 > 0.04045 ? ((c / 255 + 0.055) / 1.055) ** 2.4 : c / 255 / 12.92,
    ) as [number, number, number]
    const X = (0.4124 * rl + 0.3576 * gl + 0.1805 * b2) / 0.95047
    const Y = 0.2126 * rl + 0.7152 * gl + 0.0722 * b2
    const Z = (0.0193 * rl + 0.1192 * gl + 0.9505 * b2) / 1.08883
    const [fx, fy, fz] = [f(X), f(Y), f(Z)]
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
  }
  let total = 0
  const n = Math.min(a.length, b.length) / 3
  for (let i = 0; i < n * 3; i += 3) {
    const p = lab(a[i]!, a[i + 1]!, a[i + 2]!)
    const q = lab(b[i]!, b[i + 1]!, b[i + 2]!)
    total += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
  }
  return total / n
}

test.describe('the README images match the presets they claim to show', () => {
  for (const { file, preset } of TARGETS) {
    test(`${file} is a current render of "${preset.name}"`, async ({ page }) => {
      test.setTimeout(180_000)

      const jpeg = readFileSync(SOURCE).toString('base64')
      const state = applyAxisPreset(DEFAULT_EDIT_STATE, preset)

      await page.goto('/')
      await page.waitForFunction(
        () => '__photolabRenderer' in window && '__photolabExport' in window,
      )

      const { rendered, raw } = await page.evaluate(
        async ({ jpeg, edit }) => {
          const w = window as unknown as {
            __photolabRenderer: {
              stop(): void
              input: { edit: Record<string, unknown>; view: Record<string, unknown> }
            }
            __photolabExport: { run(job: Record<string, unknown>): Promise<{ blob: Blob }> }
          }
          w.__photolabRenderer.stop()
          const bytes = Uint8Array.from(atob(jpeg), (c) => c.charCodeAt(0))
          const blob = new Blob([bytes], { type: 'image/jpeg' })
          const bitmap = await createImageBitmap(blob)
          const out = await w.__photolabExport.run({
            blob,
            edit: { ...w.__photolabRenderer.input.edit, ...edit },
            view: { ...w.__photolabRenderer.input.view, inspect: false },
            sourceWidth: bitmap.width,
            sourceHeight: bitmap.height,
            format: 'image/jpeg',
            quality: 0.92,
          })
          const b64 = (u: Uint8Array): string => {
            let s = ''
            for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192))
            return btoa(s)
          }
          // Both the encoded file and its decoded pixels: the first is what gets
          // written, the second is what gets compared.
          const encoded = new Uint8Array(await out.blob.arrayBuffer())
          const back = await createImageBitmap(new Blob([encoded], { type: 'image/jpeg' }))
          const canvas = new OffscreenCanvas(back.width, back.height)
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(back, 0, 0)
          const data = ctx.getImageData(0, 0, back.width, back.height).data
          const rgb = new Uint8Array(back.width * back.height * 3)
          for (let i = 0, j = 0; j < data.length; i += 3, j += 4) {
            rgb[i] = data[j]!
            rgb[i + 1] = data[j + 1]!
            rgb[i + 2] = data[j + 2]!
          }
          return { rendered: b64(encoded), raw: b64(rgb) }
        },
        { jpeg, edit: state as unknown as Record<string, unknown> },
      )

      if (UPDATE) {
        writeFileSync(file, Buffer.from(rendered, 'base64'))
        process.stdout.write(`\n  wrote ${file}\n`)
        return
      }

      expect(existsSync(file), `${file} is missing; regenerate with UPDATE_README_IMAGES=1`).toBe(
        true,
      )

      // Decode the committed file the same way, in the page, so one decoder is
      // used for both sides and cannot be the source of a difference.
      const committed = await page.evaluate(
        async (b64: string) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(bitmap, 0, 0)
          const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
          const rgb = new Uint8Array(bitmap.width * bitmap.height * 3)
          for (let i = 0, j = 0; j < data.length; i += 3, j += 4) {
            rgb[i] = data[j]!
            rgb[i + 1] = data[j + 1]!
            rgb[i + 2] = data[j + 2]!
          }
          let s = ''
          for (let i = 0; i < rgb.length; i += 8192) s += String.fromCharCode(...rgb.subarray(i, i + 8192))
          return btoa(s)
        },
        readFileSync(file).toString('base64'),
      )

      const delta = meanDeltaE(Buffer.from(raw, 'base64'), Buffer.from(committed, 'base64'))
      process.stdout.write(`\n  ${file}: mean dE ${delta.toFixed(3)} (max ${MAX_DELTA_E})\n`)
      expect(
        delta,
        `${file} no longer matches "${preset.name}". Regenerate with UPDATE_README_IMAGES=1`,
      ).toBeLessThan(MAX_DELTA_E)
    })
  }
})
