import { describe, expect, it } from 'vitest'

import {
  HSL_BAND_COUNT,
  HSL_BAND_SPACING,
  applyHsl,
  bandWeights,
  bandedValue,
  hueDistance,
  isHslIdentity,
  rgbHue,
  rotateHue,
} from '../../src/core/colour/hsl'
import type { Rgb } from '../../src/core/colour/hsl'

const NEUTRAL = Array<number>(HSL_BAND_COUNT).fill(0)
const SAMPLES: readonly Rgb[] = [
  [0.18, 0.18, 0.18], [0.5, 0.1, 0.1], [0.1, 0.5, 0.1], [0.1, 0.1, 0.5],
  [0.6, 0.55, 0.2], [0.02, 0.3, 0.31], [0.44, 0.12, 0.4], [1.2, 0.9, 0.4],
  [0.001, 0.002, 0.0015], [0, 0, 0], [3, 0.2, 0.05],
]

describe('the bands overlap and sum to one', () => {
  it('is a partition of unity at every hue', () => {
    // A hue between two bands must receive their average rather than their sum,
    // or setting every band to the same value adjusts the picture six times over.
    for (let h = 0; h < 720; h += 0.25) {
      const total = bandWeights(h).reduce((a, b) => a + b, 0)
      expect(total, `at ${h} degrees`).toBeCloseTo(1, 10)
    }
  })

  it('gives each band its own centre entirely', () => {
    for (let i = 0; i < HSL_BAND_COUNT; i++) {
      const w = bandWeights(i * HSL_BAND_SPACING)
      expect(w[i], `band ${i} at its centre`).toBeCloseTo(1, 10)
      for (let j = 0; j < HSL_BAND_COUNT; j++) {
        if (j !== i) expect(w[j]).toBeCloseTo(0, 10)
      }
    }
  })

  it('is continuous across the wrap at zero', () => {
    // Red is at 0 degrees, so its band straddles the discontinuity in the angle.
    // A distance function that did not wrap would cut the red band in half and
    // leave a visible edge through every red in the picture.
    const before = bandWeights(359.9)
    const after = bandWeights(0.1)
    for (let i = 0; i < HSL_BAND_COUNT; i++) {
      expect(Math.abs((before[i] ?? 0) - (after[i] ?? 0))).toBeLessThan(0.01)
    }
    expect(hueDistance(359, 1)).toBeCloseTo(-2, 10)
    expect(hueDistance(1, 359)).toBeCloseTo(2, 10)
  })

  it('weights nothing outside its own neighbours', () => {
    // Each band reaches exactly one spacing, so at most two are ever non-zero.
    for (let h = 0; h < 360; h += 0.5) {
      const nonZero = bandWeights(h).filter((w) => w > 1e-12).length
      expect(nonZero, `at ${h} degrees`).toBeLessThanOrEqual(2)
    }
  })
})

describe('a neutral setting is an exact identity', () => {
  // The requirement, and the reason there is no HSL round trip anywhere in this
  // module. `toBe` and not `toBeCloseTo`: anything else alters every unedited
  // photograph, and a tolerance would hide exactly that.
  it('returns every colour bit-for-bit when all bands are neutral', () => {
    for (const rgb of SAMPLES) {
      const out = applyHsl(rgb, NEUTRAL, NEUTRAL, NEUTRAL)
      expect(out[0], `red of ${rgb.join()}`).toBe(rgb[0])
      expect(out[1], `green of ${rgb.join()}`).toBe(rgb[1])
      expect(out[2], `blue of ${rgb.join()}`).toBe(rgb[2])
    }
  })

  it('leaves untouched bands alone when another band is adjusted', () => {
    // The case an `enabled` predicate cannot cover, and the one that actually
    // happens: a picture with one band moved is the normal state of an edit.
    const redOnly = [0.5, 0, 0, 0, 0, 0]
    // A cyan, two bands away, so no red weight reaches it.
    const cyan: Rgb = [0.02, 0.3, 0.31]
    expect(bandWeights(rgbHue(...cyan))[0]).toBe(0)
    const out = applyHsl(cyan, redOnly, redOnly, redOnly)
    expect(out[0]).toBe(cyan[0])
    expect(out[1]).toBe(cyan[1])
    expect(out[2]).toBe(cyan[2])
  })

  it('is exactly the identity for each adjustment on its own', () => {
    // Each of the three has to be exact by itself, or a neutral setting of the
    // other two would not save it.
    for (const rgb of SAMPLES) {
      expect(rotateHue(rgb, 0)).toEqual([...rgb])
      const satOnly = applyHsl(rgb, NEUTRAL, NEUTRAL, NEUTRAL)
      expect(satOnly).toEqual([...rgb])
    }
  })
})

describe('the adjustments do what they are named', () => {
  it('rotates hue without changing luminance much', () => {
    const red: Rgb = [0.5, 0.1, 0.1]
    const rotated = rotateHue(red, 60)
    expect(rgbHue(...rotated)).toBeGreaterThan(rgbHue(...red))
    // A rotation about the neutral axis preserves the sum exactly.
    expect(rotated[0] + rotated[1] + rotated[2]).toBeCloseTo(red[0] + red[1] + red[2], 10)
  })

  it('desaturates toward grey and saturates away from it', () => {
    const red: Rgb = [0.5, 0.1, 0.1]
    const flat = applyHsl(red, NEUTRAL, [-1, -1, -1, -1, -1, -1], NEUTRAL)
    expect(flat[0]).toBeCloseTo(flat[1], 10)
    expect(flat[1]).toBeCloseTo(flat[2], 10)
    const vivid = applyHsl(red, NEUTRAL, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], NEUTRAL)
    expect(vivid[0] - vivid[2]).toBeGreaterThan(red[0] - red[2])
  })

  it('changes luminance in stops', () => {
    const red: Rgb = [0.5, 0.1, 0.1]
    const up = applyHsl(red, NEUTRAL, NEUTRAL, [1, 1, 1, 1, 1, 1])
    expect(up[0]).toBeCloseTo(red[0] * 2, 10)
  })

  it('reports a hue for a colour and none for a neutral', () => {
    expect(rgbHue(0.5, 0.1, 0.1)).toBeCloseTo(0, 6)
    expect(rgbHue(0.1, 0.5, 0.1)).toBeCloseTo(120, 6)
    expect(rgbHue(0.1, 0.1, 0.5)).toBeCloseTo(240, 6)
    expect(rgbHue(0.2, 0.2, 0.2)).toBe(0)
  })

  it('averages settings rather than summing them', () => {
    // The partition in use: every band set to the same value gives that value at
    // every hue, not six times it.
    const all = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3]
    for (let h = 0; h < 360; h += 7) {
      expect(bandedValue(h, all), `at ${h} degrees`).toBeCloseTo(0.3, 10)
    }
  })

  it('recognises its identity', () => {
    expect(isHslIdentity(NEUTRAL)).toBe(true)
    expect(isHslIdentity([0, 0, 0, 0, 0, 1e-9])).toBe(false)
    expect(isHslIdentity([0, 0, 0])).toBe(false)
  })
})
