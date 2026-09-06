import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

import { AGREEMENT_GRADES, SPATIAL_OFF, buildChain, ingest } from '../support/gamutChain'
import { displayTransform, DEFAULT_DISPLAY_SETTINGS } from '../../src/core/colour/display'
import { DEFAULT_EDIT_STATE, mergeEditState } from '../../src/core/state/editState'

/**
 * Does the chain the gamut census runs agree with the chain the app runs?
 *
 * The census in `tests/README.md` measures what the display transform is handed
 * on a real photograph, and it does that in Node by composing the pointwise
 * passes from `src/core/colour/`. Those functions are each already asserted
 * against their shaders. What is *not* checked anywhere else is the
 * composition — the order the passes run in and which encode each one sits
 * inside — and a reordering of `src/render/passes/registry.ts` would silently
 * turn the census into a description of a pipeline this project does not have.
 *
 * This test exists to be run, which was not a given. An earlier version read
 * its inputs from a scratch directory named after a session, so it would have
 * skipped on every machine forever while the document cited it in the present
 * tense — the third time a check here has nearly passed by not running. It now
 * uses the photograph committed under `docs/images/`, decodes it in the page,
 * and needs nothing that is not in the repository.
 *
 * The three spatial passes are off on both sides. That is the census's stated
 * scope rather than a difference being hidden.
 */

/** The census frame: a real photograph, committed, and the one the README shows. */
const FRAME = 'docs/images/original.jpg'

/**
 * Half-float intermediates on the GPU against float64 in Node cannot agree
 * exactly. One code value is the bound the export parity test carries; two is
 * the point past which a hue conclusion could move.
 */
const TOLERANCE = 2

test.describe('the census chain', () => {
  for (const grade of AGREEMENT_GRADES) {
    test(`agrees with the renderer: ${grade.name}`, async ({ page }) => {
      test.setTimeout(120_000)

      const jpeg = readFileSync(FRAME).toString('base64')
      const edit = { ...grade.patch, ...SPATIAL_OFF }
      const state = mergeEditState(DEFAULT_EDIT_STATE, edit)

      await page.goto('/')
      await page.waitForFunction(
        () => '__photolabRenderer' in window && '__photolabExport' in window,
      )

      // The *sanitised* state goes to the page, not the raw patch. `mergeEditState`
      // clamps and validates every value, so passing the patch to the browser and
      // the merged state to Node would compare two different edits — which is
      // exactly what happened: a tone curve whose domain endpoint was written as a
      // rounded literal was adjusted on one side only, and the two chains
      // disagreed by 15 code values on 93% of the frame. The chain was right and
      // the harness was wrong.
      const { source, rendered, width, height } = await page.evaluate(
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
          const { width, height } = bitmap

          // Drop alpha and base64 the rest: an array of 1.8M numbers crosses
          // the bridge an order of magnitude more slowly.
          const raw = (image: ImageBitmap): string => {
            const canvas = new OffscreenCanvas(width, height)
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(image, 0, 0)
            const data = ctx.getImageData(0, 0, width, height).data
            const rgb = new Uint8Array(width * height * 3)
            for (let i = 0, j = 0; j < data.length; i += 3, j += 4) {
              rgb[i] = data[j]!
              rgb[i + 1] = data[j + 1]!
              rgb[i + 2] = data[j + 2]!
            }
            let s = ''
            for (let i = 0; i < rgb.length; i += 8192) {
              s += String.fromCharCode(...rgb.subarray(i, i + 8192))
            }
            return btoa(s)
          }

          const out = await w.__photolabExport.run({
            blob,
            edit: { ...w.__photolabRenderer.input.edit, ...edit },
            view: { ...w.__photolabRenderer.input.view, inspect: false },
            sourceWidth: width,
            sourceHeight: height,
            format: 'image/png',
          })

          return {
            source: raw(bitmap),
            rendered: raw(await createImageBitmap(out.blob)),
            width,
            height,
          }
        },
        { jpeg, edit: state as unknown as Record<string, unknown> },
      )

      // The page decoded the JPEG, so both sides start from identical bytes and
      // no second decoder can disagree about what the source was.
      const src = new Uint8Array(Buffer.from(source, 'base64'))
      const gpu = new Uint8Array(Buffer.from(rendered, 'base64'))
      expect(src.length, 'the decoded source is the wrong size').toBe(width * height * 3)
      expect(gpu.length, 'the render came back the wrong size').toBe(src.length)

      const chain = buildChain(state)
      const settings = { ...DEFAULT_DISPLAY_SETTINGS, toneMapKnee: state.toneMapKnee }

      let worst = 0
      let differing = 0
      for (let i = 0; i < src.length; i += 3) {
        const encoded = displayTransform(chain(ingest(src[i]!, src[i + 1]!, src[i + 2]!)), settings)
        for (let c = 0; c < 3; c++) {
          const delta = Math.abs(Math.round(encoded[c]! * 255) - gpu[i + c]!)
          if (delta > 0) differing++
          if (delta > worst) worst = delta
        }
      }

      process.stdout.write(
        `\n  ${grade.name}: worst ${worst} code values, ` +
          `${((100 * differing) / src.length).toFixed(2)}% of samples differ\n`,
      )
      expect(worst, 'the composed chain does not match the renderer').toBeLessThanOrEqual(TOLERANCE)
    })
  }
})
