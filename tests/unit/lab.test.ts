import { describe, expect, it } from 'vitest'

import { hueDifference, labChroma, labHueAngle, linearSrgbToLab, xyzToLab } from '../../src/core/colour/lab'
import { D65_WHITE_XYZ } from '../../src/core/colour/primaries'
import type { Vec3 } from '../../src/core/colour/types'

describe('CIELAB', () => {
  it('puts the white point at L* 100 with no chroma', () => {
    const lab = xyzToLab(D65_WHITE_XYZ)
    expect(lab[0]).toBeCloseTo(100, 9)
    expect(lab[1]).toBeCloseTo(0, 9)
    expect(lab[2]).toBeCloseTo(0, 9)
  })

  it('puts black at L* 0', () => {
    expect(xyzToLab([0, 0, 0])[0]).toBe(0)
  })

  it('gives every neutral zero chroma, at any brightness', () => {
    // The property the hue metric depends on: a hue angle is only meaningful
    // measured from a neutral axis that is genuinely neutral.
    for (const v of [0.02, 0.18, 0.5, 1]) {
      expect(labChroma(linearSrgbToLab([v, v, v]))).toBeCloseTo(0, 9)
    }
  })

  it('places the sRGB primaries at their published CIELAB values', () => {
    // Independent check on the whole chain — matrix, white point and
    // nonlinearity — against values that can be looked up rather than derived
    // here. Tolerated to one decimal, which is far tighter than the hue shifts
    // the display tests measure.
    const cases: [string, Vec3, number, number][] = [
      ['red', [1, 0, 0], 53.24, 39.999],
      ['green', [0, 1, 0], 87.735, 136.016],
      ['blue', [0, 0, 1], 32.297, 306.285],
    ]
    for (const [name, rgb, expectedL, expectedHue] of cases) {
      const lab = linearSrgbToLab(rgb)
      expect(lab[0], `${name} L*`).toBeCloseTo(expectedL, 1)
      expect(labHueAngle(lab), `${name} hue`).toBeCloseTo(expectedHue, 1)
    }
  })

  it('stays finite for the out-of-gamut colours the display tests measure', () => {
    // A linear sRGB triple with a negative channel routinely produces a negative
    // Z, where the standard nonlinearity is undefined. The odd-symmetric
    // extension keeps it finite and monotone, which is what a comparison needs.
    for (const rgb of [[1, -0.3, -0.1], [0.2, 1.1, -0.35], [-0.4, -0.1, 1]] as Vec3[]) {
      const lab = linearSrgbToLab(rgb)
      for (const component of lab) expect(Number.isFinite(component)).toBe(true)
    }
  })

  it('measures hue difference the short way round', () => {
    expect(hueDifference(10, 350)).toBeCloseTo(20, 9)
    expect(hueDifference(350, 10)).toBeCloseTo(20, 9)
    expect(hueDifference(0, 180)).toBeCloseTo(180, 9)
  })
})
