import { describe, expect, it } from 'vitest'

import {
  DATE_DIGIT_COUNT,
  DATE_STAMP_HEIGHT,
  DIGIT_SEGMENTS,
  DIGIT_TRACKING,
  DIGIT_WIDTH,
  GROUP_GAP,
  SEGMENT_BOXES,
  SEGMENT_COUNT,
  THINNEST_FEATURE,
  TICK_ADVANCE,
  bufferEdgeForFeature,
  dateDigits,
  digitOrigins,
  stampWidth,
} from '../../src/core/colour/dateStamp'
import { DEFAULT_EDIT_STATE } from '../../src/core/state/editState'

/**
 * The date stamp's layout and glyph table.
 *
 * The geometry itself is checked against the shader in
 * `tests/unit/glsl-constants.test.ts`; this is the arithmetic that has no
 * counterpart in GLSL because it never went there — the origins arrive as
 * uniforms precisely so that there is one implementation of them and it is this
 * one.
 */

describe('the seven-segment table', () => {
  it('lights the segments each digit is supposed to light', () => {
    // Written out independently of the masks rather than derived from them,
    // because a table checked against itself checks nothing. Bit 0 is `a` and
    // bit 6 is `g`, clockwise from the top and then the middle.
    const expected: Record<number, string> = {
      0: 'abcdef',
      1: 'bc',
      2: 'abdeg',
      3: 'abcdg',
      4: 'bcfg',
      5: 'acdfg',
      6: 'acdefg',
      7: 'abc',
      8: 'abcdefg',
      9: 'abcdfg',
    }
    for (let digit = 0; digit <= 9; digit++) {
      const lit = [...'abcdefg'].filter((_, i) => (DIGIT_SEGMENTS[digit]! & (1 << i)) !== 0).join('')
      expect(lit, `digit ${digit}`).toBe(expected[digit])
    }
  })

  it('gives 8 every segment and 1 the fewest, which is what makes them tell apart', () => {
    // The property the rendered tests lean on: an 8 lights more than any other
    // digit and a 1 lights fewer, so counting lit pixels distinguishes them
    // without having to read the picture.
    const count = (d: number): number =>
      [...Array(SEGMENT_COUNT).keys()].filter((i) => (DIGIT_SEGMENTS[d]! & (1 << i)) !== 0).length
    expect(count(8)).toBe(SEGMENT_COUNT)
    for (let d = 0; d <= 9; d++) {
      if (d !== 8) expect(count(d), `digit ${d}`).toBeLessThan(count(8))
      if (d !== 1) expect(count(d), `digit ${d}`).toBeGreaterThan(count(1))
    }
  })

  it('describes seven segments, none of which is degenerate', () => {
    expect(SEGMENT_BOXES).toHaveLength(SEGMENT_COUNT)
    for (const [i, [, , hx, hy]] of SEGMENT_BOXES.entries()) {
      // A padding larger than half the thickness would invert a half-extent and
      // the segment would vanish — silently, since a negative half-extent still
      // produces a plausible distance.
      expect(hx, `segment ${'abcdefg'[i]} half-width`).toBeGreaterThan(0)
      expect(hy, `segment ${'abcdefg'[i]} half-height`).toBeGreaterThan(0)
    }
  })

  it('keeps every segment inside the cell it is drawn in', () => {
    // Otherwise a digit would bleed into its neighbour and the tracking would be
    // a lie.
    for (const [i, [cx, cy, hx, hy]] of SEGMENT_BOXES.entries()) {
      expect(cx - hx, `segment ${'abcdefg'[i]} left`).toBeGreaterThanOrEqual(0)
      expect(cx + hx, `segment ${'abcdefg'[i]} right`).toBeLessThanOrEqual(DIGIT_WIDTH)
      expect(cy - hy, `segment ${'abcdefg'[i]} bottom`).toBeGreaterThanOrEqual(0)
      expect(cy + hy, `segment ${'abcdefg'[i]} top`).toBeLessThanOrEqual(1)
    }
  })

  it('leaves a gap between every pair of segments that meet at a corner', () => {
    // The gaps are the most recognisable thing about a seven-segment display.
    // Checked at the four corners, where `a` meets `f` and `b`, and `d` meets
    // `e` and `c`.
    const box = (name: string) => SEGMENT_BOXES['abcdefg'.indexOf(name)]!
    for (const [h, v] of [
      ['a', 'f'],
      ['a', 'b'],
      ['d', 'e'],
      ['d', 'c'],
    ] as const) {
      const [, hcy, , hhy] = box(h)
      const [, vcy, , vhy] = box(v)
      const gap = Math.abs(hcy - vcy) - hhy - vhy
      expect(gap, `${h} and ${v} overlap or touch`).toBeGreaterThan(0)
    }
  })
})

describe('the date', () => {
  it('shows the last two digits of the year, and the month and day', () => {
    expect(dateDigits(1996, 7, 4)).toEqual([9, 6, 0, 7, 0, 4])
    expect(dateDigits(2026, 12, 31)).toEqual([2, 6, 1, 2, 3, 1])
    expect(dateDigits(2000, 1, 1)).toEqual([0, 0, 0, 1, 0, 1])
  })

  it('produces six digits, all of them in range, across the whole parameter domain', () => {
    for (let year = 1900; year <= 2099; year += 7) {
      for (const month of [1, 6, 12]) {
        for (const day of [1, 15, 31]) {
          const digits = dateDigits(year, month, day)
          expect(digits, `${year}-${month}-${day}`).toHaveLength(DATE_DIGIT_COUNT)
          for (const d of digits) {
            expect(d, `${year}-${month}-${day}`).toBeGreaterThanOrEqual(0)
            expect(d).toBeLessThanOrEqual(9)
          }
        }
      }
    }
  })

  it('is a fixed literal in the defaults, and reads no clock', () => {
    // The renderer is a function of its arguments. A default that read the
    // system date would make the same EditState render differently on two days,
    // and the golden tests would drift once a month without anyone touching the
    // code.
    expect(DEFAULT_EDIT_STATE.dateStampYear).toBe(2000)
    expect(DEFAULT_EDIT_STATE.dateStampMonth).toBe(1)
    expect(DEFAULT_EDIT_STATE.dateStampDay).toBe(1)
  })
})

describe('the run', () => {
  it('starts after the tick and advances by the digit width plus tracking', () => {
    const origins = digitOrigins()
    expect(origins).toHaveLength(DATE_DIGIT_COUNT)
    expect(origins[0]).toBeCloseTo(TICK_ADVANCE, 12)
    expect(origins[1]! - origins[0]!).toBeCloseTo(DIGIT_WIDTH + DIGIT_TRACKING, 12)
  })

  it('puts the extra gap between the year, the month and the day, and nowhere else', () => {
    const origins = digitOrigins()
    const advance = DIGIT_WIDTH + DIGIT_TRACKING
    const steps = origins.slice(1).map((x, i) => x - origins[i]!)
    // Two groups of two, so the gap falls after the second and the fourth digit.
    const extra = [0, GROUP_GAP, 0, GROUP_GAP, 0]
    expect(steps).toHaveLength(extra.length)
    steps.forEach((step, i) => {
      expect(step - advance, `the gap after digit ${i}`).toBeCloseTo(extra[i]!, 12)
    })
  })

  it('is monotonic, so no two digits can overlap', () => {
    const origins = digitOrigins()
    for (let i = 1; i < origins.length; i++) {
      expect(origins[i]! - origins[i - 1]!, `digit ${i}`).toBeGreaterThanOrEqual(DIGIT_WIDTH)
    }
  })

  it('is as wide as the last digit reaches', () => {
    expect(stampWidth()).toBeCloseTo(digitOrigins()[DATE_DIGIT_COUNT - 1]! + DIGIT_WIDTH, 12)
  })

  it('fits inside a frame at the default position, in either orientation', () => {
    /*
     * The position anchors the RIGHT end of the run, so the left end is the one
     * that can fall off.
     *
     * The aspect ratio has to be carried through, and getting it wrong makes
     * this read stronger than it is. The cap height is a fraction of the LONG
     * edge, so on a portrait frame the run is the same absolute width while the
     * frame is narrower — the fraction of the width it occupies is larger by the
     * aspect ratio. Comparing a long-edge fraction against a position in width
     * units is correct for landscape and silent about portrait, which is the
     * case that can actually fail.
     */
    const widthFraction = (w: number, h: number): number =>
      (stampWidth() * DATE_STAMP_HEIGHT * Math.max(w, h)) / w
    for (const [w, h] of [
      [3, 2],
      [2, 3],
      [1, 1],
      // A panorama and a tall crop, well past anything a camera produces.
      [3, 1],
      [1, 3],
    ] as const) {
      const left = DEFAULT_EDIT_STATE.dateStampPosition[0]! - widthFraction(w, h)
      expect(left, `the run starts off the left edge on a ${w}:${h} frame`).toBeGreaterThan(0)
    }
    expect(DEFAULT_EDIT_STATE.dateStampPosition[0]).toBeLessThanOrEqual(1)
    expect(DEFAULT_EDIT_STATE.dateStampPosition[1]).toBeLessThanOrEqual(1)
  })
})

describe('the resolution floor', () => {
  it('states the buffer size at which the thinnest feature is one pixel', () => {
    // The same question grain and halation both answer: below some buffer size
    // the preview cannot represent the feature, so it stops being a preview of
    // it. Here the feature is a segment's short side.
    expect(THINNEST_FEATURE).toBeCloseTo(0.102, 12)
    const onePixel = bufferEdgeForFeature(1)
    expect(onePixel).toBeCloseTo(1 / (0.102 * DATE_STAMP_HEIGHT), 6)
    // Around 350 buffer pixels on the long edge, which is below any proxy this
    // renderer uses, and the browser measurement in
    // tests/golden/date-stamp.spec.ts is what turns that into a claim about
    // legibility rather than about arithmetic.
    expect(onePixel).toBeGreaterThan(300)
    expect(onePixel).toBeLessThan(400)
  })
})
