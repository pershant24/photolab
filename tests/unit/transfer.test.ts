import { describe, expect, it } from 'vitest'

import {
  ACESCCT_A,
  ACESCCT_B,
  ACESCCT_LOG_OFFSET,
  ACESCCT_LOG_SCALE,
  ACESCCT_MAX_ENCODED,
  ACESCCT_MAX_LINEAR,
  ACESCCT_X_BRK,
  ACESCCT_Y_BRK,
  SRGB_ALPHA,
  SRGB_ENCODED_BREAK,
  SRGB_GAMMA,
  SRGB_LINEAR_BREAK,
  SRGB_SLOPE,
  decodeACEScct,
  encodeACEScct,
  srgbEotf,
  srgbOetf,
} from '../../src/core/colour/transfer'

describe('sRGB transfer functions', () => {
  // Chosen to straddle every structural feature: the origin, where the linear
  // segment matters and the 2.2 approximation is wrong; both sides of the
  // piecewise break, where a mismatched pair of thresholds shows up; and unity,
  // which must be exact or white is not white.
  const ENCODED_RAMP = [
    0, 1e-8, 0.001, 0.01, SRGB_ENCODED_BREAK - 1e-6, SRGB_ENCODED_BREAK,
    SRGB_ENCODED_BREAK + 1e-6, 0.05, 0.2, 0.5, 0.75, 0.9999, 1,
  ]

  const LINEAR_RAMP = [
    0, 1e-8, 0.0001, SRGB_LINEAR_BREAK - 1e-9, SRGB_LINEAR_BREAK,
    SRGB_LINEAR_BREAK + 1e-9, 0.01, 0.18, 0.5, 1,
  ]

  // The specification's two thresholds are rounded, so the segments they divide
  // cross at 0.0031308072830676845 rather than at 0.0031308. A value inside that
  // 2.33e-9 gap takes the linear branch in one direction and the power branch in
  // the other, which bounds the round trip there. Away from the gap the round
  // trip is exact to floating point. Both facts are asserted, because a single
  // loose tolerance would hide a real error everywhere else on the ramp.
  // Measured at 2.33e-9; carried at 2.4e-9 so the bound is not sitting exactly
  // on the observed value.
  const BREAK_GAP_LINEAR = 2.4e-9

  // The same discrepancy seen from encoded space is the linear gap multiplied
  // by the slope of the segment it falls on, so this bound is derived rather
  // than tuned until the test passed. Observed 2.96e-8 against a bound of
  // 3.1e-8; had it been tuned, the agreement with 12.92 would be a coincidence.
  const BREAK_GAP_ENCODED = BREAK_GAP_LINEAR * SRGB_SLOPE

  it('round trips encoded -> linear -> encoded across the ramp', () => {
    for (const v of ENCODED_RAMP) {
      expect(Math.abs(srgbOetf(srgbEotf(v)) - v)).toBeLessThan(BREAK_GAP_ENCODED)
    }
  })

  it('round trips linear -> encoded -> linear across the ramp', () => {
    for (const v of LINEAR_RAMP) {
      expect(Math.abs(srgbEotf(srgbOetf(v)) - v)).toBeLessThan(BREAK_GAP_LINEAR)
    }
  })

  it('round trips to floating point exactness away from the break point', () => {
    const clearOfBreak = (v: number): boolean =>
      Math.abs(v - SRGB_LINEAR_BREAK) > 1e-6 && Math.abs(v - SRGB_ENCODED_BREAK) > 1e-6
    for (const v of ENCODED_RAMP.filter(clearOfBreak)) {
      expect(srgbOetf(srgbEotf(v))).toBeCloseTo(v, 12)
    }
    for (const v of LINEAR_RAMP.filter(clearOfBreak)) {
      expect(srgbEotf(srgbOetf(v))).toBeCloseTo(v, 12)
    }
  })

  it('is exact at the anchors that define the encoding', () => {
    expect(srgbEotf(0)).toBe(0)
    expect(srgbOetf(0)).toBe(0)
    expect(srgbEotf(1)).toBeCloseTo(1, 15)
    expect(srgbOetf(1)).toBeCloseTo(1, 15)
  })

  it('uses the piecewise definition, not the 2.2 gamma approximation', () => {
    // Below the break the curve is a straight line of slope 12.92. The 2.2
    // approximation has zero slope at the origin and cannot reproduce this.
    expect(srgbEotf(0.02)).toBeCloseTo(0.02 / SRGB_SLOPE, 15)
    expect(srgbEotf(0.02)).not.toBeCloseTo(Math.pow(0.02, 2.2), 6)

    // Above the break it is the offset power law with the specified exponent.
    expect(srgbEotf(0.5)).toBeCloseTo(Math.pow((0.5 + SRGB_ALPHA) / (1 + SRGB_ALPHA), SRGB_GAMMA), 15)
  })

  it('has segments that meet at the break point to the precision the rounded thresholds allow', () => {
    const fromLinearSegment = SRGB_ENCODED_BREAK / SRGB_SLOPE
    const fromPowerSegment = Math.pow(
      (SRGB_ENCODED_BREAK + SRGB_ALPHA) / (1 + SRGB_ALPHA),
      SRGB_GAMMA,
    )
    // Not exact, and not expected to be: the published thresholds carry five
    // and four significant digits respectively. Measured gap 2.33e-9. Asserted
    // tightly enough that a genuinely wrong constant — a transposed digit, the
    // 2.2 exponent, 12.9 for 12.92 — moves it by orders of magnitude and fails.
    expect(Math.abs(fromLinearSegment - fromPowerSegment)).toBeLessThan(1e-8)
  })

  it('extends to negative values by odd symmetry rather than producing NaN', () => {
    for (const v of [0.001, 0.02, 0.5, 1, 4]) {
      expect(srgbEotf(-v)).toBe(-srgbEotf(v))
      expect(srgbOetf(-v)).toBe(-srgbOetf(v))
    }
    expect(Number.isNaN(srgbEotf(-0.5))).toBe(false)
    expect(Number.isNaN(srgbOetf(-0.5))).toBe(false)
  })
})

describe('ACEScct transfer functions', () => {
  // The published constants are not independent quantities. Deriving each of
  // them from the log segment and checking the stored value against the
  // derivation validates them without reference to where they were transcribed
  // from, which is the point of having them in a specification at all.
  it('has a slope constant equal to the log segment slope at the break point', () => {
    const logSlopeAtBreak = 1 / (ACESCCT_X_BRK * Math.LN2 * ACESCCT_LOG_SCALE)
    expect(ACESCCT_A).toBeCloseTo(logSlopeAtBreak, 12)
  })

  it('has an offset constant that places the linear segment on the log segment', () => {
    expect(ACESCCT_B).toBeCloseTo(ACESCCT_Y_BRK - ACESCCT_A * ACESCCT_X_BRK, 15)
  })

  it('has a linear segment that meets the log segment at the break point', () => {
    // Compared against the log function itself, not against the stored Y_BRK.
    // Comparing two stored constants to each other would pass even if both were
    // wrong; this passes only if A and B are genuinely right.
    const fromLinearSegment = ACESCCT_A * ACESCCT_X_BRK + ACESCCT_B
    const fromLogSegment = (Math.log2(ACESCCT_X_BRK) + ACESCCT_LOG_OFFSET) / ACESCCT_LOG_SCALE
    expect(fromLinearSegment).toBeCloseTo(fromLogSegment, 15)
    expect(ACESCCT_Y_BRK).toBeCloseTo(fromLogSegment, 15)
  })

  it('round trips linear -> ACEScct -> linear, including negatives', () => {
    // Negative values are the whole reason for ACEScct over ACEScc, so the ramp
    // includes them. The upper end stops below the clamp: values above it are
    // documented to saturate, not to round trip.
    const ramp = [
      -1, -0.05, -0.001, 0, 1e-6, 0.001, ACESCCT_X_BRK - 1e-9, ACESCCT_X_BRK,
      ACESCCT_X_BRK + 1e-9, 0.05, 0.18, 0.5, 1, 16, 1000, 65503,
    ]
    for (const v of ramp) {
      expect(decodeACEScct(encodeACEScct(v))).toBeCloseTo(v, 9)
    }
  })

  it('round trips ACEScct -> linear -> ACEScct below the clamp', () => {
    for (const v of [-0.2, 0, 0.05, ACESCCT_Y_BRK, 0.2, 0.4, 0.8, 1.4]) {
      expect(encodeACEScct(decodeACEScct(v))).toBeCloseTo(v, 12)
    }
  })

  it('is monotonically increasing', () => {
    let previous = -Infinity
    for (let i = 0; i <= 2000; i++) {
      const linear = -1 + (i / 2000) * 18
      const encoded = encodeACEScct(linear)
      expect(encoded).toBeGreaterThan(previous)
      previous = encoded
    }
  })

  it('clamps decoding at the maximum half float, as specified', () => {
    expect(decodeACEScct(ACESCCT_MAX_ENCODED)).toBe(ACESCCT_MAX_LINEAR)
    expect(decodeACEScct(ACESCCT_MAX_ENCODED + 1)).toBe(ACESCCT_MAX_LINEAR)
    expect(ACESCCT_MAX_ENCODED).toBeCloseTo(1.468, 3)
  })

  it('handles zero and near-zero without diverging, unlike ACEScc', () => {
    expect(encodeACEScct(0)).toBe(ACESCCT_B)
    expect(Number.isFinite(encodeACEScct(0))).toBe(true)
    expect(Number.isFinite(encodeACEScct(-1))).toBe(true)
  })
})
