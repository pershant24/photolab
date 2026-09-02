import { describe, expect, it } from 'vitest'

import { HSL_BAND_COUNT, applyHsl } from '../../src/core/colour/hsl'
import type { Rgb } from '../../src/core/colour/hsl'
import { GAMUT_COMPRESS_THRESHOLD, gamutCompressRgb } from '../../src/core/colour/display'
import { ACESCG_TO_SRGB } from '../../src/core/colour/matrices'
import { mat3MulVec3 } from '../../src/core/colour/types'
import { hueDifference, labChroma, labHueAngle, linearSrgbToLab } from '../../src/core/colour/lab'

/**
 * The Stage 6 hue bound, re-run with HSL pushed to its extremes.
 *
 * Saturation is the control that pushes colours out of gamut most readily, and
 * the gamut compressor's promise is that it moves perceptual hue far less than
 * clipping would. That promise was measured on colours the pipeline could
 * produce at Stage 6; HSL can now produce considerably more saturated ones, so
 * the bound is worth re-establishing rather than assuming.
 */

const NEUTRAL = Array<number>(HSL_BAND_COUNT).fill(0)
const MAX_SATURATION = Array<number>(HSL_BAND_COUNT).fill(1)

const SUBJECTS: readonly Rgb[] = [
  [0.5, 0.1, 0.1], [0.1, 0.5, 0.1], [0.1, 0.1, 0.5],
  [0.6, 0.5, 0.08], [0.05, 0.4, 0.42], [0.42, 0.08, 0.4],
  [0.9, 0.25, 0.05], [0.2, 0.6, 0.15], [1.4, 0.3, 0.2],
]

const hueOf = (rgb: readonly number[]): number =>
  labHueAngle(linearSrgbToLab([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0]))
const chromaOf = (rgb: readonly number[]): number =>
  labChroma(linearSrgbToLab([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0]))

describe('the gamut bound still holds at HSL extremes', () => {
  it('drives colours out of gamut, so the comparison has something to measure', () => {
    // Without this the test could pass because nothing left the gamut.
    let outOfGamut = 0
    for (const subject of SUBJECTS) {
      const saturated = applyHsl(subject, NEUTRAL, MAX_SATURATION, NEUTRAL)
      const srgb = mat3MulVec3(ACESCG_TO_SRGB, [saturated[0], saturated[1], saturated[2]])
      if (Math.min(...srgb) < 0 || Math.max(...srgb) > 1) outOfGamut++
    }
    expect(outOfGamut, 'maximum saturation left every colour inside the gamut').toBeGreaterThan(4)
  })

  it('holds the Stage 6 bound at modest saturation and loses it beyond', () => {
    // Re-run, and it does **not** hold at the extremes. Worst compressed hue
    // shift against the 20-degree bound recorded at Stage 6:
    //
    //   saturation   compressed shift   channels driven negative
    //   +0.10             11.3 deg              0 of 8
    //   +0.25             24.2 deg              3 of 8
    //   +0.50             26.3 deg              4 of 8
    //   +1.00             32.6 deg              7 of 8
    //
    // The breakpoint is not arbitrary: `mix(luma, rgb, 1 + s)` drives channels
    // negative once `s` is large enough, at which point the colour is outside
    // AP1 rather than merely outside the display gamut, and the compressor's
    // promise was measured on colours inside it.
    const worstAt = (saturation: number): number => {
      const bands = Array<number>(HSL_BAND_COUNT).fill(saturation)
      let worst = 0
      for (const subject of SUBJECTS) {
        const out = applyHsl(subject, NEUTRAL, bands, NEUTRAL)
        const srgb = mat3MulVec3(ACESCG_TO_SRGB, [out[0], out[1], out[2]])
        if (chromaOf(srgb) < 2) continue
        const compressed = gamutCompressRgb(srgb, GAMUT_COMPRESS_THRESHOLD)
        if (chromaOf(compressed) < 2) continue
        worst = Math.max(worst, Math.abs(hueDifference(hueOf(compressed), hueOf(srgb))))
      }
      return worst
    }

    expect(worstAt(0.1), 'the bound must still hold where colours stay in AP1').toBeLessThan(20)
    // And it is recorded, not silently tolerated, that it does not hold above.
    expect(worstAt(1)).toBeGreaterThan(20)
  })

  it('has its breakpoint where channels go negative, not somewhere arbitrary', () => {
    // The mechanism, asserted rather than asserted-about. At the saturation where
    // the bound still holds, nothing has left AP1; where it fails, most have.
    const negatives = (saturation: number): number => {
      const bands = Array<number>(HSL_BAND_COUNT).fill(saturation)
      let count = 0
      for (const subject of SUBJECTS) {
        const out = applyHsl(subject, NEUTRAL, bands, NEUTRAL)
        if (Math.min(out[0], out[1], out[2]) < 0) count++
      }
      return count
    }
    expect(negatives(0.1)).toBe(0)
    expect(negatives(1)).toBeGreaterThan(SUBJECTS.length / 2)
  })

  it('is NOT uniformly better than clipping on the colours HSL can now reach', () => {
    // Recorded because it is false, not because it is true.
    //
    // `display.test.ts` asserts that compression is never worse than clipping on
    // any colour, over seven hand-picked strongly out-of-gamut values. That test
    // still passes and is not weakened here. But the claim does **not**
    // generalise to the colour volume HSL opens up, and it does not fail in the
    // way one would guess — it has nothing to do with how far outside the gamut
    // the colour is:
    //
    //   excursion   compressed   clipped
    //     0.036        0.3         0.5      compression wins
    //     0.201        2.1        12.2      compression wins
    //     0.212       11.2         5.3      compression loses
    //     0.355       32.6        15.7      compression loses
    //     0.408       21.5         5.3      compression loses
    //
    // The cases it loses are the ones where the saturation operation drove
    // channels negative: the colour is then outside AP1 itself, not merely
    // outside the display gamut, and scaling toward achromatic from there moves
    // CIELAB hue further than truncating does.
    //
    // Not fixed here. It is a property of the compressor meeting inputs it was
    // never measured against, the fix is a decision about the compressor rather
    // than about HSL, and pretending the invariant holds would be worse than
    // recording that it does not.
    let wins = 0
    let losses = 0
    for (const saturation of [0.1, 0.25, 0.5, 0.75, 1]) {
      const bands = Array<number>(HSL_BAND_COUNT).fill(saturation)
      for (const subject of SUBJECTS) {
        const out = applyHsl(subject, NEUTRAL, bands, NEUTRAL)
        const srgb = mat3MulVec3(ACESCG_TO_SRGB, [out[0], out[1], out[2]])
        if (chromaOf(srgb) < 2) continue
        const compressed = gamutCompressRgb(srgb, GAMUT_COMPRESS_THRESHOLD)
        const clipped = srgb.map((v) => Math.min(1, Math.max(0, v)))
        if (chromaOf(compressed) < 2 || chromaOf(clipped) < 2) continue
        const target = hueOf(srgb)
        const c = Math.abs(hueDifference(hueOf(compressed), target))
        const k = Math.abs(hueDifference(hueOf(clipped), target))
        if (c <= k + 1e-9) wins++
        else losses++
      }
    }
    // Both outcomes occur. If either count went to zero the situation would have
    // changed and this comment would be describing a build that no longer exists.
    expect(wins).toBeGreaterThan(0)
    expect(losses).toBeGreaterThan(0)
  })

  it('does not invert or wildly rotate hue at maximum saturation', () => {
    // Saturating a colour should make it more of what it is. A hue that moves by
    // more than a band width has become a different colour, which is what an
    // unbounded saturation in the wrong space does.
    for (const subject of SUBJECTS) {
      const saturated = applyHsl(subject, NEUTRAL, MAX_SATURATION, NEUTRAL)
      const before = mat3MulVec3(ACESCG_TO_SRGB, [subject[0], subject[1], subject[2]])
      const after = mat3MulVec3(ACESCG_TO_SRGB, [saturated[0], saturated[1], saturated[2]])
      if (chromaOf(before) < 2 || chromaOf(after) < 2) continue
      // Saturating a colour should make it more of what it is. 35 degrees rather
      // than something tighter because the Abney effect is real: increasing
      // colorimetric purity does move perceptual hue, and the measurement here
      // tops out at 33.7 on a red pushed to double saturation.
      expect(
        Math.abs(hueDifference(hueOf(after), hueOf(before))),
        `hue moved on ${subject.join(', ')}`,
      ).toBeLessThan(35)
    }
  })
})
