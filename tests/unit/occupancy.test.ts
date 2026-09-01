import { describe, expect, it } from 'vitest'

import {
  DISPLAY_WHITE_STOPS_ABOVE_GREY,
  halationExcess,
  halationThresholdLinear,
  HALATION_SHOULDER,
} from '../../src/core/colour/halation'
import { MIDDLE_GREY_LINEAR } from '../../src/core/colour/grade'
import { EDIT_PARAMETERS } from '../../src/core/state/editState'
import {
  binCentre,
  fractionAbove,
  fractionBetween,
  HISTOGRAM_LO,
  LUMINANCE_HISTOGRAMS,
} from '../fixtures/luminance-histograms'

/**
 * # The occupancy rule
 *
 * A parameter defined over an encoded domain, and a fixture labelled with a
 * tonal region, are both claims about where data is. Neither is checked by
 * anything else in the suite, and both have already been wrong here in ways that
 * looked entirely reasonable in the source:
 *
 * - The film curves' control points were spread evenly over ACEScct `[0.073, 1]`,
 *   whose top half decodes to eight stops above display white. Half the curve
 *   shaped pixels that cannot exist.
 * - A fixture named `highlight` was the linear value 1.4, which encodes to 0.58
 *   — the middle of the range, and as it happened the exact point where the
 *   channels cross, so the measurement it fed read near zero for a real effect.
 * - `halationThreshold` shipped a range of `[-1, 4]` carrying a comment claiming
 *   the whole of it was occupied. It is not: nothing in a display-referred image
 *   exceeds +2.474, so a third of the slider did nothing at all.
 *
 * Each was found by looking at a picture and wondering why. These assert the
 * same properties against a real distribution instead — see
 * `tests/fixtures/luminance-histograms.ts` for what is binned and why it is a
 * histogram rather than a photograph.
 */

const NIGHT = LUMINANCE_HISTOGRAMS.night
const TALK = LUMINANCE_HISTOGRAMS.talk
const BOTH = [
  ['night', NIGHT],
  ['talk', TALK],
] as const

/**
 * The fraction of an image the threshold actually acts on.
 *
 * Weighted by the smoothstep rather than counted above the threshold, because
 * the shader's shoulder spans `[t, t*sqrt(2)]` and a pixel just above `t`
 * contributes almost nothing. Counting the population above `t` overstates the
 * effect near the shoulder and — the case that matters — understates it when the
 * data sits inside the window rather than above it.
 */
function scatteringMass(histogram: readonly number[], thresholdStops: number): number {
  const threshold = halationThresholdLinear(thresholdStops)
  let weighted = 0
  let total = 0
  for (let i = 0; i < histogram.length; i++) {
    const count = histogram[i] ?? 0
    total += count
    const linear = MIDDLE_GREY_LINEAR * 2 ** binCentre(i)
    weighted += count * halationExcess(linear, threshold)
  }
  return total === 0 ? 0 : weighted / total
}

const halationThreshold = EDIT_PARAMETERS.find((p) => p.key === 'halationThreshold')

describe('the histograms are what the rule is checked against', () => {
  it('holds two real photographs that between them cover both failure directions', () => {
    // A low-key frame whose brightest object is not a light, and a high-key one
    // where an emissive panel and a white wall sit side by side. One threshold
    // has to be right on both, and a single fixture would let a wrong one pass.
    expect(fractionAbove(NIGHT, 0)).toBeLessThan(0.35)
    expect(fractionAbove(TALK, 0)).toBeGreaterThan(0.6)
  })

  it('contains nothing above display white, in either photograph', () => {
    // The ceiling the threshold's range has to respect, and the reason the top of
    // that range was dead. This is a property of display-referred 8-bit input
    // rather than of these two images: linear 1.0 is the largest value an sRGB
    // JPEG decodes to, and log2(1 / 0.18) is 2.474.
    expect(DISPLAY_WHITE_STOPS_ABOVE_GREY).toBeCloseTo(2.474, 3)
    for (const [name, histogram] of BOTH) {
      expect(
        fractionAbove(histogram, DISPLAY_WHITE_STOPS_ABOVE_GREY + 0.05),
        `${name} has pixels above display white`,
      ).toBe(0)
    }
  })
})

describe("halationThreshold's range matches where data lives", () => {
  it('is defined at all', () => {
    expect(halationThreshold).toBeDefined()
  })

  it('reaches display white but does not run far past it', () => {
    if (!halationThreshold) return
    // Above display white the effect is identically zero until exposure lifts the
    // image, so range beyond it is slider travel that does nothing. Some headroom
    // is deliberate — exposure is a real control and raises the ceiling stop for
    // stop — but the useful band has to be a meaningful share of the travel, not
    // a sliver at one end.
    expect(halationThreshold.max).toBeGreaterThan(DISPLAY_WHITE_STOPS_ABOVE_GREY)
    expect(halationThreshold.max).toBeLessThanOrEqual(DISPLAY_WHITE_STOPS_ABOVE_GREY + 1)
  })

  it('spends most of its travel on positions a photograph occupies', () => {
    if (!halationThreshold) return
    const span = halationThreshold.max - halationThreshold.min
    const occupied = Math.min(halationThreshold.max, DISPLAY_WHITE_STOPS_ABOVE_GREY)
      - halationThreshold.min
    // The range that shipped scored 0.69 here and still read as reasonable. Two
    // thirds is the bar: a slider whose last third is inert is a bug the user
    // discovers by dragging it and seeing nothing happen.
    expect(occupied / span).toBeGreaterThan(0.8)
  })
})

describe("halationThreshold's default is in the highlights of a real image", () => {
  it('leaves merely light-toned surfaces alone', () => {
    if (!halationThreshold) return
    // The bug this replaces: at the old default of +1.5 the white brick wall
    // behind the speaker glowed pink, because 31% of that photograph is above
    // +1.5 and a third of a picture is not a highlight.
    expect(fractionAbove(TALK, 1.5)).toBeGreaterThan(0.25)
    expect(
      scatteringMass(TALK, halationThreshold.defaultValue),
      'the default scatters a share of the frame too large to be highlights',
    ).toBeLessThan(0.05)
  })

  it('still has something to act on, in both photographs', () => {
    if (!halationThreshold) return
    // The other direction, and the one a narrower range walks into: a threshold
    // high enough to be safe everywhere is off everywhere.
    //
    // Weighed over the smoothstep window rather than counted above the threshold.
    // On the night frame the population strictly above the default is 0.003% and
    // the effect is still visible — 38 levels out of 255 on the brightest folds
    // of a shirt — so a bar set on the count would call a visible effect absent.
    for (const [name, histogram] of BOTH) {
      expect(
        scatteringMass(histogram, halationThreshold.defaultValue),
        `${name} has nothing inside the scattering window`,
      ).toBeGreaterThan(0)
    }
  })

  it('scatters a real but contained share of a frame that has genuine highlights', () => {
    if (!halationThreshold) return
    // The night frame cannot carry this assertion — almost nothing in it is a
    // light source, so almost nothing should scatter, and requiring a share there
    // would only push the default down until the shirts glowed again.
    const mass = scatteringMass(TALK, halationThreshold.defaultValue)
    expect(mass).toBeGreaterThan(1e-3)
    expect(mass).toBeLessThan(0.05)
  })

  it('acts on the two photographs by wildly different amounts, which is correct', () => {
    if (!halationThreshold) return
    // Recorded as the intended behaviour rather than tolerated as residual error.
    // Halation is a threshold phenomenon in absolute exposure and film does not
    // rebalance per frame: a night scene lit by one flash should show almost none
    // and a room full of lights should show some. Normalising the threshold per
    // image would even this out and would be content-derived adaptivity — the
    // thing ruled out in `renderer.ts` for the drag proxy, for the same reason.
    const night = scatteringMass(NIGHT, halationThreshold.defaultValue)
    const talk = scatteringMass(TALK, halationThreshold.defaultValue)
    expect(talk / night).toBeGreaterThan(100)
  })

  it('sits in the band where the two photographs disagree least', () => {
    if (!halationThreshold) return
    // Not a normalisation. Halation is a threshold phenomenon in absolute
    // exposure and film does not rebalance per frame, so a low-key photograph
    // showing almost none is correct rather than residual error. What this
    // asserts is only that the default is not in the region where the bright
    // photograph washes out — which begins below +1.8.
    expect(halationThreshold.defaultValue).toBeGreaterThanOrEqual(1.8)
    expect(halationThreshold.defaultValue).toBeLessThan(DISPLAY_WHITE_STOPS_ABOVE_GREY)
  })

  it('lets the brightest pixels an image can hold scatter at full strength', () => {
    if (!halationThreshold) return
    // The shoulder is half a stop wide and multiplicative, so a high threshold
    // pushes the top of the window past display white and nothing in the picture
    // ever reaches full scattering — the effect gets quietly weak and is then
    // tuned back with strength, which widens it instead of brightening it.
    //
    // Stated as what display white achieves rather than as the window sitting
    // wholly inside the data, which is very slightly stricter than it needs to be
    // and would reject a default that is fine.
    const excessAtWhite = halationExcess(1, halationThresholdLinear(halationThreshold.defaultValue))
    expect(excessAtWhite).toBeGreaterThan(0.9)
    const upper = halationThreshold.defaultValue + Math.log2(HALATION_SHOULDER)
    expect(fractionBetween(TALK, halationThreshold.defaultValue, upper)).toBeGreaterThan(0)
  })
})

describe('fixtures labelled with a tonal region fall in that region', () => {
  // `film-stock.test.ts` samples crossover at -3 and +2 stops from grey and calls
  // them shadow and highlight. Being expressed in stops makes the labels
  // defensible by construction; it does not make them true of any actual image,
  // which is what the earlier "1.4 linear is a highlight" mistake was.
  const SHADOW_STOPS = -3
  const HIGHLIGHT_STOPS = 2

  it('puts the shadow sample in the bottom of a real distribution', () => {
    for (const [name, histogram] of BOTH) {
      expect(
        fractionAbove(histogram, SHADOW_STOPS),
        `${name}: the shadow sample is above most of the image`,
      ).toBeGreaterThan(0.5)
    }
    // And in the night frame specifically, which is genuinely low-key, it must
    // still be low enough to have pixels beneath it — a "shadow" at the very
    // bottom of the range measures the curve running out, not the shadows.
    expect(1 - fractionAbove(NIGHT, SHADOW_STOPS)).toBeGreaterThan(0.05)
  })

  it('puts the highlight sample in the top of a real distribution', () => {
    for (const [name, histogram] of BOTH) {
      const above = fractionAbove(histogram, HIGHLIGHT_STOPS)
      expect(above, `${name}: the highlight sample has nothing above it`).toBeGreaterThan(0)
      expect(above, `${name}: the highlight sample is not in the highlights`).toBeLessThan(0.1)
    }
  })

  it('does not place either sample outside what an image can contain', () => {
    expect(HIGHLIGHT_STOPS).toBeLessThan(DISPLAY_WHITE_STOPS_ABOVE_GREY)
    expect(SHADOW_STOPS).toBeGreaterThan(HISTOGRAM_LO)
  })
})
