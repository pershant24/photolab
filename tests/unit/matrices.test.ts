import { describe, expect, it } from 'vitest'

import type { Mat3, Vec3 } from '../../src/core/colour/types'
import { MAT3_IDENTITY, mat3Mul, mat3MulVec3 } from '../../src/core/colour/types'
import { ACESCG_TO_SRGB, SRGB_TO_ACESCG } from '../../src/core/colour/matrices'
import { srgbEotf, srgbOetf } from '../../src/core/colour/transfer'

const MAT3_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

function rowSums(m: Mat3): Vec3 {
  return [m[0] + m[1] + m[2], m[3] + m[4] + m[5], m[6] + m[7] + m[8]]
}

/**
 * Published linear sRGB (D65) -> ACEScg (AP1, ACES white) with a Bradford
 * adaptation, as produced by the colour-science RGB colourspace transformation
 * matrix calculator and reproduced at
 * https://gist.github.com/Opioid/442d4975a23eed9a9e129bc3de97ea2a
 *
 * This is the weaker of the two checks on the matrix and is kept second on
 * purpose. Published ACES matrices differ in the fourth decimal depending on how
 * many digits of the chromaticities the author carried and, more importantly,
 * on which chromatic adaptation they used — a CAT02-adapted variant of this same
 * matrix is also in wide circulation and disagrees in the third decimal. If this
 * assertion and the row-sum property ever disagree, the property is the one to
 * trust: it cannot inherit a wrong expectation from a document.
 */
const PUBLISHED_SRGB_TO_ACESCG: Mat3 = [
  0.61309732, 0.33952285, 0.04737928,
  0.07019422, 0.91635557, 0.01345259,
  0.0206156, 0.10956983, 0.86981512,
]

describe('sRGB <-> ACEScg matrices', () => {
  // The highest-value assertion in the module. Rows sum to 1 exactly when
  // (1,1,1) maps to (1,1,1), which is exactly when white maps to white, which
  // holds only if the D65 -> ACES white adaptation is present and pointing the
  // right way. Watched to fail at 0.977 on the first row with the adaptation
  // omitted — a 2.3% error on red, which is well below the threshold of looking
  // wrong and is why this test exists rather than an eyeball check.
  //
  // Its limits are worth stating: it also fails if the matrix is transposed,
  // but it passes regardless of whether a primary chromaticity is typo'd, since
  // the white point plumbing would still be self-consistent. That is what the
  // published-value comparison below covers.
  it('has rows summing to 1 in the forward matrix', () => {
    for (const sum of rowSums(SRGB_TO_ACESCG)) {
      expect(sum).toBeCloseTo(1, 6)
    }
  })

  it('has rows summing to 1 in the inverse matrix', () => {
    for (const sum of rowSums(ACESCG_TO_SRGB)) {
      expect(sum).toBeCloseTo(1, 6)
    }
  })

  it('composes with its inverse to the identity', () => {
    const product = mat3Mul(SRGB_TO_ACESCG, ACESCG_TO_SRGB)
    for (const i of MAT3_INDICES) {
      expect(product[i]).toBeCloseTo(MAT3_IDENTITY[i], 6)
    }
  })

  it('maps sRGB white to ACEScg white', () => {
    const white = mat3MulVec3(SRGB_TO_ACESCG, [1, 1, 1])
    expect(white[0]).toBeCloseTo(1, 6)
    expect(white[1]).toBeCloseTo(1, 6)
    expect(white[2]).toBeCloseTo(1, 6)
  })

  it('agrees with the published matrix to four decimal places', () => {
    for (const i of MAT3_INDICES) {
      expect(SRGB_TO_ACESCG[i]).toBeCloseTo(PUBLISHED_SRGB_TO_ACESCG[i], 4)
    }
  })

  it('preserves neutrals at every level, not only at white', () => {
    // Row sums prove it for 1.0. Linearity makes every other neutral follow,
    // but this catches a matrix that is right at white and wrong elsewhere,
    // which is what a stray additive term would produce.
    for (const grey of [0, 0.02, 0.18, 0.5, 1, 8]) {
      const out = mat3MulVec3(SRGB_TO_ACESCG, [grey, grey, grey])
      expect(out[0]).toBeCloseTo(grey, 6)
      expect(out[1]).toBeCloseTo(grey, 6)
      expect(out[2]).toBeCloseTo(grey, 6)
    }
  })

  it('round trips random linear colours through ACEScg and back', () => {
    // Deterministic generator: a failing case must be reproducible from the
    // test output alone, which a seeded Math.random substitute is not.
    let seed = 0x2f6e2b1
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    for (let i = 0; i < 2000; i++) {
      const source: Vec3 = [next(), next(), next()]
      const returned = mat3MulVec3(ACESCG_TO_SRGB, mat3MulVec3(SRGB_TO_ACESCG, source))
      expect(returned[0]).toBeCloseTo(source[0], 5)
      expect(returned[1]).toBeCloseTo(source[1], 5)
      expect(returned[2]).toBeCloseTo(source[2], 5)
    }
  })

  it('round trips random encoded sRGB colours through the full ingest and display chain', () => {
    // The check docs/COLOUR_PIPELINE.md describes: sRGB in must equal sRGB out
    // through an otherwise identity pipeline, with the display transform in its
    // `none` mode. This is what catches a sign or transpose error, because a
    // transposed matrix still has plausible-looking entries.
    let seed = 0x51f3a7d
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    for (let i = 0; i < 2000; i++) {
      const source: Vec3 = [next(), next(), next()]
      const linear: Vec3 = [srgbEotf(source[0]), srgbEotf(source[1]), srgbEotf(source[2])]
      const working = mat3MulVec3(SRGB_TO_ACESCG, linear)
      const back = mat3MulVec3(ACESCG_TO_SRGB, working)
      const returned: Vec3 = [srgbOetf(back[0]), srgbOetf(back[1]), srgbOetf(back[2])]

      expect(returned[0]).toBeCloseTo(source[0], 5)
      expect(returned[1]).toBeCloseTo(source[1], 5)
      expect(returned[2]).toBeCloseTo(source[2], 5)
    }
  })
})
