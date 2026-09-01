import { describe, expect, it } from 'vitest'

import {
  LUT_TOLERANCE,
  MAX_LUT_SIZE,
  MIN_LUT_SIZE,
  curveDomainToUnit,
  curveLutResolution,
  curveSecondDerivativeBound,
  evaluateCurve,
  lutTexCoord,
  sampleCurveLut,
} from '../../src/core/colour/curve'

/** A curve over log exposure: the case a unit-domain assumption breaks on. */
const LOG_DOMAIN_XS = [-4, -2, 0, 2, 4]
const LOG_DOMAIN_YS = [0.02, 0.15, 0.5, 0.9, 1.0]

/** Linear interpolation between LUT samples, as the hardware does it. */
function sampleLutLinearly(
  lut: Float32Array,
  xs: readonly number[],
  x: number,
): number {
  const first = xs[0] ?? Number.NaN
  const last = xs[xs.length - 1] ?? Number.NaN
  const unit = Math.min(1, Math.max(0, (x - first) / (last - first)))
  const position = unit * (lut.length - 1)
  const index = Math.min(lut.length - 2, Math.floor(position))
  const fraction = position - index
  return (lut[index] ?? Number.NaN) * (1 - fraction) + (lut[index + 1] ?? Number.NaN) * fraction
}

describe('LUT resolution, derived from the curve', () => {
  it('bounds the second derivative exactly, not by sampling', () => {
    // The bound decides the resolution, so a sampled estimate that missed a peak
    // between samples would silently under-size every LUT. It is computed from
    // the Hermite basis's second derivatives, which are linear in t, so the
    // extremes are at the interval ends and evaluating both is exact.
    const xs = [0, 0.5, 1]
    const ys = [0, 0.9, 1]
    const bound = curveSecondDerivativeBound(xs, ys)

    let sampled = 0
    const h = 1e-4
    for (let i = 1; i < 10000; i++) {
      const x = i / 10000
      if (x < h || x > 1 - h) continue
      const second =
        (evaluateCurve(xs, ys, x + h) - 2 * evaluateCurve(xs, ys, x) + evaluateCurve(xs, ys, x - h)) /
        (h * h)
      sampled = Math.max(sampled, Math.abs(second))
    }
    expect(bound).toBeGreaterThanOrEqual(sampled * 0.99)
  })

  it('keeps interpolation error under the budget it was derived from', () => {
    // The property the derivation exists for, checked against direct evaluation
    // rather than against the formula that produced it.
    const cases: [string, number[], number[]][] = [
      ['gentle S', [0, 0.25, 0.5, 0.75, 1], [0, 0.18, 0.5, 0.82, 1]],
      ['strong S', [0, 0.2, 0.5, 0.8, 1], [0, 0.05, 0.5, 0.95, 1]],
      ['sharp knee', [0, 0.9, 0.95, 1], [0, 0.2, 0.9, 1]],
      ['log domain', LOG_DOMAIN_XS, LOG_DOMAIN_YS],
    ]

    for (const [name, xs, ys] of cases) {
      const size = curveLutResolution(xs, ys, LUT_TOLERANCE)
      const lut = sampleCurveLut(xs, ys, size)
      const first = xs[0] ?? Number.NaN
      const last = xs[xs.length - 1] ?? Number.NaN

      let worst = 0
      for (let i = 0; i <= 5000; i++) {
        const x = first + ((last - first) * i) / 5000
        worst = Math.max(worst, Math.abs(sampleLutLinearly(lut, xs, x) - evaluateCurve(xs, ys, x)))
      }
      expect(worst, `${name}: ${size} samples`).toBeLessThanOrEqual(LUT_TOLERANCE)
    }
  })

  it('scales the sample count with how sharp the curve is', () => {
    // A single round number would be wasteful for one of these and wrong for the
    // other: a sharp knee needs an order of magnitude more samples than a gentle
    // S over the same domain.
    const gentle = curveLutResolution([0, 0.5, 1], [0, 0.52, 1], LUT_TOLERANCE)
    const sharp = curveLutResolution([0, 0.9, 0.95, 1], [0, 0.2, 0.9, 1], LUT_TOLERANCE)
    expect(sharp).toBeGreaterThan(gentle * 5)
  })

  it('returns the floor for a straight line, which needs no samples at all', () => {
    expect(curveLutResolution([0, 1], [0, 1], LUT_TOLERANCE)).toBe(MIN_LUT_SIZE)
    expect(curveLutResolution([0, 0.5, 1], [0.2, 0.45, 0.7], LUT_TOLERANCE)).toBe(MIN_LUT_SIZE)
  })

  it('stays within a texture size every measured device can hold', () => {
    // A pathological curve must not produce a texture the device refuses.
    const brutal = curveLutResolution([0, 0.499, 0.501, 1], [0, 0.01, 0.99, 1], LUT_TOLERANCE)
    expect(brutal).toBeLessThanOrEqual(MAX_LUT_SIZE)
  })
})

describe('the LUT spans the control point range, not [0, 1]', () => {
  it('maps the curve domain onto the unit interval', () => {
    // The constraint from ARCHITECTURE.md section 6, exercised on a domain that
    // is not [0, 1] — otherwise the remap is the identity and the requirement is
    // documented but untested.
    expect(curveDomainToUnit(LOG_DOMAIN_XS, -4)).toBeCloseTo(0, 12)
    expect(curveDomainToUnit(LOG_DOMAIN_XS, 0)).toBeCloseTo(0.5, 12)
    expect(curveDomainToUnit(LOG_DOMAIN_XS, 4)).toBeCloseTo(1, 12)
  })

  it('clamps outside the domain rather than extrapolating', () => {
    // CLAMP_TO_EDGE on the texture does the same. Wrapping would turn a
    // highlight into a shadow.
    expect(curveDomainToUnit(LOG_DOMAIN_XS, -100)).toBe(0)
    expect(curveDomainToUnit(LOG_DOMAIN_XS, 100)).toBe(1)
  })

  it('samples the ends of a non-unit domain at the end control points', () => {
    const size = curveLutResolution(LOG_DOMAIN_XS, LOG_DOMAIN_YS, LUT_TOLERANCE)
    const lut = sampleCurveLut(LOG_DOMAIN_XS, LOG_DOMAIN_YS, size)
    expect(lut[0]).toBeCloseTo(LOG_DOMAIN_YS[0] ?? Number.NaN, 6)
    expect(lut[size - 1]).toBeCloseTo(LOG_DOMAIN_YS[LOG_DOMAIN_YS.length - 1] ?? Number.NaN, 6)
  })
})

describe('texel centres', () => {
  it('places the first and last samples at texel centres, not at 0 and 1', () => {
    // The classic lookup table bug is sampling at `unit` directly, which shifts
    // the whole curve by half a texel and looks completely plausible.
    const size = 64
    expect(lutTexCoord(0, size)).toBeCloseTo(0.5 / size, 12)
    expect(lutTexCoord(1, size)).toBeCloseTo((size - 0.5) / size, 12)
    expect(lutTexCoord(0.5, size)).toBeCloseTo((0.5 * (size - 1) + 0.5) / size, 12)
  })

  it('differs from the naive coordinate by exactly half a texel at the ends', () => {
    const size = 128
    expect(lutTexCoord(0, size) - 0).toBeCloseTo(0.5 / size, 12)
    expect(1 - lutTexCoord(1, size)).toBeCloseTo(0.5 / size, 12)
  })
})
