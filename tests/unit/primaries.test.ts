import { describe, expect, it } from 'vitest'

import type { Mat3 } from '../../src/core/colour/types'
import { mat3MulVec3 } from '../../src/core/colour/types'
import {
  ACES_WHITE_XYZ,
  AP1_TO_XYZ_ACES_WHITE,
  D65_WHITE_XYZ,
  SRGB_TO_XYZ_D65,
  XYZ_ACES_WHITE_TO_AP1,
  XYZ_D65_TO_SRGB,
  rgbToXyzMatrix,
  xyToXYZ,
} from '../../src/core/colour/primaries'

const MAT3_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

/**
 * Published linear sRGB (D65) -> CIE XYZ, from the W3C CSS Color Module Level 4
 * conversion code (github.com/w3c/csswg-drafts, css-color-4/conversions.js),
 * where it is given as exact rationals rather than decimals. Carried here in
 * that form, so the reference has no rounding of its own and the comparison is
 * against the true value of the derivation rather than against a transcription
 * of it.
 *
 * This assertion covers what the row-sum test in `matrices.test.ts` cannot. Row
 * sums prove the white point plumbing is self-consistent; they pass unchanged if
 * a primary chromaticity is typo'd, because the derivation would still scale
 * whatever primaries it was given so that they reproduce the stated white. Only
 * a comparison against a published matrix catches that, and it is cleanest here,
 * before any adaptation is composed on top.
 *
 * A note for whoever compares this against a different source and finds it
 * wrong. Bruce Lindbloom's widely copied sRGB matrix begins 0.4124564, not
 * 0.4123908, and the two disagree by 6.6e-5. Neither is a mistake: Lindbloom
 * uses the ASTM tabulated D65 white (0.95047, 1, 1.08883) while the sRGB and
 * Rec.709 specifications state D65 as the chromaticity (0.3127, 0.3290), which
 * gives (0.95045593, 1, 1.08905775). This module derives from the chromaticity,
 * because that is what its own primaries are stated as and mixing the two
 * conventions is what produces a matrix that is self-inconsistent. The
 * chromaticity-derived white is also the one colour-science uses, which is why
 * the published adaptation references in `adaptation.test.ts` line up.
 */
const PUBLISHED_SRGB_TO_XYZ_D65: Mat3 = [
  506752 / 1228815, 87881 / 245763, 12673 / 70218,
  87098 / 409605, 175762 / 245763, 12673 / 175545,
  7918 / 409605, 87881 / 737289, 1001167 / 1053270,
]

/**
 * Published ACES AP1 -> CIE XYZ at the ACES white point, from the ACES
 * specifications. Same purpose as above, for the other set of primaries.
 */
const PUBLISHED_AP1_TO_XYZ: Mat3 = [
  0.66245418, 0.13400421, 0.15618769,
  0.27222872, 0.67408177, 0.05368952,
  -0.00557465, 0.00406073, 1.0103391,
]

describe('chromaticity conversion', () => {
  it('converts xy to XYZ at unit luminance', () => {
    const equalEnergy = xyToXYZ(1 / 3, 1 / 3)
    expect(equalEnergy[0]).toBeCloseTo(1, 12)
    expect(equalEnergy[1]).toBe(1)
    expect(equalEnergy[2]).toBeCloseTo(1, 12)
  })

  it('rejects a zero y, rather than returning Infinity for it to propagate', () => {
    expect(() => xyToXYZ(0.3, 0)).toThrow(RangeError)
  })
})

describe('RGB to XYZ derivation', () => {
  it('reproduces the published sRGB matrix from its chromaticities', () => {
    for (const i of MAT3_INDICES) {
      expect(SRGB_TO_XYZ_D65[i]).toBeCloseTo(PUBLISHED_SRGB_TO_XYZ_D65[i], 12)
    }
  })

  it('reproduces the published AP1 matrix from its chromaticities', () => {
    for (const i of MAT3_INDICES) {
      expect(AP1_TO_XYZ_ACES_WHITE[i]).toBeCloseTo(PUBLISHED_AP1_TO_XYZ[i], 6)
    }
  })

  it('maps RGB (1,1,1) onto the white point it was built from', () => {
    // This is the property the whole derivation exists to satisfy, one level
    // below the row-sum test: the primaries fix each column's direction, and
    // the white point is what fixes their lengths.
    const srgbWhite = mat3MulVec3(SRGB_TO_XYZ_D65, [1, 1, 1])
    expect(srgbWhite[0]).toBeCloseTo(D65_WHITE_XYZ[0], 12)
    expect(srgbWhite[1]).toBeCloseTo(D65_WHITE_XYZ[1], 12)
    expect(srgbWhite[2]).toBeCloseTo(D65_WHITE_XYZ[2], 12)

    const ap1White = mat3MulVec3(AP1_TO_XYZ_ACES_WHITE, [1, 1, 1])
    expect(ap1White[0]).toBeCloseTo(ACES_WHITE_XYZ[0], 12)
    expect(ap1White[1]).toBeCloseTo(ACES_WHITE_XYZ[1], 12)
    expect(ap1White[2]).toBeCloseTo(ACES_WHITE_XYZ[2], 12)
  })

  it('maps each primary onto its own chromaticity', () => {
    // Pure red must land on a colour whose xy is the red primary's xy, whatever
    // its luminance turned out to be. This checks the columns individually,
    // where the white point test only checks their sum.
    const red = mat3MulVec3(SRGB_TO_XYZ_D65, [1, 0, 0])
    const redSum = red[0] + red[1] + red[2]
    expect(red[0] / redSum).toBeCloseTo(0.64, 12)
    expect(red[1] / redSum).toBeCloseTo(0.33, 12)

    const ap1Blue = mat3MulVec3(AP1_TO_XYZ_ACES_WHITE, [0, 0, 1])
    const blueSum = ap1Blue[0] + ap1Blue[1] + ap1Blue[2]
    expect(ap1Blue[0] / blueSum).toBeCloseTo(0.128, 12)
    expect(ap1Blue[1] / blueSum).toBeCloseTo(0.044, 12)
  })

  it('round trips through the inverse matrices', () => {
    for (const colour of [
      [0.2, 0.5, 0.9],
      [1, 0, 0],
      [0.03, 0.03, 0.03],
    ] as const) {
      const srgbBack = mat3MulVec3(XYZ_D65_TO_SRGB, mat3MulVec3(SRGB_TO_XYZ_D65, colour))
      expect(srgbBack[0]).toBeCloseTo(colour[0], 12)
      expect(srgbBack[1]).toBeCloseTo(colour[1], 12)
      expect(srgbBack[2]).toBeCloseTo(colour[2], 12)

      const ap1Back = mat3MulVec3(
        XYZ_ACES_WHITE_TO_AP1,
        mat3MulVec3(AP1_TO_XYZ_ACES_WHITE, colour),
      )
      expect(ap1Back[0]).toBeCloseTo(colour[0], 12)
      expect(ap1Back[1]).toBeCloseTo(colour[1], 12)
      expect(ap1Back[2]).toBeCloseTo(colour[2], 12)
    }
  })

  it('rejects degenerate primaries instead of producing a silently unusable matrix', () => {
    // Three collinear chromaticities span no gamut, so the matrix is singular.
    expect(() => rgbToXyzMatrix(0.3, 0.3, 0.4, 0.4, 0.5, 0.5, 0.3127, 0.329)).toThrow(RangeError)
  })
})
