import { describe, expect, it } from 'vitest'

import {
  WHEEL_RANGE,
  ZONE_A_HIGH,
  ZONE_A_LOW,
  ZONE_B_HIGH,
  ZONE_B_LOW,
  applyWheelsEncoded,
  isWheelIdentity,
  zoneWeights,
  zoneWeightsFromEncoded,
} from '../../src/core/colour/wheels'
import { DISPLAY_WHITE_STOPS_ABOVE_GREY } from '../../src/core/colour/halation'
import { MIDDLE_GREY_ACESCCT, stopsFromGrey } from '../../src/core/colour/filmStock'
import { binCentre, LUMINANCE_HISTOGRAMS } from '../fixtures/luminance-histograms'

/** Share of a photograph a wheel acts on, weighted by its own zone weight. */
function influence(histogram: readonly number[]): { lift: number; gamma: number; gain: number } {
  let total = 0
  let lift = 0
  let gamma = 0
  let gain = 0
  for (let i = 0; i < histogram.length; i++) {
    const count = histogram[i] ?? 0
    total += count
    const w = zoneWeights(binCentre(i))
    lift += count * w.lift
    gamma += count * w.gamma
    gain += count * w.gain
  }
  return { lift: lift / total, gamma: gamma / total, gain: gain / total }
}

describe('the three zones partition the range', () => {
  it('sums to exactly one everywhere', () => {
    // Not tidiness. It is what makes each wheel's region of influence a
    // well-defined weight function, which is what the occupancy assertion below
    // integrates against — a question that has no numerical form at all against
    // an ASC CDL offset, since a CDL offset acts everywhere.
    for (let s = -12; s <= 8; s += 0.05) {
      const w = zoneWeights(s)
      expect(w.lift + w.gamma + w.gain, `at ${s} stops`).toBeCloseTo(1, 12)
    }
  })

  it('never gives a zone a negative share', () => {
    // `gamma` is a difference of two smoothsteps, so it is non-negative only
    // because both edges of the first sit at or below the matching edge of the
    // second. That is a constraint on the constants, and this is what holds it.
    expect(ZONE_A_LOW).toBeLessThanOrEqual(ZONE_B_LOW)
    expect(ZONE_A_HIGH).toBeLessThanOrEqual(ZONE_B_HIGH)
    for (let s = -12; s <= 8; s += 0.05) {
      const w = zoneWeights(s)
      expect(Math.min(w.lift, w.gamma, w.gain), `at ${s} stops`).toBeGreaterThanOrEqual(0)
    }
  })

  it('gives each zone the end of the range it is named for', () => {
    expect(zoneWeights(-10).lift).toBe(1)
    expect(zoneWeights(10).gain).toBe(1)
    // Gamma peaks between the two, and near a correctly exposed midtone rather
    // than at a midpoint of the encoding.
    let best = -1
    let peak = 0
    for (let s = -6; s <= 4; s += 0.01) {
      const g = zoneWeights(s).gamma
      if (g > best) { best = g; peak = s }
    }
    expect(peak).toBeGreaterThan(-1.5)
    expect(peak).toBeLessThan(1.5)
  })

  it('hands over smoothly, with no edge anywhere', () => {
    // A hard handover at one value puts a visible line across the picture
    // wherever that value falls. The zones overlap for exactly this reason.
    let previous = zoneWeights(-12)
    for (let s = -12; s <= 8; s += 0.01) {
      const w = zoneWeights(s)
      expect(Math.abs(w.lift - previous.lift)).toBeLessThan(0.01)
      expect(Math.abs(w.gain - previous.gain)).toBeLessThan(0.01)
      previous = w
    }
  })

  it('agrees with itself through the encoded form', () => {
    for (let s = -6; s <= 4; s += 0.1) {
      const a = zoneWeights(s)
      const b = zoneWeightsFromEncoded(stopsFromGrey(s))
      expect(b.lift).toBeCloseTo(a.lift, 12)
      expect(b.gamma).toBeCloseTo(a.gamma, 12)
      expect(b.gain).toBeCloseTo(a.gain, 12)
    }
  })
})

describe('every wheel acts on a real photograph', () => {
  // The occupancy rule applied to a region of influence rather than to a range.
  // The failure it guards against is the Stage 7 one in a new place: a control
  // whose zone sits where the data is not, doing nothing on a whole class of
  // picture while looking entirely reasonable in the source.
  const NIGHT = influence(LUMINANCE_HISTOGRAMS.night)
  const TALK = influence(LUMINANCE_HISTOGRAMS.talk)

  it('gives every wheel a meaningful share of both photographs', () => {
    // Measured at 57/31/13 and 22/31/48. The shape that was nearly shipped —
    // lift over the four stops below grey, gain from grey to display white —
    // scores 7.8% for gain on the night frame, and that is what this rejects.
    for (const [name, share] of [['night', NIGHT], ['talk', TALK]] as const) {
      expect(share.lift, `${name}: lift`).toBeGreaterThan(0.1)
      expect(share.gamma, `${name}: gamma`).toBeGreaterThan(0.1)
      expect(share.gain, `${name}: gain`).toBeGreaterThan(0.1)
    }
  })

  it('keeps the midtone wheel steady while the other two follow the key', () => {
    // A low-key frame should be mostly lift and a high-key one mostly gain —
    // that asymmetry is correct rather than residual, the same argument as the
    // halation threshold. What should not vary much is gamma, which is the wheel
    // a colourist reaches for first on any picture.
    expect(Math.abs(NIGHT.gamma - TALK.gamma)).toBeLessThan(0.1)
    expect(NIGHT.lift).toBeGreaterThan(NIGHT.gain)
    expect(TALK.gain).toBeGreaterThan(TALK.lift)
  })
})

describe('applying the wheels', () => {
  it('is an exact identity at zero, at every value', () => {
    // Anything else alters every unedited photograph.
    for (let s = -8; s <= 4; s += 0.05) {
      const encoded = stopsFromGrey(s)
      expect(applyWheelsEncoded(encoded, 0, 0, 0)).toBe(encoded)
    }
  })

  it('moves a value by the offset when all three wheels agree', () => {
    // The partition of unity in use: three equal offsets are one uniform offset,
    // whatever the value.
    for (let s = -6; s <= 3; s += 0.25) {
      const encoded = stopsFromGrey(s)
      expect(applyWheelsEncoded(encoded, 0.02, 0.02, 0.02)).toBeCloseTo(encoded + 0.02, 12)
    }
  })

  it('puts lift where the shadows are and gain where the highlights are', () => {
    const shadow = stopsFromGrey(-4)
    const highlight = stopsFromGrey(2)
    const liftOnly = WHEEL_RANGE
    expect(applyWheelsEncoded(shadow, liftOnly, 0, 0) - shadow).toBeGreaterThan(
      applyWheelsEncoded(highlight, liftOnly, 0, 0) - highlight,
    )
    expect(applyWheelsEncoded(highlight, 0, 0, liftOnly) - highlight).toBeGreaterThan(
      applyWheelsEncoded(shadow, 0, 0, liftOnly) - shadow,
    )
  })

  it('has a range that is a trim rather than a move', () => {
    // A little over one stop at full deflection. Exposure and the curve are for
    // moving the picture; a wheel that can move a zone further than this has
    // already stopped looking like a photograph.
    const stops = WHEEL_RANGE / (MIDDLE_GREY_ACESCCT / MIDDLE_GREY_ACESCCT) * 17.52
    expect(stops).toBeGreaterThan(0.5)
    expect(stops).toBeLessThan(1.5)
    expect(DISPLAY_WHITE_STOPS_ABOVE_GREY).toBe(ZONE_B_HIGH)
  })

  it('recognises its identity', () => {
    expect(isWheelIdentity([0, 0, 0])).toBe(true)
    expect(isWheelIdentity([0, 0, 0.0001])).toBe(false)
    expect(isWheelIdentity([0, 0])).toBe(false)
  })
})
