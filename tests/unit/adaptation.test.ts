import { describe, expect, it } from 'vitest'

import type { Mat3, Vec3 } from '../../src/core/colour/types'
import { MAT3_IDENTITY, mat3Mul, mat3MulVec3 } from '../../src/core/colour/types'
import {
  bradfordAdaptationMatrix,
  cat02AdaptationMatrix,
} from '../../src/core/colour/adaptation'

const MAT3_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

function expectMat3CloseTo(actual: Mat3, expected: Mat3, digits: number): void {
  for (const i of MAT3_INDICES) {
    expect(actual[i]).toBeCloseTo(expected[i], digits)
  }
}

/**
 * Published reference adaptation, from the docstring of
 * `colour.adaptation.matrix_chromatic_adaptation_VonKries` in colour-science
 * 0.4.x (colour.readthedocs.io). Both transforms are given there for the same
 * pair of white points, which makes it a single citable source for both and
 * removes any chance of comparing one transform against the other's reference.
 *
 * The white points are D65 and D50 at unit luminance, exactly as the docstring
 * states them.
 */
const D65_XYZ: Vec3 = [0.95045593, 1.0, 1.08905775]
const D50_XYZ: Vec3 = [0.96429568, 1.0, 0.8251046]

const PUBLISHED_CAT02_D65_TO_D50: Mat3 = [
  1.0425738, 0.030891, -0.0528125,
  0.0221934, 1.0018566, -0.0210737,
  -0.0011648, -0.0034205, 0.761789,
]

const PUBLISHED_BRADFORD_D65_TO_D50: Mat3 = [
  1.0479297, 0.0229468, -0.0501922,
  0.0296278, 0.9904344, -0.0170738,
  -0.009243, 0.0150551, 0.7518742,
]

describe('chromatic adaptation', () => {
  it('reproduces the published CAT02 D65 -> D50 adaptation', () => {
    expectMat3CloseTo(cat02AdaptationMatrix(D65_XYZ, D50_XYZ), PUBLISHED_CAT02_D65_TO_D50, 6)
  })

  it('reproduces the published Bradford D65 -> D50 adaptation', () => {
    expectMat3CloseTo(
      bradfordAdaptationMatrix(D65_XYZ, D50_XYZ),
      PUBLISHED_BRADFORD_D65_TO_D50,
      6,
    )
  })

  it('produces different matrices for the two transforms', () => {
    // Guards against the failure where both helpers silently use one cone
    // response matrix, which would leave both tests above passing against
    // whichever reference happened to be checked first.
    const cat02 = cat02AdaptationMatrix(D65_XYZ, D50_XYZ)
    const bradford = bradfordAdaptationMatrix(D65_XYZ, D50_XYZ)
    expect(cat02[0]).not.toBeCloseTo(bradford[0], 4)
  })

  it.each([
    ['CAT02', cat02AdaptationMatrix],
    ['Bradford', bradfordAdaptationMatrix],
  ])('maps the source white exactly onto the destination white (%s)', (_name, build) => {
    const adapted = mat3MulVec3(build(D65_XYZ, D50_XYZ), D65_XYZ)
    expect(adapted[0]).toBeCloseTo(D50_XYZ[0], 12)
    expect(adapted[1]).toBeCloseTo(D50_XYZ[1], 12)
    expect(adapted[2]).toBeCloseTo(D50_XYZ[2], 12)
  })

  it.each([
    ['CAT02', cat02AdaptationMatrix],
    ['Bradford', bradfordAdaptationMatrix],
  ])('is the identity when the white points are equal (%s)', (_name, build) => {
    expectMat3CloseTo(build(D65_XYZ, D65_XYZ), MAT3_IDENTITY, 12)
  })

  it.each([
    ['CAT02', cat02AdaptationMatrix],
    ['Bradford', bradfordAdaptationMatrix],
  ])('is undone by the reverse adaptation (%s)', (_name, build) => {
    const there = build(D65_XYZ, D50_XYZ)
    const back = build(D50_XYZ, D65_XYZ)
    expectMat3CloseTo(mat3Mul(back, there), MAT3_IDENTITY, 12)
  })
})
