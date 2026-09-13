import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Every blur radius goes through the one helper, asserted rather than assumed.
 *
 * # Why a source-level assertion, which is otherwise a poor kind
 *
 * The tiling audit in `tests/README.md` found that diffusion had no coverage of
 * its own against a scale error and was safe only because it delegates to the
 * same radius helper halation does. The complaint was not that the code was
 * wrong — it is right — but that **nothing asserted the arrangement**, so it was
 * a property of that day's implementation rather than something a change would
 * have to break deliberately.
 *
 * Microcontrast is now in the same position, and unavoidably so: the
 * two-resolution fixture cannot represent structure at its radius, so it cannot
 * have a case there, and that reasoning is recorded where the case would be.
 *
 * So the transitive coverage is written down. If someone gives one of these its
 * own radius computation, this fails and points at the two-resolution case list
 * — which is the moment to add one, not afterwards.
 *
 * A source-level check is a blunt instrument and this is the situation it suits:
 * the claim *is* about which function the source calls.
 */

const SHADERS = [
  'src/render/shaders/halationBlur.frag',
  'src/render/shaders/diffusionBlur.frag',
  'src/render/shaders/microcontrastBlur.frag',
]

/** Cases in `tests/golden/two-resolution.spec.ts`, which is the only test that can see a scale error. */
const COVERED_DIRECTLY = ['halationBlur', 'diffusionBlur']

describe('spatial radii share one normalisation', () => {
  for (const path of SHADERS) {
    it(`${path.split('/').pop()} computes its radius through the shared helper`, () => {
      const source = readFileSync(path, 'utf8')
      expect(
        source.includes('blurRadiusInBufferPixels') ||
          source.includes('halationRadiusInBufferPixels'),
        `${path} computes a radius some other way. It therefore needs its own case in ` +
          `tests/golden/two-resolution.spec.ts, which is the only test that can see a ` +
          `scale-dependent error — see the tiling audit in tests/README.md.`,
      ).toBe(true)
    })
  }

  it('names which of them are covered directly and which by delegation', () => {
    // Not decoration. The list is what a future author reads to find out that
    // adding a fourth radius means adding a two-resolution case, and it fails if
    // a shader is added to the set above without that decision being made.
    const names = SHADERS.map((p) => p.split('/').pop()!.replace('.frag', ''))
    const delegated = names.filter((n) => !COVERED_DIRECTLY.includes(n))
    expect(delegated, 'a radius covered neither directly nor by a recorded delegation').toEqual([
      'microcontrastBlur',
    ])
  })
})
