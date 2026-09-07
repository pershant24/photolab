import { describe, expect, it } from 'vitest'

import {
  GAMUT_COMPRESS_THRESHOLD,
  TONE_MAP_KNEE,
  gamutCompressRgb,
  toneMapChannel,
} from '../../src/core/colour/display'
import {
  ACESCCT_X_BRK,
  ACESCCT_Y_BRK,
  SRGB_ENCODED_BREAK,
  SRGB_LINEAR_BREAK,
  decodeACEScct,
  encodeACEScct,
  srgbEotf,
  srgbOetf,
} from '../../src/core/colour/transfer'
import { HSL_BAND_SPACING, bandWeights, bandedValue } from '../../src/core/colour/hsl'
import { ZONE_A_HIGH, ZONE_A_LOW, ZONE_B_HIGH, ZONE_B_LOW, zoneWeights } from '../../src/core/colour/wheels'
import { SPLIT_TRANSITION_STOPS, highlightShare } from '../../src/core/colour/splitTone'
import { HALATION_SHOULDER, halationExcess } from '../../src/core/colour/halation'
import type { Vec3 } from '../../src/core/colour/types'

/**
 * Every boundary in the pipeline, probed either side of itself.
 *
 * # Why this is a unit test and not a golden image
 *
 * The gamut compressor carried a 63 code value cliff and every golden test
 * passed. `tests/golden/boundaries.spec.ts` now puts a fixture across each
 * boundary so the regions are at least *exercised* by a render — but a golden
 * fixture cannot prove continuity, and it is worth being exact about why.
 *
 * A source image is 8-bit. Its values are a fixed lattice with a spacing of
 * 1/255, and refining the ramp does not refine the input: adjacent columns
 * either land on the same lattice point or a neighbouring one. So the largest
 * step between adjacent rendered samples confuses two different things — a
 * genuine discontinuity, and a place where the pipeline is merely **steep**.
 * That is not hypothetical: the HSL sweep's worst adjacent delta is 32 code
 * values, and it is the sRGB encode's slope near black, reached smoothly over
 * four columns. Correct behaviour that looks exactly like the defect.
 *
 * Here the input is a real number, so ε can be 1e-9 and the two cases separate
 * cleanly: across a continuous boundary the output moves by something of order
 * ε, and across a step it moves by the step regardless of how small ε gets.
 * **That is the assertion, and it is the one that would have caught the cliff.**
 *
 * # The enumeration
 *
 * Taken from the source. Each boundary appears once, with the fixture that
 * covers it in the golden spec named alongside.
 */

/** Small enough that any legitimate slope contributes far below a code value. */
const EPS = 1e-9

/**
 * How far the output may move across a boundary, per unit of ε.
 *
 * Generous: a slope of 1e6 is absurd for any of these and still passes, while
 * the cliff this exists for is a *constant* 0.05 that ε cannot shrink. The two
 * are separated by orders of magnitude, so the exact figure is not load-bearing.
 */
const MAX_SLOPE = 1e6

function assertContinuous(
  name: string,
  at: number,
  f: (x: number) => number,
  eps: number = EPS,
): void {
  const below = f(at - eps)
  const above = f(at + eps)
  const jump = Math.abs(above - below)
  expect(
    jump,
    `${name}: f(${at} - ${eps}) = ${below}, f(${at} + ${eps}) = ${above} — a step of ${jump}`,
  ).toBeLessThanOrEqual(MAX_SLOPE * eps)
}

describe('the transfer functions meet at their break points', () => {
  it('sRGB, encoding and decoding, at the piecewise break', () => {
    // Covered in the golden spec by the neutral ramp through near-black.
    assertContinuous('srgbOetf at SRGB_LINEAR_BREAK', SRGB_LINEAR_BREAK, srgbOetf)
    assertContinuous('srgbEotf at SRGB_ENCODED_BREAK', SRGB_ENCODED_BREAK, srgbEotf)
  })

  it('ACEScct, encoding and decoding, at the log/linear splice', () => {
    // Covered in the golden spec by the shadow ramp through the film curves.
    assertContinuous('encodeACEScct at ACESCCT_X_BRK', ACESCCT_X_BRK, encodeACEScct)
    assertContinuous('decodeACEScct at ACESCCT_Y_BRK', ACESCCT_Y_BRK, decodeACEScct)
  })

  it('round-trips across both breaks, which is the property that matters', () => {
    for (const x of [
      SRGB_LINEAR_BREAK - EPS,
      SRGB_LINEAR_BREAK,
      SRGB_LINEAR_BREAK + EPS,
      ACESCCT_X_BRK - EPS,
      ACESCCT_X_BRK,
      ACESCCT_X_BRK + EPS,
    ]) {
      // Relative, not absolute. These values are ~3e-3, and a `toBeCloseTo(x, 9)`
      // asks for 5e-10 absolute — tighter than a double round trip through two
      // `pow` calls can deliver. Measured error at the sRGB break is 2.2e-9,
      // which is 7e-7 relative and entirely ordinary. Asserting the wrong kind
      // of tolerance would have made this a permanent red herring.
      const rel = (got: number): number => Math.abs(got - x) / Math.max(Math.abs(x), 1e-6)
      expect(rel(srgbEotf(srgbOetf(x))), `sRGB round trip at ${x}`).toBeLessThan(1e-6)
      expect(rel(decodeACEScct(encodeACEScct(x))), `ACEScct round trip at ${x}`).toBeLessThan(1e-6)
    }
  })
})

describe('the shaped operators meet their identity sections', () => {
  it('the tone map at its knee', () => {
    // Covered in the golden spec by the neutral ramp lifted two stops.
    assertContinuous('toneMapChannel at TONE_MAP_KNEE', TONE_MAP_KNEE, (x) =>
      toneMapChannel(x, TONE_MAP_KNEE),
    )
  })

  it('the colour wheels at all four zone edges', () => {
    // Covered in the golden spec by the full neutral ramp with opposing wheels.
    for (const [name, edge] of [
      ['ZONE_A_LOW', ZONE_A_LOW],
      ['ZONE_A_HIGH', ZONE_A_HIGH],
      ['ZONE_B_LOW', ZONE_B_LOW],
      ['ZONE_B_HIGH', ZONE_B_HIGH],
    ] as const) {
      for (const which of ['lift', 'gamma', 'gain'] as const) {
        assertContinuous(`zoneWeights.${which} at ${name}`, edge, (x) => zoneWeights(x)[which])
      }
    }
  })

  it('the split tone window at both edges', () => {
    // Covered in the golden spec by the same neutral ramp.
    const balance = -0.5
    const half = SPLIT_TRANSITION_STOPS / 2
    for (const edge of [balance - half, balance + half]) {
      assertContinuous(`highlightShare at ${edge}`, edge, (x) => highlightShare(x, balance))
    }
  })

  it("halation's threshold window at both edges", () => {
    // Covered in the golden spec by the bright spot ramp. The window is
    // [t, t * sqrt(2)], so both ends are probed — the lower one is where the
    // smoothstep leaves zero and the upper is where it reaches one, and a step
    // at either would put a hard edge into the middle of a highlight.
    const threshold = 1.2
    assertContinuous('halationExcess at the window floor', threshold, (x) =>
      halationExcess(x, threshold),
    )
    assertContinuous('halationExcess at the window ceiling', threshold * HALATION_SHOULDER, (x) =>
      halationExcess(x, threshold),
    )
  })

  it('the HSL band weights at every band edge', () => {
    // Covered in the golden spec by the hue sweep with alternating bands.
    const bands = [1, -1, 1, -1, 1, -1]
    for (let i = 0; i < 6; i++) {
      const edge = i * HSL_BAND_SPACING
      for (let b = 0; b < 6; b++) {
        assertContinuous(`bandWeights[${b}] at ${edge} degrees`, edge, (h) => bandWeights(h)[b]!)
      }
      assertContinuous(`bandedValue at ${edge} degrees`, edge, (h) => bandedValue(h, bands))
    }
  })

  it('the HSL band weights sum to one at every edge, not merely away from them', () => {
    for (let i = 0; i < 6; i++) {
      for (const h of [i * HSL_BAND_SPACING - EPS, i * HSL_BAND_SPACING, i * HSL_BAND_SPACING + EPS]) {
        const sum = bandWeights(h).reduce((a, b) => a + b, 0)
        expect(sum, `weights at ${h} degrees`).toBeCloseTo(1, 12)
      }
    }
  })
})

describe('the gamut gate', () => {
  /**
   * The one that shipped broken, and the reason this file exists.
   *
   * The gate is a sign test, so it is a genuine discontinuity in the *trigger*.
   * What must be continuous is the **operator across it**: a colour a hair
   * outside the gamut must come back a hair different from one a hair inside.
   *
   * With the shouldered operator this failed by 0.05 of the achromatic value —
   * 63 code values on the probe below — no matter how small ε was, because the
   * shoulder's knee sat at 0.9 while the gate opened at 1.0. `1 / distance` is
   * the only knee that closes that gap, and this is what holds it closed.
   */
  it('moves a colour across the boundary by an amount of order epsilon', () => {
    // Covered in the golden spec by the saturated hue sweep pushed by HSL.
    for (const base of [
      [1, 0, 0.5],
      [1, 0, 0],
      [2.75, 0.887, 0],
      [0.4, 0, 0.4],
      [0.05, 0, 0.02],
    ] as Vec3[]) {
      for (const eps of [1e-6, 1e-9, 1e-12]) {
        const inside = gamutCompressRgb(
          [base[0], base[1] + eps, base[2]],
          GAMUT_COMPRESS_THRESHOLD,
        )
        const outside = gamutCompressRgb(
          [base[0], base[1] - eps, base[2]],
          GAMUT_COMPRESS_THRESHOLD,
        )
        for (let c = 0; c < 3; c++) {
          const jump = Math.abs(outside[c]! - inside[c]!)
          expect(
            jump,
            `[${base.join(', ')}] channel ${c} across the gate at eps ${eps}: step of ${jump}`,
          ).toBeLessThanOrEqual(MAX_SLOPE * eps)
        }
      }
    }
  })

  it('changes a colour by no more than its excursion, which is what buys that', () => {
    // The bound stated directly. It is what makes the operator well conditioned
    // at a boundary two implementations cannot agree on the sign of.
    for (const rgb of [
      [1, -1e-9, 0.5],
      [1, -0.001, 0.5],
      [2.75, 0.887, -6.1e-5],
      [1, -0.05, -0.4],
      [0.4, -0.9, 0.2],
      [40, -0.2, 3],
    ] as Vec3[]) {
      const excursion = -Math.min(rgb[0], rgb[1], rgb[2])
      const out = gamutCompressRgb(rgb, GAMUT_COMPRESS_THRESHOLD)
      for (let c = 0; c < 3; c++) {
        const change = Math.abs(out[c]! - rgb[c]!)
        expect(
          change,
          `[${rgb.join(', ')}] channel ${c} moved ${change} on an excursion of ${excursion}`,
        ).toBeLessThanOrEqual(excursion + 1e-12)
      }
    }
  })
})
