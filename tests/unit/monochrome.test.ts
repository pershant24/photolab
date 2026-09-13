import { describe, expect, it } from 'vitest'

import { isMonochrome, normaliseMix } from '../../src/core/colour/monochrome'
import { DEFAULT_EDIT_STATE } from '../../src/core/state/editState'
import { STOCK_PRESETS } from '../../src/core/presets/axisLibrary'

/**
 * The channel mixer's two pure functions.
 *
 * Small, and load-bearing out of proportion to their size: one decides whether
 * the pass runs at all and the other is the whole reason the mixer is a colour
 * decision rather than a colour decision and a third of a stop of exposure.
 */

describe('the mixer weights are normalised', () => {
  it('sums to one, whatever it is given', () => {
    for (const mix of [
      [1, 1, 1],
      [0.3, 0.59, 0.11],
      [0.72, 0.24, 0.04],
      [5, 5, 5],
      [0.001, 0, 0],
      [2, 0, 0],
    ]) {
      const sum = normaliseMix(mix).reduce((a, b) => a + b, 0)
      expect(sum, `weights ${mix.join(', ')}`).toBeCloseTo(1, 12)
    }
  })

  it('is exactly neutral-preserving, which is what the sum buys', () => {
    /*
     * THE PROPERTY. For `r = g = b = v` the mixer returns
     * `v * (wr + wg + wb) / (wr + wg + wb)`, which is `v`.
     *
     * So a grey card comes out the same grey, middle grey stays anchored where
     * every stock's characteristic curves expect it, and setting a red filter
     * cannot move the exposure as a side effect. Without the normalisation,
     * weights summing to 1.2 would be a mixer and a third of a stop at once, and
     * nobody choosing a filter means that.
     */
    for (const mix of [
      [1, 1, 1],
      [0.72, 0.24, 0.04],
      [3, 1, 0.2],
      [0.18, 0.46, 0.36],
    ]) {
      const w = normaliseMix(mix)
      for (const v of [0.0001, 0.18, 0.5, 1, 40]) {
        const recorded = v * w[0] + v * w[1] + v * w[2]
        expect(recorded, `${mix.join(', ')} at ${v}`).toBeCloseTo(v, 12)
      }
    }
  })

  it('only scales, so the ratios between the weights are untouched', () => {
    // The other half of "only the ratio matters": normalising must not reorder
    // or redistribute, or a red filter would stop being a red filter at some
    // scale.
    const a = normaliseMix([0.72, 0.24, 0.04])
    const b = normaliseMix([7.2, 2.4, 0.4])
    for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i]!, 12)
  })

  it('returns zeros rather than dividing by zero when the film is not monochrome', () => {
    expect(normaliseMix([0, 0, 0])).toEqual([0, 0, 0])
    // Negative weights cannot be entered through the registry, whose minimum is
    // zero, so this is about not producing an infinity if one ever arrives.
    expect(normaliseMix([-1, 0.5, 0.5]).every(Number.isFinite)).toBe(true)
  })
})

describe('whether the film is monochrome at all', () => {
  it('is off at the default, so an unedited photograph keeps its colour', () => {
    expect(isMonochrome(DEFAULT_EDIT_STATE.monochromeMix)).toBe(false)
    expect(DEFAULT_EDIT_STATE.monochromeMix).toEqual([0, 0, 0])
  })

  it('is on for any weight at all, with no separate switch', () => {
    // All zeros is the off state and cannot be confused with a real setting:
    // weights are relative, so a mixer taking nothing from any channel has no
    // meaning to express.
    expect(isMonochrome([1, 0, 0])).toBe(true)
    expect(isMonochrome([0, 0, 1e-6])).toBe(true)
    expect(isMonochrome([0, 0, 0])).toBe(false)
  })

  it('is on for every monochrome preset and off for every colour one', () => {
    // The two populations, so neither branch is asserted on an empty set.
    const mono = STOCK_PRESETS.filter((p) => Array.isArray(p.patch.monochromeMix))
    expect(mono.length, 'no monochrome preset to check').toBe(3)
    for (const preset of mono) {
      expect(isMonochrome(preset.patch.monochromeMix!), `${preset.id}`).toBe(true)
    }
    const colour = STOCK_PRESETS.filter((p) => !Array.isArray(p.patch.monochromeMix))
    expect(colour.length, 'no colour preset to check').toBeGreaterThan(3)
    for (const preset of colour) {
      // A colour stock must not carry the key at all: `sanitisePatch` drops a
      // value equal to its default, so a preset stating [0, 0, 0] would be a key
      // that says nothing and the shipped-preset assertion would reject it.
      expect('monochromeMix' in preset.patch, `${preset.id} carries a mix`).toBe(false)
    }
  })
})
