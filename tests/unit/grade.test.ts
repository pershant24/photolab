import { describe, expect, it } from 'vitest'

import {
  CONTRAST_PIVOT_ACESCCT,
  MIDDLE_GREY_LINEAR,
  applyContrast,
  applyContrastRgb,
  applyExposure,
  applyExposureRgb,
} from '../../src/core/colour/grade'
import { ACESCCT_X_BRK, encodeACEScct } from '../../src/core/colour/transfer'

describe('exposure', () => {
  it('is identity at zero stops', () => {
    for (const v of [0, 0.02, 0.18, 1, 40]) {
      expect(applyExposure(v, 0)).toBe(v)
    }
  })

  it('doubles per stop up and halves per stop down', () => {
    expect(applyExposure(0.18, 1)).toBeCloseTo(0.36, 12)
    expect(applyExposure(0.18, -1)).toBeCloseTo(0.09, 12)
    expect(applyExposure(0.18, 3)).toBeCloseTo(1.44, 12)
    expect(applyExposure(0.18, -2)).toBeCloseTo(0.045, 12)
  })

  it('is a pure scale, so it composes additively in stops', () => {
    for (const v of [0.01, 0.18, 2.5]) {
      expect(applyExposure(applyExposure(v, 1.3), 0.7)).toBeCloseTo(applyExposure(v, 2), 12)
    }
  })

  it('applies the same gain to all three channels', () => {
    const out = applyExposureRgb([0.1, 0.2, 0.4], 1)
    expect(out[0]).toBeCloseTo(0.2, 12)
    expect(out[1]).toBeCloseTo(0.4, 12)
    expect(out[2]).toBeCloseTo(0.8, 12)
  })
})

describe('contrast', () => {
  it('pivots at the encoded value of middle grey, not at the literal 0.18', () => {
    // The trap this closes: 0.18 linear encodes to roughly 0.4136 in ACEScct,
    // so pivoting at 0.18 in encoded space sits about two and a half stops
    // below middle grey and lifts the whole image as it steepens.
    expect(CONTRAST_PIVOT_ACESCCT).toBe(encodeACEScct(MIDDLE_GREY_LINEAR))
    expect(CONTRAST_PIVOT_ACESCCT).toBeCloseTo(0.4135884, 6)
    expect(CONTRAST_PIVOT_ACESCCT).not.toBeCloseTo(MIDDLE_GREY_LINEAR, 2)
  })

  it('is identity at a slope of 1', () => {
    for (const v of [-0.01, 0, 0.002, 0.05, 0.18, 1, 12]) {
      expect(applyContrast(v, 1)).toBeCloseTo(v, 9)
    }
  })

  it('leaves middle grey fixed at every slope', () => {
    for (const slope of [0, 0.5, 1, 1.4, 2, 4]) {
      expect(applyContrast(MIDDLE_GREY_LINEAR, slope)).toBeCloseTo(MIDDLE_GREY_LINEAR, 12)
    }
  })

  it('darkens below the pivot and brightens above it as slope increases', () => {
    expect(applyContrast(0.05, 1.5)).toBeLessThan(0.05)
    expect(applyContrast(0.6, 1.5)).toBeGreaterThan(0.6)
    expect(applyContrast(0.05, 0.5)).toBeGreaterThan(0.05)
    expect(applyContrast(0.6, 0.5)).toBeLessThan(0.6)
  })

  it('flattens to middle grey at a slope of zero', () => {
    for (const v of [0.01, 0.18, 4]) {
      expect(applyContrast(v, 0)).toBeCloseTo(MIDDLE_GREY_LINEAR, 12)
    }
  })

  it('is a power law about middle grey in linear light, derived independently', () => {
    // A second derivation of the same quantity. Above the ACEScct break point
    // the encoding is pure log, so scaling the distance from the pivot by
    // `slope` is exactly raising the linear ratio to that power:
    //
    //     out = 0.18 * (in / 0.18) ^ slope
    //
    // Agreement between this closed form and the encode/pivot/decode
    // implementation checks the pivot, the log constants and the direction of
    // the operation at once, and it would fail for a pivot of 0.18-in-encoded
    // space even though that pivot also leaves some value fixed.
    let checked = 0
    for (const slope of [0.4, 1, 1.6, 2.5]) {
      for (const v of [0.01, 0.05, MIDDLE_GREY_LINEAR, 0.5, 2, 30]) {
        const closedForm = MIDDLE_GREY_LINEAR * Math.pow(v / MIDDLE_GREY_LINEAR, slope)

        // The identity is a property of the log segment. Both ends have to be
        // on it: an input or a result below the break point rides the linear
        // toe instead, which is the next test.
        if (v <= ACESCCT_X_BRK || closedForm <= ACESCCT_X_BRK) continue

        expect(applyContrast(v, slope)).toBeCloseTo(closedForm, 9)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(15)
  })

  it('departs from that power law inside the ACEScct toe, by design', () => {
    // Watched, not assumed: a slope of 1.6 on 0.01 linear lands below the break
    // point, where the linear toe governs. The pure-log form would give
    // 0.00177; the toe gives -0.0038.
    //
    // A negative result is correct and is not clipped here. ACEScg is
    // scene-referred and holds negatives legitimately; clamping at this stage
    // would flatten shadow detail that the display transform's gamut
    // compression is the right place to resolve. The property that matters is
    // that the operator stays finite and ordered, which the next test asserts.
    const slope = 1.6
    const input = 0.01
    const pureLog = MIDDLE_GREY_LINEAR * Math.pow(input / MIDDLE_GREY_LINEAR, slope)

    expect(pureLog).toBeLessThan(ACESCCT_X_BRK)
    expect(applyContrast(input, slope)).toBeCloseTo(-0.0038075, 6)
    expect(applyContrast(input, slope)).toBeLessThan(pureLog)
  })

  it('is monotonically increasing at every positive slope', () => {
    // The property that has to survive the toe. A contrast control that
    // reordered two values would invert local contrast somewhere in the
    // shadows, which is the same artifact the curve module avoids by using a
    // monotone spline.
    for (const slope of [0.25, 1, 1.6, 3]) {
      let previous = -Infinity
      for (let i = 0; i <= 1000; i++) {
        const v = -0.05 + (i / 1000) * 8
        const out = applyContrast(v, slope)
        expect(out).toBeGreaterThan(previous)
        previous = out
      }
    }
  })

  it('increases saturation, which is intentional and is why it is per channel', () => {
    // Recorded as a test rather than only as a comment so that a future
    // luminance-preserving variant is added as a separate mode instead of
    // silently replacing this one. Per-channel contrast raises the ratio
    // between two channels to the power of the slope, and a wider channel ratio
    // is a more saturated colour.
    const source: [number, number, number] = [0.09, 0.18, 0.36]
    const graded = applyContrastRgb(source, 2)

    const sourceRatio = source[2] / source[0]
    const gradedRatio = graded[2] / graded[0]
    expect(gradedRatio).toBeGreaterThan(sourceRatio)
    expect(gradedRatio).toBeCloseTo(Math.pow(sourceRatio, 2), 6)

    // A neutral has a channel ratio of 1, and 1 to any power is 1, so neutrals
    // stay neutral. The saturation change acts only on colours that had some.
    const neutral = applyContrastRgb([0.5, 0.5, 0.5], 2)
    expect(neutral[0]).toBeCloseTo(neutral[1], 12)
    expect(neutral[1]).toBeCloseTo(neutral[2], 12)
  })

  it('survives negative and zero input, which is why it works in ACEScct', () => {
    // ACEScc would send these to negative infinity. Values below the ACEScct
    // break point ride its linear toe instead.
    expect(Number.isFinite(applyContrast(0, 1.5))).toBe(true)
    expect(Number.isFinite(applyContrast(-0.01, 1.5))).toBe(true)
    expect(applyContrast(0, 1.5)).toBeLessThan(MIDDLE_GREY_LINEAR)
  })
})
