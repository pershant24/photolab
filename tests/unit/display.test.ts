import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DISPLAY_SETTINGS,
  GAMUT_COMPRESS_THRESHOLD,
  TONE_MAP_KNEE,
  displayTransform,
  displayTransformIdentity,
  gamutCompressRgb,
  toneMapChannel,
  toneMapRgb,
} from '../../src/core/colour/display'
import { ACESCG_TO_SRGB, SRGB_TO_ACESCG } from '../../src/core/colour/matrices'
import { MIDDLE_GREY_LINEAR } from '../../src/core/colour/grade'
import { hueDifference, labChroma, labHueAngle, linearSrgbToLab } from '../../src/core/colour/lab'
import { whiteBalanceMatrix } from '../../src/core/colour/whiteBalance'
import { srgbEotf, srgbOetf } from '../../src/core/colour/transfer'
import { mat3MulVec3 } from '../../src/core/colour/types'
import type { Vec3 } from '../../src/core/colour/types'

describe('tone map', () => {
  it('is exactly the identity at and below the knee', () => {
    // Not "close to" the identity. The middle grey property below depends on
    // this being exact, and an operator that is merely nearly the identity in the
    // midtones is one that quietly rescales every photograph.
    for (const x of [0, 1e-6, 0.05, 0.18, TONE_MAP_KNEE / 2, TONE_MAP_KNEE]) {
      expect(toneMapChannel(x, TONE_MAP_KNEE)).toBe(x)
    }
  })

  it('leaves middle grey exactly where it is', () => {
    // The property the whole operator was chosen for. If the tone map moved
    // 0.18, exposure would stop behaving like exposure: a stop would still
    // double the scene value, but the displayed result would no longer follow,
    // and Stage 4's measurement that a stop is a stop would silently stop being
    // true.
    expect(TONE_MAP_KNEE).toBeGreaterThan(MIDDLE_GREY_LINEAR)
    expect(toneMapChannel(MIDDLE_GREY_LINEAR, TONE_MAP_KNEE)).toBe(MIDDLE_GREY_LINEAR)
  })

  it('meets its own linear section smoothly, not merely continuously', () => {
    // A break in slope at the knee shows up on a gradient as a visible edge
    // where the roll-off starts. Continuity alone would not catch it.
    const knee = TONE_MAP_KNEE
    const h = 1e-6
    const below = (toneMapChannel(knee, knee) - toneMapChannel(knee - h, knee)) / h
    const above = (toneMapChannel(knee + h, knee) - toneMapChannel(knee, knee)) / h
    expect(below).toBeCloseTo(1, 6)
    expect(above).toBeCloseTo(1, 4)
  })

  it('is monotonically increasing across the whole input range', () => {
    // Including far above 1.0, which is where a badly formed shoulder inverts.
    // A tone map that reordered two values would render a brighter part of the
    // scene darker than a dimmer one.
    let previous = -Infinity
    for (let i = 0; i <= 4000; i++) {
      const x = -1 + (i / 4000) * 200
      const y = toneMapChannel(x, TONE_MAP_KNEE)
      expect(y).toBeGreaterThan(previous)
      previous = y
    }
  })

  it('never reaches or exceeds display white', () => {
    for (const x of [1, 4, 100, 65504]) {
      expect(toneMapChannel(x, TONE_MAP_KNEE)).toBeLessThan(1)
      expect(toneMapChannel(x, TONE_MAP_KNEE)).toBeGreaterThan(TONE_MAP_KNEE)
    }
  })

  it('separates values that clipping would have made identical', () => {
    // The entire point. Two highlights three stops apart both become 1.0 under a
    // clamp; under the roll-off they stay ordered and distinguishable.
    const a = toneMapChannel(2, TONE_MAP_KNEE)
    const b = toneMapChannel(16, TONE_MAP_KNEE)
    expect(b).toBeGreaterThan(a)
    // Distinguishable after the 8-bit encode, not merely different as floats.
    const codeA = Math.round(srgbOetf(a) * 255)
    const codeB = Math.round(srgbOetf(b) * 255)
    expect(codeB - codeA).toBeGreaterThanOrEqual(2)
  })

  it('returns negative input unchanged rather than inventing a value', () => {
    expect(toneMapChannel(-0.2, TONE_MAP_KNEE)).toBe(-0.2)
    expect(Number.isNaN(toneMapChannel(-0.2, TONE_MAP_KNEE))).toBe(false)
  })

  it('applies per channel, so a bright saturated colour bleaches toward white', () => {
    // Per-channel is the decision, and this is what it looks like: the largest
    // channel is compressed most, so the ratio between channels narrows and the
    // colour desaturates as it brightens, as an emulsion does.
    const before: Vec3 = [8, 2, 0.5]
    const after = toneMapRgb(before, TONE_MAP_KNEE)
    const saturationBefore = (before[0] - before[2]) / before[0]
    const saturationAfter = (after[0] - after[2]) / after[0]
    expect(saturationAfter).toBeLessThan(saturationBefore)
  })
})

describe('gamut compression', () => {
  it('leaves colours within the threshold distance exactly unchanged', () => {
    // Exactly, not approximately: below the threshold the compression is the
    // identity, so an ordinary photograph is untouched by it.
    for (const rgb of [
      [0.5, 0.5, 0.5],
      [0.2, 0.18, 0.22],
      [0.8, 0.5, 0.3],
      [1, 0.5, 0.5],
      [0, 0, 0],
    ] as Vec3[]) {
      expect(gamutCompressRgb(rgb, GAMUT_COMPRESS_THRESHOLD)).toEqual(rgb)
    }
  })

  it('leaves neutrals untouched at any distance', () => {
    for (const v of [0.01, 0.18, 1, 40]) {
      expect(gamutCompressRgb([v, v, v], GAMUT_COMPRESS_THRESHOLD)).toEqual([v, v, v])
    }
  })

  it('brings every negative channel back into gamut', () => {
    for (const rgb of [
      [1, -0.3, -0.1],
      [0.4, -0.9, 0.2],
      [2, 0.1, -4],
      [0.05, -0.001, 0.02],
    ] as Vec3[]) {
      const out = gamutCompressRgb(rgb, GAMUT_COMPRESS_THRESHOLD)
      for (let c = 0; c < 3; c++) {
        expect(out[c], `channel ${c} of ${rgb.join(', ')}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('preserves the ordering of channels that clipping collapses', () => {
    // The mechanism behind the hue claim. Clipping sends every negative channel
    // to the same zero, so two different colours become one; compression keeps
    // them apart, and the ordering is what carries the hue.
    const a = gamutCompressRgb([1, -0.05, -0.4], GAMUT_COMPRESS_THRESHOLD)
    const b = gamutCompressRgb([1, -0.4, -0.05], GAMUT_COMPRESS_THRESHOLD)
    expect(a[1]).toBeGreaterThan(a[2])
    expect(b[2]).toBeGreaterThan(b[1])
    expect(a).not.toEqual(b)
  })

  it('scales the chroma vector, which preserves RGB channel ratios by construction', () => {
    // Labelled as a construction check, not as evidence about hue.
    //
    // This assertion used to be the hue test, measured as an angle in the plane
    // perpendicular to the achromatic axis, and it passed at 1e-9. It could not
    // have done anything else: that angle comes from a linear projection which
    // annihilates the achromatic direction, and this operator scales the chroma
    // vector along exactly that projection, so `atan2(s*beta, s*alpha)` equals
    // `atan2(beta, alpha)` identically for any positive s. The metric and the
    // algorithm agreed by construction and the number was float noise.
    //
    // It is kept because it does state what the operator does — one factor, all
    // channels — but the question of whether *hue* survives is the next test,
    // measured somewhere the algorithm can fail.
    for (const original of [[1, -0.3, -0.1], [0.2, 1.1, -0.35]] as Vec3[]) {
      const out = gamutCompressRgb(original, GAMUT_COMPRESS_THRESHOLD)
      const achromatic = Math.max(original[0], original[1], original[2])
      // The peak channel is its own fixed point, so its ratio is 0/0; the claim
      // is about the channels that actually move.
      const moving = [0, 1, 2].filter((c) => original[c] !== achromatic)
      expect(moving.length).toBeGreaterThan(1)
      const scales = moving.map(
        (c) => ((out[c] ?? Number.NaN) - achromatic) / ((original[c] ?? Number.NaN) - achromatic),
      )
      for (const scale of scales) {
        expect(scale).toBeCloseTo(scales[0] ?? Number.NaN, 9)
      }
    }
  })

  it('preserves the linear-RGB chroma direction exactly, which is the real guarantee', () => {
    // The invariant the operator actually gives, and the one worth asserting
    // exactly: every channel moves toward the achromatic value in the same
    // proportion, so the chroma vector keeps its direction and only its length
    // changes.
    //
    // This is here because the CIELAB claim below used to be stated as this one.
    // They are different, and conflating them is what let a bound fitted to seven
    // colours be documented as a general guarantee.
    const cases: Vec3[] = [
      [1, -0.3, -0.1], [0.9, -0.15, 0.4], [0.2, 1.1, -0.35],
      [-0.25, 0.6, 1], [-0.4, -0.1, 1], [1.4, 0.35, -0.2], [0.31, -0.08, -0.47],
    ]
    for (const original of cases) {
      const out = gamutCompressRgb(original, GAMUT_COMPRESS_THRESHOLD)
      const a0 = Math.max(...original)
      const a1 = Math.max(...out)
      const before = original.map((v) => v - a0)
      const after = out.map((v) => v - a1)
      const n0 = Math.hypot(...before)
      const n1 = Math.hypot(...after)
      if (n0 < 1e-9 || n1 < 1e-9) continue
      const cosine = before.reduce((s, v, i) => s + v * (after[i] ?? 0), 0) / (n0 * n1)
      expect(cosine, `chroma direction on ${original.join(', ')}`).toBeCloseTo(1, 10)
    }
  })

  it('shifts perceptual hue far less than clipping does', () => {
    // Measured in CIELAB, where scaling toward achromatic in linear RGB does
    // *not* preserve hue, so the operator can fail this and the number means
    // something.
    //
    // The bound is a bound rather than an exactness claim, because compression
    // genuinely does move perceptual hue — up to 17 degrees on a saturated
    // green. What it buys is that clipping moves it three times as far in total,
    // and worse on every colour tested.
    const hueOf = (rgb: Vec3): number => labHueAngle(linearSrgbToLab(rgb))

    const cases: Vec3[] = [
      [1, -0.3, -0.1],
      [0.9, -0.15, 0.4],
      [0.2, 1.1, -0.35],
      [-0.25, 0.6, 1],
      [-0.4, -0.1, 1],
      [-0.3, 0.9, 0.95],
      [1.4, 0.35, -0.2],
    ]

    let compressedTotal = 0
    let clippedTotal = 0
    const worse: string[] = []

    for (const original of cases) {
      // Chroma floor before any angle. A hue angle is `atan2(b*, a*)` and is
      // meaningless as chroma goes to zero — it returns a confident number
      // rather than an error, which is how three identical film curves once
      // reported 68 degrees of crossover. Every colour here must have real
      // chroma for the angles below to mean anything.
      expect(
        labChroma(linearSrgbToLab(original)),
        `${original.join(', ')} has no chroma, so its hue is undefined`,
      ).toBeGreaterThan(5)
      const clipped: Vec3 = [
        Math.max(0, original[0]),
        Math.max(0, original[1]),
        Math.max(0, original[2]),
      ]
      const compressed = gamutCompressRgb(original, GAMUT_COMPRESS_THRESHOLD)
      const target = hueOf(original)
      const compressedShift = hueDifference(hueOf(compressed), target)
      const clippedShift = hueDifference(hueOf(clipped), target)

      compressedTotal += compressedShift
      clippedTotal += clippedShift
      if (compressedShift > clippedShift) {
        worse.push(`${original.join(', ')}: compressed ${compressedShift.toFixed(1)}deg vs clipped ${clippedShift.toFixed(1)}deg`)
      }
      // No single colour may move further than this.
      //
      // **Do not tighten this without looking at green.** The bound is loose for
      // red and blue — 3.0 and 1.5 degrees measured — and nearly touches on
      // saturated green at 17.1. That is not the compressor performing worse
      // there; it is the metric. AP1 green sits far outside sRGB, and CIELAB is
      // at its least perceptually uniform in exactly that region, so a fixed
      // angular bound covers red and blue comfortably and green barely. Someone
      // reading only the red and blue figures will conclude there is slack here
      // and break green.
      //
      // Deep blues are the other case to watch, for the opposite reason: RGB
      // ratio hue and perceptual hue diverge most there, which is the "blue goes
      // purple" failure, and it is where the compressor will work hardest once
      // white balance and film curves land.
      expect(compressedShift, `hue shift on ${original.join(', ')}`).toBeLessThan(20)
    }

    // On THESE colours, compression wins on every one. Stated as a fact about
    // this sample rather than as a general guarantee, which is what it used to
    // be and what turned out to be false — see the sweep below.
    expect(worse.join('\n'), 'compression is worse than clipping on a Stage 6 colour').toBe('')
    // Measured at 39.8 against 115.9. Asserted with room, since the point is the
    // margin rather than the exact figure.
    expect(compressedTotal).toBeLessThan(clippedTotal / 2)
  })

  it('reduces saturation rather than darkening, leaving the brightest channel alone', () => {
    // The achromatic value is the largest channel, so it is its own fixed point.
    // A compression that moved it would dim the colour as a side effect of
    // bringing it into gamut, which reads as a dark fringe on saturated edges.
    for (const rgb of [[1, -0.3, -0.1], [0.2, 1.1, -0.35], [-0.25, 0.6, 1]] as Vec3[]) {
      const peak = Math.max(rgb[0], rgb[1], rgb[2])
      const out = gamutCompressRgb(rgb, GAMUT_COMPRESS_THRESHOLD)
      expect(Math.max(out[0], out[1], out[2])).toBeCloseTo(peak, 12)
    }
  })

  it('holds the hue bound with white balance active at its extremes', () => {
    // White balance is the first pass that pushes colours out of gamut in normal
    // use, so the bound established on hand-picked colours has to survive real
    // ones. Saturated patches are adapted at both ends of the temperature range
    // and both ends of tint, converted to display primaries, and put through the
    // compressor.
    //
    // Skies are the case to watch and are included deliberately: they are the
    // most saturated blues a photograph normally contains, and blue is where RGB
    // ratio hue and perceptual hue diverge most.
    const hueOf = (rgb: Vec3): number => labHueAngle(linearSrgbToLab(rgb))

    // Saturated ACEScg colours a graded photograph produces, including two skies.
    const working: Vec3[] = [
      [0.05, 0.18, 0.75],
      [0.02, 0.28, 0.9],
      [0.9, 0.12, 0.05],
      [0.75, 0.6, 0.05],
      [0.06, 0.7, 0.2],
      [0.5, 0.05, 0.6],
    ]
    const settings: [number, number][] = [
      [2000, 0],
      [2500, -100],
      [12000, 0],
      [12000, 100],
      [3200, 60],
    ]

    let worst = 0
    let worstDescription = ''
    let compressedTotal = 0
    let clippedTotal = 0
    let outOfGamutCases = 0

    for (const [temperature, tint] of settings) {
      const balance = whiteBalanceMatrix(temperature, tint)
      for (const colour of working) {
        const balanced = mat3MulVec3(balance, colour)
        const linear = mat3MulVec3(ACESCG_TO_SRGB, balanced)
        if (linear.every((v) => v >= 0)) continue
        outOfGamutCases++

        const clipped: Vec3 = [
          Math.max(0, linear[0]),
          Math.max(0, linear[1]),
          Math.max(0, linear[2]),
        ]
        const compressed = gamutCompressRgb(linear, GAMUT_COMPRESS_THRESHOLD)
        // Chroma floor, as above: white balance could in principle produce a
        // near-neutral out-of-gamut colour, whose hue angle would be noise.
        if (labChroma(linearSrgbToLab(linear)) < 2) continue
        const target = hueOf(linear)
        const shift = hueDifference(hueOf(compressed), target)

        compressedTotal += shift
        clippedTotal += hueDifference(hueOf(clipped), target)
        if (shift > worst) {
          worst = shift
          worstDescription = `${temperature}K tint ${tint} on ${colour.join(', ')}`
        }
      }
    }

    // The comparison has to be measuring something.
    expect(outOfGamutCases, 'white balance must push colours out of gamut').toBeGreaterThan(5)
    expect(worst, `worst hue shift was ${worst.toFixed(1)}deg at ${worstDescription}`).toBeLessThan(20)
    expect(compressedTotal).toBeLessThan(clippedTotal)
  })

  it('meets its own identity section smoothly at the threshold', () => {
    const t = GAMUT_COMPRESS_THRESHOLD
    const at = (distance: number): number => {
      // A colour whose green sits at the given distance from an achromatic of 1.
      const rgb: Vec3 = [1, 1 - distance, 1]
      return gamutCompressRgb(rgb, t)[1]
    }
    const h = 1e-6
    const below = (at(t) - at(t - h)) / h
    const above = (at(t + h) - at(t)) / h
    // Distance increasing means the channel decreasing, so the slope is -1.
    expect(below).toBeCloseTo(-1, 4)
    expect(above).toBeCloseTo(-1, 3)
  })
})

describe('the assembled display transform', () => {
  it('leaves an ordinary in-gamut photograph untouched below the knee', () => {
    // The property that decides whether opening a file changes it. Everything an
    // 8-bit source contains below the knee must survive the display path
    // unaltered, or the editor is grading images nobody asked it to.
    for (const encoded of [0.05, 0.2, 0.4, 0.6]) {
      const linear = srgbEotf(encoded)
      const acescg = mat3MulVec3(SRGB_TO_ACESCG, [linear, linear, linear])
      const out = displayTransform(acescg, DEFAULT_DISPLAY_SETTINGS)
      for (let c = 0; c < 3; c++) {
        expect(out[c], `encoded ${encoded} channel ${c}`).toBeCloseTo(encoded, 6)
      }
    }
  })

  it('keeps middle grey at middle grey through the whole chain', () => {
    const acescg = mat3MulVec3(SRGB_TO_ACESCG, [
      MIDDLE_GREY_LINEAR,
      MIDDLE_GREY_LINEAR,
      MIDDLE_GREY_LINEAR,
    ])
    const out = displayTransform(acescg, DEFAULT_DISPLAY_SETTINGS)
    for (let c = 0; c < 3; c++) {
      expect(out[c]).toBeCloseTo(srgbOetf(MIDDLE_GREY_LINEAR), 6)
    }
  })

  it('produces output inside the encodable range without relying on the clamp', () => {
    // With both stages on, the clamp is a safety net rather than something the
    // image depends on: compression removes the negatives and the shoulder is
    // bounded below 1.
    for (const acescg of [
      [40, 0.2, 0.001],
      [0, 12, 0],
      [3, 3, 3],
      [0.9, 0.02, 2.5],
    ] as Vec3[]) {
      const linear = mat3MulVec3(ACESCG_TO_SRGB, acescg)
      const compressed = gamutCompressRgb(linear, GAMUT_COMPRESS_THRESHOLD)
      const mapped = toneMapRgb(compressed, TONE_MAP_KNEE)
      for (let c = 0; c < 3; c++) {
        expect(mapped[c], `channel ${c}`).toBeGreaterThanOrEqual(0)
        expect(mapped[c], `channel ${c}`).toBeLessThan(1)
      }
    }
  })

  it('keeps the identity path free of both stages, for round-trip verification', () => {
    // sRGB in must equal sRGB out through an otherwise identity pipeline. This
    // is impossible against tone-mapped output and is what the two-leg harness
    // addresses the matrix through.
    for (const encoded of [0.02, 0.35, 0.78, 1]) {
      const linear = srgbEotf(encoded)
      const acescg = mat3MulVec3(SRGB_TO_ACESCG, [linear, linear, linear])
      const out = displayTransformIdentity(acescg)
      for (let c = 0; c < 3; c++) {
        expect(out[c]).toBeCloseTo(encoded, 6)
      }
    }
  })

  it('recovers highlights the clamp alone would have flattened', () => {
    // The measurement this stage exists for, at a single pixel. Two highlights
    // that a clamp makes identical must come out different.
    const bright = mat3MulVec3(SRGB_TO_ACESCG, [1.5, 1.5, 1.5])
    const brighter = mat3MulVec3(SRGB_TO_ACESCG, [6, 6, 6])

    const clampOnly = { ...DEFAULT_DISPLAY_SETTINGS, toneMap: false, gamutCompress: false }
    expect(displayTransform(bright, clampOnly)[0]).toBeCloseTo(1, 12)
    expect(displayTransform(brighter, clampOnly)[0]).toBeCloseTo(1, 12)

    const a = displayTransform(bright, DEFAULT_DISPLAY_SETTINGS)[0]
    const b = displayTransform(brighter, DEFAULT_DISPLAY_SETTINGS)[0]
    expect(a).toBeLessThan(1)
    expect(b).toBeLessThan(1)
    expect(b).toBeGreaterThan(a)
  })
})

describe('the gamut compressor over everything the pipeline can reach', () => {
  /**
   * The bound, restated as a worst case measured over the whole space.
   *
   * The Stage 6 version was fitted to seven colours reachable by white balance,
   * which move roughly along the blue-yellow axis, and was then documented as a
   * general guarantee. HSL saturation can push any hue arbitrarily far, and the
   * guarantee did not survive contact with it.
   *
   * That is the occupancy failure one level up — applied to a test's *input
   * space* rather than to a parameter's domain. The same question ("does this
   * sample cover where the data actually is?") had already been asked three times
   * about parameters, and not once about the colours a test feeds itself.
   */
  const sweep = (): {
    worstCompressed: number
    worstClipped: number
    wins: number
    total: number
  } => {
    const hueOf = (rgb: Vec3): number => labHueAngle(linearSrgbToLab(rgb))
    const chromaOf = (rgb: Vec3): number => labChroma(linearSrgbToLab(rgb))
    let worstCompressed = 0
    let worstClipped = 0
    let wins = 0
    let total = 0
    for (let r = -0.6; r <= 2.0; r += 0.2) {
      for (let g = -0.6; g <= 2.0; g += 0.2) {
        for (let b = -0.6; b <= 2.0; b += 0.2) {
          const rgb: Vec3 = [r, g, b]
          if (Math.max(r, g, b) <= 0) continue
          // A chroma floor before any angle, as everywhere else in this suite.
          if (chromaOf(rgb) < 5) continue
          const compressed = gamutCompressRgb(rgb, GAMUT_COMPRESS_THRESHOLD)
          if (chromaOf(compressed) < 5) continue
          const clipped: Vec3 = [
            Math.min(1, Math.max(0, r)),
            Math.min(1, Math.max(0, g)),
            Math.min(1, Math.max(0, b)),
          ]
          const shift = Math.abs(hueDifference(hueOf(compressed), hueOf(rgb)))
          const clippedShift =
            chromaOf(clipped) < 5 ? 0 : Math.abs(hueDifference(hueOf(clipped), hueOf(rgb)))
          total++
          if (shift <= clippedShift) wins++
          worstCompressed = Math.max(worstCompressed, shift)
          worstClipped = Math.max(worstClipped, clippedShift)
        }
      }
    }
    return { worstCompressed, worstClipped, wins, total }
  }

  it('has a worst case, and it is better than clipping s worst case', () => {
    const { worstCompressed, worstClipped, total } = sweep()
    expect(total).toBeGreaterThan(2000)
    // Measured at 63.0 and 91.4 on a denser sweep. Stated as a bound rather than
    // as an exact figure so the grid spacing here is not load-bearing.
    expect(worstCompressed, 'compressed worst case').toBeLessThan(70)
    expect(worstCompressed).toBeLessThan(worstClipped)
  })

  it('is better than clipping most of the time, and not always', () => {
    // The honest form of the claim that used to be universal. Both halves are
    // asserted: if it became universal the comment above would be describing a
    // build that no longer exists, and if it dropped below a majority the
    // operator would no longer be earning its place.
    const { wins, total } = sweep()
    expect(wins / total, 'share where compression is at least as good').toBeGreaterThan(0.7)
    expect(wins).toBeLessThan(total)
  })

  it('is strongly hue-dependent, which is what the failures actually are', () => {
    // The brief describing this work called the failures unpredictable. They are
    // not: the shift is a smooth, strong function of hue angle, peaking near red
    // and falling to almost nothing near cyan. Measured on a hue sweep at fixed
    // chroma: 28.9 degrees at 0, 0.6 at 150, 18.0 at 255.
    const hueOf = (rgb: Vec3): number => labHueAngle(linearSrgbToLab(rgb))
    const worstAt = (hueDegrees: number): number => {
      const a = (hueDegrees * Math.PI) / 180
      let worst = 0
      for (let saturation = 1.2; saturation <= 3; saturation += 0.15) {
        const base = [
          0.5 + 0.4 * Math.cos(a),
          0.5 + 0.4 * Math.cos(a - 2.0944),
          0.5 + 0.4 * Math.cos(a + 2.0944),
        ]
        const grey = (base[0]! + base[1]! + base[2]!) / 3
        const rgb = base.map((v) => grey + (v - grey) * saturation) as unknown as Vec3
        if (labChroma(linearSrgbToLab(rgb)) < 5) continue
        const out = gamutCompressRgb(rgb, GAMUT_COMPRESS_THRESHOLD)
        if (labChroma(linearSrgbToLab(out)) < 5) continue
        worst = Math.max(worst, Math.abs(hueDifference(hueOf(out), hueOf(rgb))))
      }
      return worst
    }
    expect(worstAt(0), 'red').toBeGreaterThan(20)
    expect(worstAt(150), 'cyan').toBeLessThan(3)
    expect(worstAt(0)).toBeGreaterThan(worstAt(150) * 5)
  })
})
