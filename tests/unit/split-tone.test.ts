import { describe, expect, it } from 'vitest'

import {
  SPLIT_BALANCE_MAX,
  SPLIT_BALANCE_MIN,
  SPLIT_TRANSITION_STOPS,
  applySplitToneEncoded,
  highlightShare,
  highlightShareFromEncoded,
  isSplitToneIdentity,
} from '../../src/core/colour/splitTone'
import { DISPLAY_WHITE_STOPS_ABOVE_GREY } from '../../src/core/colour/halation'
import { stopsFromGrey } from '../../src/core/colour/filmStock'
import { fractionAbove, fractionBetween, LUMINANCE_HISTOGRAMS } from '../fixtures/luminance-histograms'

describe('the balance is a position in the photograph, not in the encoding', () => {
  // The occupancy rule, third time. A balance expressed as a `[0, 1]` position
  // over ACEScct reads perfectly well in the source and puts most of its travel
  // where no photograph has pixels — which is exactly what the film curve
  // control points and the halation threshold both did.
  it('spans only positions a display-referred image can contain', () => {
    expect(SPLIT_BALANCE_MAX).toBe(DISPLAY_WHITE_STOPS_ABOVE_GREY)
    // Above display white every pixel is on the shadow side and the highlight
    // tint does nothing at all, so there is no reason to travel there.
    for (const histogram of Object.values(LUMINANCE_HISTOGRAMS)) {
      expect(fractionAbove(histogram, SPLIT_BALANCE_MAX + 0.05)).toBe(0)
    }
  })

  it('splits both photographs somewhere useful at every point in its range', () => {
    // At any balance the slider offers, both tints must have something to act
    // on. A range whose ends put 100% of the frame on one side is a range whose
    // ends do nothing.
    for (const [name, histogram] of Object.entries(LUMINANCE_HISTOGRAMS)) {
      for (let b = SPLIT_BALANCE_MIN; b <= SPLIT_BALANCE_MAX; b += 0.5) {
        const above = fractionAbove(histogram, b)
        expect(above, `${name} at ${b} EV: nothing in the highlights`).toBeGreaterThan(0)
        expect(above, `${name} at ${b} EV: nothing in the shadows`).toBeLessThan(1)
      }
    }
  })

  it('has a default that divides a real photograph rather than sitting at an end', () => {
    // Middle grey. Both frames have substantial mass on each side of it, which
    // is what makes the default a starting point rather than a corner.
    for (const [name, histogram] of Object.entries(LUMINANCE_HISTOGRAMS)) {
      const above = fractionAbove(histogram, 0)
      expect(above, `${name}`).toBeGreaterThan(0.2)
      expect(above, `${name}`).toBeLessThan(0.8)
    }
  })

  it('has a transition wide enough to cover real pixels on both sides', () => {
    // A narrow handover puts a visible line across the picture wherever the
    // balance falls. Two stops is wide, deliberately: split toning is a mood
    // control and not a mask.
    expect(SPLIT_TRANSITION_STOPS).toBeGreaterThanOrEqual(1.5)
    for (const [name, histogram] of Object.entries(LUMINANCE_HISTOGRAMS)) {
      const inside = fractionBetween(histogram, -SPLIT_TRANSITION_STOPS / 2, SPLIT_TRANSITION_STOPS / 2)
      expect(inside, `${name} has no pixels in the handover`).toBeGreaterThan(0.05)
    }
  })
})

describe('the two shares partition the range', () => {
  it('sums to one everywhere, for any balance', () => {
    for (const balance of [-4, -2, 0, 1, 2.4]) {
      for (let s = -10; s <= 6; s += 0.1) {
        const share = highlightShare(s, balance)
        expect(share + (1 - share)).toBe(1)
        expect(share).toBeGreaterThanOrEqual(0)
        expect(share).toBeLessThanOrEqual(1)
      }
    }
  })

  it('moves the handover when the balance moves', () => {
    const atGrey = highlightShare(0, 0)
    expect(atGrey).toBeCloseTo(0.5, 6)
    expect(highlightShare(0, 2)).toBeLessThan(atGrey)
    expect(highlightShare(0, -2)).toBeGreaterThan(atGrey)
  })

  it('hands over smoothly rather than at a step', () => {
    let previous = highlightShare(-10, 0)
    for (let s = -10; s <= 6; s += 0.01) {
      const share = highlightShare(s, 0)
      expect(Math.abs(share - previous)).toBeLessThan(0.02)
      previous = share
    }
  })

  it('agrees with itself through the encoded form', () => {
    for (let s = -6; s <= 3; s += 0.1) {
      expect(highlightShareFromEncoded(stopsFromGrey(s), 0.5)).toBeCloseTo(
        highlightShare(s, 0.5),
        12,
      )
    }
  })
})

describe('applying the tints', () => {
  it('is an exact identity when both are zero', () => {
    for (let s = -8; s <= 4; s += 0.05) {
      const encoded = stopsFromGrey(s)
      expect(applySplitToneEncoded(encoded, 0, 0, 0)).toBe(encoded)
    }
  })

  it('is a uniform offset when both tints agree', () => {
    // The partition in use: toning shadows and highlights the same way is a
    // colour cast, not a doubled one.
    for (let s = -6; s <= 3; s += 0.25) {
      const encoded = stopsFromGrey(s)
      expect(applySplitToneEncoded(encoded, 0.02, 0.02, 0)).toBeCloseTo(encoded + 0.02, 12)
    }
  })

  it('puts each tint on its own side of the balance', () => {
    const shadow = stopsFromGrey(-3)
    const highlight = stopsFromGrey(2)
    expect(applySplitToneEncoded(shadow, 0.04, 0, 0) - shadow).toBeGreaterThan(
      applySplitToneEncoded(highlight, 0.04, 0, 0) - highlight,
    )
    expect(applySplitToneEncoded(highlight, 0, 0.04, 0) - highlight).toBeGreaterThan(
      applySplitToneEncoded(shadow, 0, 0.04, 0) - shadow,
    )
  })

  it('recognises its identity', () => {
    expect(isSplitToneIdentity([0, 0, 0], [0, 0, 0])).toBe(true)
    expect(isSplitToneIdentity([0, 0, 0.001], [0, 0, 0])).toBe(false)
  })
})
