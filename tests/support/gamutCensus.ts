/**
 * The gamut census: what the display transform is handed, on a real photograph.
 *
 * Lives in the repository so the numbers in `tests/README.md` can be
 * reproduced, and so the before-and-after either side of the gate comes out of
 * one binary rather than out of two logs taken weeks apart.
 *
 * # What is compared, and the correction that forced a rewrite
 *
 * The first version of this measured, for each pixel, the hue shift of the
 * compressed path against the *unclamped* colour, and attributed the whole of
 * it to the compressor on the reasoning that "clipping does nothing here".
 *
 * That reasoning was wrong, and the gate is what exposed it. The clamp does
 * nothing on an in-gamut colour, but **the tone map does**: it is per channel,
 * so it bleaches a bright saturated colour toward white and moves its hue. With
 * the compressor gated off in gamut the old metric still reported an "in-gamut
 * shift", because it had been measuring the tone map all along and calling it
 * compression.
 *
 * So the compressor's contribution is now isolated the only way it can be —
 * against the same pipeline with compression switched off:
 *
 *     compressed   matrix -> compress -> tone map -> clamp
 *     clipped      matrix ->             tone map -> clamp
 *
 * Both are compared as CIELAB hue angle against the unclamped linear sRGB the
 * transform was handed. `attributable` is the difference between those two
 * shifts, and it is exactly zero wherever the compressor is the identity.
 *
 * # Two populations, never averaged
 *
 *   OUT OF GAMUT   a channel is negative. Both operators act, and "compression
 *                  is worse than clipping" is a real comparison.
 *   IN GAMUT       no channel is negative. The clamp is the identity, so any
 *                  hue the compressor moves here is a cost with nothing on the
 *                  other side of it. After the gate this is zero by
 *                  construction, and the census is what checks that on a
 *                  photograph rather than on hand-picked colours.
 *
 * # Scope
 *
 * Hue only. Clipping also destroys chroma and shifts lightness and none of that
 * is here, so "worse" throughout means "worse on hue". A pixel whose reference
 * CIELAB chroma is under 1 has no hue worth measuring and is excluded.
 */

import { ACESCG_TO_SRGB } from '../../src/core/colour/matrices'
import { mat3MulVec3 } from '../../src/core/colour/types'
import type { Vec3 } from '../../src/core/colour/types'
import {
  GAMUT_COMPRESS_THRESHOLD,
  gamutCompressRgb,
  toneMapRgb,
} from '../../src/core/colour/display'
import { linearSrgbToLab, labHueAngle, labChroma, hueDifference } from '../../src/core/colour/lab'
import { DEFAULT_EDIT_STATE, mergeEditState } from '../../src/core/state/editState'
import type { EditState } from '../../src/core/state/editState'
import { buildChain, ingest } from './gamutChain'

/**
 * How negative a channel must be to count as out of gamut.
 *
 * Not cosmetic. Without it a neutral edit — sRGB in, sRGB out, the identity in
 * exact arithmetic — reported up to 2% of pixels as out of gamut, every one of
 * them round-trip error in the matrix pair. Measured over a sweep of the 8-bit
 * cube, the worst negative that round trip produces anywhere is 2.22e-16, one
 * ulp, and the count falls to zero at any epsilon from 1e-12 up.
 *
 * 1e-9 is seven orders above that noise and six below 1/255, the smallest
 * excursion that could change an output code value.
 */
export const GAMUT_EPSILON = 1e-9

/** CIELAB chroma below which a pixel has no hue worth measuring. */
const NEUTRAL_CHROMA = 1

/** Below this, a hue difference is not something anyone can see. */
const VISIBLE_DEGREES = 1

/** A compressor to measure. Lets the census run either side of a change. */
export type Compressor = (rgb: Vec3, threshold: number) => Vec3

/**
 * The operator as it stood before the gate: triggered on saturation distance,
 * with a shoulder whose knee is the threshold.
 *
 * Kept here, in the measurement rather than in the source, purely so the
 * before-and-after in `tests/README.md` is one program's output. It is not
 * reachable from the application.
 */
export const legacyDistanceTriggered: Compressor = (rgb, threshold) => {
  const achromatic = Math.max(rgb[0], rgb[1], rgb[2])
  if (achromatic <= 0) return rgb
  const distance = Math.max(
    (achromatic - rgb[0]) / achromatic,
    (achromatic - rgb[1]) / achromatic,
    (achromatic - rgb[2]) / achromatic,
  )
  if (distance <= threshold) return rgb
  // The shoulder, inlined: identity to the knee, then hyperbolic toward 1.
  const d = 1 - threshold
  const mapped = 1 - (d * d) / (distance - threshold + d)
  const scale = mapped / distance
  return [
    achromatic + scale * (rgb[0] - achromatic),
    achromatic + scale * (rgb[1] - achromatic),
    achromatic + scale * (rgb[2] - achromatic),
  ]
}

/** The operator as it stands: gated on an actual out-of-gamut condition. */
export const current: Compressor = gamutCompressRgb

export interface Stats {
  readonly total: number
  readonly neutralExcluded: number
  // Out of gamut: a channel is negative. Both operators act.
  readonly oog: number
  readonly oogWorse: number
  readonly oogWorseVisible: number
  /** Harmed by at least this many degrees. Fixed cut-offs, so the before and
   *  after share a denominator and cannot be confused by the "worse" set
   *  changing size underneath a percentile. */
  readonly oogWorseBy5: number
  readonly oogWorseBy15: number
  readonly oogLossMedian: number
  readonly oogLossP99: number
  readonly oogLossMax: number
  // In gamut: the clamp is the identity, so this is pure cost.
  readonly inGamutTouched: number
  readonly inGamutVisible: number
  readonly inGamutShiftP99: number
  readonly inGamutShiftMax: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[i]!
}

function clamp01(v: Vec3): Vec3 {
  return [
    Math.min(1, Math.max(0, v[0])),
    Math.min(1, Math.max(0, v[1])),
    Math.min(1, Math.max(0, v[2])),
  ]
}

export function census(
  pixels: Uint8Array,
  state: EditState,
  compress: Compressor,
  threshold: number = GAMUT_COMPRESS_THRESHOLD,
): Stats {
  const chain = buildChain(state)
  const knee = state.toneMapKnee
  const oogLosses: number[] = []
  const inGamutShifts: number[] = []
  let neutralExcluded = 0
  let oog = 0
  let oogWorse = 0
  let oogWorseVisible = 0
  let oogWorseBy5 = 0
  let oogWorseBy15 = 0
  let inGamutTouched = 0
  let inGamutVisible = 0
  const total = pixels.length / 3

  for (let i = 0; i < pixels.length; i += 3) {
    const linear = mat3MulVec3(
      ACESCG_TO_SRGB,
      chain(ingest(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)),
    )

    const compressed = compress(linear, threshold)
    const negative = Math.min(linear[0], linear[1], linear[2]) < -GAMUT_EPSILON
    const touched =
      compressed[0] !== linear[0] || compressed[1] !== linear[1] || compressed[2] !== linear[2]

    // Nothing happened and nothing was out of gamut: no question to ask.
    if (!negative && !touched) continue

    const reference = linearSrgbToLab(linear)
    if (labChroma(reference) < NEUTRAL_CHROMA) {
      neutralExcluded++
      continue
    }
    const trueHue = labHueAngle(reference)

    const withCompression = clamp01(toneMapRgb(compressed, knee))
    const withoutCompression = clamp01(toneMapRgb(linear, knee))
    const shiftWith = Math.abs(
      hueDifference(labHueAngle(linearSrgbToLab(withCompression)), trueHue),
    )
    const shiftWithout = Math.abs(
      hueDifference(labHueAngle(linearSrgbToLab(withoutCompression)), trueHue),
    )

    if (negative) {
      oog++
      const delta = shiftWith - shiftWithout
      if (delta > 0) {
        oogWorse++
        if (delta >= VISIBLE_DEGREES) oogWorseVisible++
        if (delta >= 5) oogWorseBy5++
        if (delta >= 15) oogWorseBy15++
        oogLosses.push(delta)
      }
    } else {
      // In gamut. The tone map acts on both paths identically, so the
      // difference between them is the compressor's contribution and nothing
      // else — which is the correction that the gate forced.
      inGamutTouched++
      const attributable = Math.abs(shiftWith - shiftWithout)
      inGamutShifts.push(attributable)
      if (attributable >= VISIBLE_DEGREES) inGamutVisible++
    }
  }

  oogLosses.sort((a, b) => a - b)
  inGamutShifts.sort((a, b) => a - b)

  return {
    total,
    neutralExcluded,
    oog,
    oogWorse,
    oogWorseVisible,
    oogWorseBy5,
    oogWorseBy15,
    oogLossMedian: percentile(oogLosses, 50),
    oogLossP99: percentile(oogLosses, 99),
    oogLossMax: oogLosses.at(-1) ?? 0,
    inGamutTouched,
    inGamutVisible,
    inGamutShiftP99: percentile(inGamutShifts, 99),
    inGamutShiftMax: inGamutShifts.at(-1) ?? 0,
  }
}

export { mergeEditState, DEFAULT_EDIT_STATE }
