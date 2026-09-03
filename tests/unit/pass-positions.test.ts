import { describe, expect, it } from 'vitest'

import { orderPasses } from '../../src/render/graph'
import { registeredPasses } from '../../src/render/passes/registry'
import { createCurvePass } from '../../src/render/passes/curve'
import { createFilmCurvesPass } from '../../src/render/passes/filmCurves'
import { STAGES } from '../../src/render/passes/types'

/**
 * Where every pass sits, relative to every other pass that constrains it.
 *
 * # Why this category of test exists
 *
 * Contrast ran at the end of the grade stage for two stages, and every pass
 * involved was individually correct. No agreement test could see it: each pass
 * matched its own reference exactly. No identity test could see it: each was
 * exactly the identity at its neutral. It was an **ordering defect between
 * correct passes**, and until now the only positions asserted anywhere were
 * exposure and contrast, from Stage 4.
 *
 * # Relative, not absolute
 *
 * Every constraint below is "A runs before B". Indices would be shorter to write
 * and would break on every pass added, which means they would be relaxed on every
 * pass added, which means within two stages they would assert nothing.
 *
 * # The coverage rule is the part that keeps working
 *
 * A constraint list is only as good as its completeness, and completeness is
 * exactly what rots. So every registered pass must appear in `CONSTRAINTS` or in
 * `UNCONSTRAINED` with a reason. Adding a pass without saying where it belongs
 * fails here rather than passing silently — which is what would have to happen for
 * this test to be worth more than the comment it replaces.
 */

const passes = orderPasses(registeredPasses(createCurvePass(), createFilmCurvesPass()))
const order = new Map(passes.map((pass, index) => [pass.id, index]))
const stageOf = new Map(passes.map((pass) => [pass.id, pass.stage]))

/** `[before, after, why]`. */
const CONSTRAINTS: readonly (readonly [string, string, string])[] = [
  // Ingest. Nothing can be computed until values are linear and in a known space.
  ['imageSource', 'ingest', 'ingest linearises what the source pass produced'],
  ['testPattern', 'ingest', 'the pattern is a source like any other'],

  // Scene, and the boundary out of ingest.
  ['ingest', 'whiteBalance', 'adaptation needs a known working space'],
  ['whiteBalance', 'exposure', 'white balance and exposure both describe the light arriving'],

  // Scene before lens: a vignette darkens an already-exposed frame, so exposure
  // applied after vignetting would scale with the vignette rather than with the
  // aperture.
  ['exposure', 'distortion', 'the lens acts on light that has left the scene'],

  // Lens, internally, in the order the glass does it: bend, split by wavelength,
  // scatter, fall off toward the corners.
  ['distortion', 'aberration', 'the glass bends the image before it splits it'],
  ['aberration', 'diffusionBlurH', 'scattering acts on the image the glass formed'],
  ['diffusionBlurH', 'diffusionBlurV', 'the separable pair, in order'],
  ['diffusionBlurV', 'diffusionComposite', 'the scatter is composited once it is blurred'],
  ['diffusionComposite', 'vignette', 'falloff is illumination, and comes last in the lens'],

  // Lens before film. The lens forms the image the emulsion records, which is why
  // the vignette's darkening passes THROUGH the characteristic curves rather than
  // being applied to a developed picture.
  ['vignette', 'halationThreshold', 'the lens forms the image the film records'],

  // Film, internally. Halation adds light to the emulsion, so it happens before
  // the curves turn exposure into density; grain depends on the density those
  // curves produce, so it happens after them.
  ['halationThreshold', 'halationBlurH', 'threshold, then blur across'],
  ['halationBlurH', 'halationBlurV', 'the separable pair, in order'],
  ['halationBlurV', 'halationComposite', 'the halo is composited once it is blurred'],
  ['halationComposite', 'filmCurves', 'halation is exposure; the curves turn it into density'],
  ['filmCurves', 'grain', 'grain magnitude depends on a density that does not exist yet'],

  // Film before grade. A grade is a human interpreting a developed negative.
  ['grain', 'toneCurve', 'there is nothing to grade until the film stage has produced it'],

  // Grade, internally: tonal shaping first, colour trim after. This is the one
  // that was wrong, and the reason the file exists.
  ['toneCurve', 'contrast', 'the two tonal controls are adjacent'],
  ['contrast', 'wheels', 'contrast last scaled every wheel in proportion to its slope'],
  ['contrast', 'splitTone', 'and every split tone offset with it'],
  ['wheels', 'hsl', 'zone trim, then hue trim'],
  ['hsl', 'splitTone', 'hue trim, then the two-ended tint'],

  // Display is last, and is the only stage that knows what the output device is.
  ['splitTone', 'display', 'everything before the display transform is device independent'],
  ['contrast', 'display', 'the display transform sees a finished grade'],
]

/** Passes with no ordering constraint of their own, and why that is correct. */
const UNCONSTRAINED: Readonly<Record<string, string>> = {}

describe('every pass declares where it runs', () => {
  it('gives every pass a stage the physical ordering knows about', () => {
    for (const pass of passes) {
      expect(STAGES, `${pass.id} declares stage "${pass.stage}"`).toContain(pass.stage)
    }
  })

  it('runs the stages in the order the phenomena occur', () => {
    // Light leaves the scene, passes through a lens, lands on film, and the
    // result is interpreted by a colourist and shown on a display.
    const stageIndex = new Map(STAGES.map((stage, index) => [stage, index]))
    let previous = -1
    for (const pass of passes) {
      const index = stageIndex.get(pass.stage) ?? -1
      expect(index, `${pass.id} is out of stage order`).toBeGreaterThanOrEqual(previous)
      previous = index
    }
  })

  it('mentions every registered pass, so a new one cannot arrive unplaced', () => {
    // The coverage rule. Without it the constraint list decays into a historical
    // record of the passes someone happened to think about.
    const mentioned = new Set<string>()
    for (const [before, after] of CONSTRAINTS) {
      mentioned.add(before)
      mentioned.add(after)
    }
    for (const id of Object.keys(UNCONSTRAINED)) mentioned.add(id)

    const missing = passes.map((pass) => pass.id).filter((id) => !mentioned.has(id))
    expect(
      missing,
      `these passes have no declared position: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('constrains only passes that exist', () => {
    // The other direction: a constraint naming a pass that was renamed or removed
    // is a constraint that silently stopped checking anything.
    for (const [before, after] of CONSTRAINTS) {
      expect(order.has(before), `constraint names unknown pass "${before}"`).toBe(true)
      expect(order.has(after), `constraint names unknown pass "${after}"`).toBe(true)
    }
    for (const id of Object.keys(UNCONSTRAINED)) {
      expect(order.has(id), `UNCONSTRAINED names unknown pass "${id}"`).toBe(true)
    }
  })
})

describe('the declared positions hold', () => {
  it.each(CONSTRAINTS.map(([before, after, why]) => [`${before} before ${after}`, before, after, why]))(
    '%s',
    (_label, before: string, after: string, why: string) => {
      const a = order.get(before)
      const b = order.get(after)
      expect(a, before).toBeDefined()
      expect(b, after).toBeDefined()
      expect(a ?? -1, `${before} must run before ${after}: ${why}`).toBeLessThan(b ?? -1)
    },
  )

  it('keeps exposure and contrast in different stages, with empty ones between', () => {
    // Kept from Stage 4. Easy to get backwards, and a later refactor could
    // collapse them without anything else noticing: exposure describes the light
    // arriving at the lens, contrast is a colourist interpreting a negative. They
    // sit next to each other in the interface and must not sit next to each other
    // in the graph.
    expect(stageOf.get('exposure')).toBe('scene')
    expect(stageOf.get('contrast')).toBe('grade')
  })

  it('puts the whole grade stage after the whole film stage', () => {
    // Asserted over the stages rather than over a chosen pair, so a pass added to
    // either stage is covered without editing this.
    const filmLast = Math.max(
      ...passes.filter((p) => p.stage === 'film').map((p) => order.get(p.id) ?? -1),
    )
    const gradeFirst = Math.min(
      ...passes.filter((p) => p.stage === 'grade').map((p) => order.get(p.id) ?? Infinity),
    )
    expect(filmLast).toBeLessThan(gradeFirst)
  })

  it('has exactly one source pass, and it runs first', () => {
    const sources = passes.filter((pass) => pass.isSource)
    expect(sources.length).toBeGreaterThan(0)
    for (const source of sources) {
      expect(order.get(source.id) ?? -1).toBeLessThan(passes.length)
    }
    expect(passes[0]?.isSource, 'the first pass must be a source').toBe(true)
  })
})
