import { describe, expect, it } from 'vitest'

import {
  GRAIN_CHANNEL_SIZES,
  GRAIN_FULL_AMPLITUDE_PERIOD,
  GRAIN_PEAK_STOPS_FROM_GREY,
  GRAIN_SHOULDER_STOPS,
  GRAIN_TOE_STOPS,
  GRAIN_VANISHED_PERIOD,
  grainAmplitudeScale,
  grainDensityModulation,
  grainDensityModulationFromEncoded,
  grainDivergenceSourcePixels,
  grainPeriodSourcePixels,
} from '../../src/core/colour/grain'
import {
  DISPLAY_WHITE_ACESCCT,
  FILM_DOMAIN_LOW,
  MIDDLE_GREY_ACESCCT,
  STOP_IN_ACESCCT,
  stopsFromGrey,
} from '../../src/core/colour/filmStock'
import { DISPLAY_WHITE_STOPS_ABOVE_GREY } from '../../src/core/colour/halation'
import { EDIT_PARAMETERS } from '../../src/core/state/editState'
import { binCentre, LUMINANCE_HISTOGRAMS } from '../fixtures/luminance-histograms'

const GRAIN_SIZE_MIN = EDIT_PARAMETERS.find((p) => p.key === 'grainSize')?.min ?? 0

const NIGHT = LUMINANCE_HISTOGRAMS.night
const TALK = LUMINANCE_HISTOGRAMS.talk

/** Share of a frame carrying grain, weighted by the modulation. */
function grainMass(histogram: readonly number[], peakStops: number): number {
  let weighted = 0
  let total = 0
  for (let i = 0; i < histogram.length; i++) {
    const count = histogram[i] ?? 0
    total += count
    const offset = binCentre(i) - peakStops
    const reach = offset < 0 ? GRAIN_TOE_STOPS : GRAIN_SHOULDER_STOPS
    const x = Math.min(1, Math.abs(offset) / reach)
    weighted += count * (1 - x * x * (3 - 2 * x))
  }
  return total === 0 ? 0 : weighted / total
}

describe('grain density modulation', () => {
  it('peaks at the peak and vanishes at the ends, with no edge where it runs out', () => {
    expect(grainDensityModulation(GRAIN_PEAK_STOPS_FROM_GREY)).toBe(1)
    expect(grainDensityModulation(-GRAIN_TOE_STOPS)).toBe(0)
    expect(grainDensityModulation(GRAIN_SHOULDER_STOPS)).toBe(0)
    // Beyond the reach it stays at zero rather than turning around, which the
    // abs() would do without the clamp.
    expect(grainDensityModulation(-40)).toBe(0)
    expect(grainDensityModulation(40)).toBe(0)

    // Zero slope at both ends: a linear falloff leaves a visible boundary where
    // the grain stops, which reads as a band across the shadows.
    const eps = 1e-3
    expect(Math.abs(grainDensityModulation(-GRAIN_TOE_STOPS + eps))).toBeLessThan(1e-5)
    expect(Math.abs(grainDensityModulation(GRAIN_SHOULDER_STOPS - eps))).toBeLessThan(1e-5)
  })

  it('is monotone away from the peak in both directions', () => {
    let previous = 1
    for (let s = 0; s <= GRAIN_SHOULDER_STOPS; s += 0.05) {
      const value = grainDensityModulation(s)
      expect(value).toBeLessThanOrEqual(previous + 1e-12)
      previous = value
    }
    previous = 1
    for (let s = 0; s >= -GRAIN_TOE_STOPS; s -= 0.05) {
      const value = grainDensityModulation(s)
      expect(value).toBeLessThanOrEqual(previous + 1e-12)
      previous = value
    }
  })

  it('agrees with itself through the encoded form', () => {
    for (let s = -5; s <= 3; s += 0.1) {
      expect(grainDensityModulationFromEncoded(stopsFromGrey(s))).toBeCloseTo(
        grainDensityModulation(s),
        12,
      )
    }
  })

  it('reaches exactly to display white above the peak', () => {
    // Not a tuning choice. There are only this many stops between middle grey and
    // display white, so a shoulder reaching further would be describing pixels
    // that cannot exist and one reaching less would stop short of the highlights.
    expect(GRAIN_SHOULDER_STOPS).toBe(DISPLAY_WHITE_STOPS_ABOVE_GREY)
    expect(grainDensityModulationFromEncoded(DISPLAY_WHITE_ACESCCT)).toBeCloseTo(0, 6)
  })
})

describe('the modulation peak sits where real image data is', () => {
  // The occupancy rule, applied to a curve rather than to a parameter range. The
  // failure it guards against is specific and has happened twice in this
  // repository already: taking a midpoint of an encoded domain and calling it the
  // midtones. ACEScct is a log encoding with a linear splice near black, so its
  // midpoints are facts about the encoding.

  it('is anchored to middle grey rather than to a midpoint of the encoding', () => {
    expect(GRAIN_PEAK_STOPS_FROM_GREY).toBe(0)

    // Where the two tempting alternatives actually land, so the numbers below are
    // not abstract. Neither is near grey.
    const occupiedMidpoint =
      (FILM_DOMAIN_LOW + DISPLAY_WHITE_ACESCCT) / 2 - MIDDLE_GREY_ACESCCT
    expect(occupiedMidpoint / STOP_IN_ACESCCT).toBeCloseTo(-1.75, 1)
    expect((0.5 - MIDDLE_GREY_ACESCCT) / STOP_IN_ACESCCT).toBeCloseTo(1.51, 1)
  })

  it('carries grain across about half of a real photograph, whichever photograph', () => {
    for (const [name, histogram] of [
      ['night', NIGHT],
      ['talk', TALK],
    ] as const) {
      const mass = grainMass(histogram, GRAIN_PEAK_STOPS_FROM_GREY)
      expect(mass, `${name} carries too little grain`).toBeGreaterThan(0.4)
      expect(mass, `${name} is grainy nearly everywhere`).toBeLessThan(0.65)
    }
  })

  it('behaves the same on a low-key frame and a high-key one, which the alternatives do not', () => {
    // The discriminating assertion, and the reason the anchor is defensible
    // rather than merely stated. Grain is a property of the emulsion, so the
    // share of a frame carrying it should not depend much on how the frame was
    // lit. Measured:
    //
    //   peak at grey          night 50.5%   talk 47.9%   spread  2.6 points
    //   peak at -1.75 stops   night 25.9%   talk 17.0%   spread  8.9 points
    //   peak at +1.51 stops   night 39.9%   talk 74.8%   spread 34.9 points
    const spread = (peak: number): number =>
      Math.abs(grainMass(NIGHT, peak) - grainMass(TALK, peak))

    expect(spread(GRAIN_PEAK_STOPS_FROM_GREY)).toBeLessThan(0.05)
    expect(spread(-1.75)).toBeGreaterThan(3 * spread(GRAIN_PEAK_STOPS_FROM_GREY))
    expect(spread(1.51)).toBeGreaterThan(0.3)

    // And the encoded midpoint fails a second way, which is why it is not merely
    // a different taste: it puts grain on barely a fifth of the lit interior.
    expect(grainMass(TALK, -1.75)).toBeLessThan(0.2)
  })
})

describe('the band limit, and the divergence it implies', () => {
  it('draws full amplitude above the sampling rate and nothing below it', () => {
    expect(grainAmplitudeScale(GRAIN_FULL_AMPLITUDE_PERIOD)).toBe(1)
    expect(grainAmplitudeScale(GRAIN_VANISHED_PERIOD)).toBe(0)
    expect(grainAmplitudeScale(0.1)).toBe(0)
    expect(grainAmplitudeScale(50)).toBe(1)
  })

  it('fades rather than steps, so the size slider has no cliff in it', () => {
    let previous = 0
    for (let p = GRAIN_VANISHED_PERIOD; p <= GRAIN_FULL_AMPLITUDE_PERIOD; p += 0.02) {
      const value = grainAmplitudeScale(p)
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12)
      previous = value
    }
    expect(grainAmplitudeScale(1.5)).toBeGreaterThan(0.4)
    expect(grainAmplitudeScale(1.5)).toBeLessThan(0.6)
  })

  it('reports a divergence threshold that is the same constant the shader fades on', () => {
    // The requirement is to report the grain size below which preview and export
    // necessarily diverge. If that number came from anywhere but the constant
    // driving the fade, the two could drift apart silently and the documentation
    // would describe a build that no longer exists.
    const proxy = 2048
    const source = 9500
    const bufferScale = proxy / source

    const divergesBelow = grainDivergenceSourcePixels(bufferScale)
    expect(divergesBelow).toBeCloseTo(9.28, 2)

    // A grain period just under it is attenuated; just over it is not.
    expect(grainAmplitudeScale(divergesBelow * bufferScale)).toBe(1)
    expect(grainAmplitudeScale((divergesBelow - 1) * bufferScale)).toBeLessThan(1)
  })

  it('places the parameter floor above what a full-resolution export can draw', () => {
    // The floor of the size slider is not a taste decision. At full resolution
    // the buffer scale is 1, so the export can draw anything down to two source
    // pixels; the slider must not go below what the export itself can represent.
    // Stated against a reference source size, because the parameter is a fraction
    // of the long edge and so its meaning in pixels is not image-independent. On
    // a much smaller source the floor falls below two pixels and the fade takes
    // over, which is the graceful behaviour rather than a defect.
    const REFERENCE_LONG_EDGE = 6000
    const floor = GRAIN_SIZE_MIN
    expect(grainPeriodSourcePixels(floor, REFERENCE_LONG_EDGE)).toBeGreaterThanOrEqual(
      grainDivergenceSourcePixels(1),
    )
  })
})

describe('the three layers differ', () => {
  it('gives each channel its own crystal size', () => {
    const [r, g, b] = GRAIN_CHANNEL_SIZES
    expect(new Set([r, g, b]).size).toBe(3)
    // Green finest, blue coarsest. If all three were equal the sizes would still
    // differ per channel only by the seed, and the result would read as luminance
    // noise with a slight colour wobble rather than as colour grain.
    expect(g).toBeLessThan(r)
    expect(r).toBeLessThan(b)
  })

  it('keeps every layer within a factor that stays plausible as one emulsion', () => {
    for (const size of GRAIN_CHANNEL_SIZES) {
      expect(size).toBeGreaterThan(0.5)
      expect(size).toBeLessThan(2)
    }
  })
})
