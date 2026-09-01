/**
 * The display transform: scene-referred ACEScg to an encoded display signal.
 *
 * Three stages, each independently disableable, in this order:
 *
 *   ACEScg -> display primaries -> gamut compression -> tone map -> encode
 *
 * They fix two different problems and are kept apart because of it. **Gamut
 * compression handles colours too saturated for the display**; tone mapping
 * handles values too **bright** for it. A colour can need one, the other, both
 * or neither.
 *
 * Compression runs first. Its job is to make the colour representable at all,
 * and it leaves every channel non-negative; the tone map then only has to deal
 * with the top end, and because it is bounded below 1 for non-negative input,
 * the final clamp becomes a safety net rather than something the image depends
 * on. Running them the other way round would have the tone map altering channel
 * ratios — that is what it does — and so changing what is out of gamut before
 * anything had measured it.
 *
 * # Choosing the operator
 *
 * The requirement is a highlight roll-off that preserves ordering and detail
 * instead of clipping, on a pipeline whose *character is supposed to come from
 * the film stage*. That last clause decides it.
 *
 * **Not the ACES RRT plus sRGB ODT**, though it is the reference-correct answer
 * for an ACES pipeline. It is several hundred lines, it carries a pronounced
 * look of its own — a strong S-curve and a well-known skew through the reds and
 * oranges — which would sit underneath the film curves applying a second look
 * they did not ask for. Decisively, it maps 0.18 to roughly 0.10 display-linear,
 * which moves middle grey and breaks the property below.
 *
 * **Not Reinhard, plain or extended.** Neither is the identity anywhere, so both
 * compress the midtones and move middle grey.
 *
 * **Not Hable / Uncharted 2.** It has a toe built in, which crushes shadows —
 * again a second look under the film curves — and its six coefficients are
 * opaque to tune.
 *
 * **Chosen: a hyperbolic shoulder that is exactly the identity below a knee.**
 * This is the highlight structure of the Khronos PBR Neutral operator, which was
 * designed for the same requirement of not imposing a look. It is six lines, has
 * one meaningful parameter, and gives the middle-grey property **by
 * construction rather than by approximation**: with the knee above 0.18, middle
 * grey and everything below it pass through untouched, exactly.
 */

import type { Vec3 } from './types'
import { ACESCG_TO_SRGB } from './matrices'
import { srgbOetf } from './transfer'
import { mat3MulVec3 } from './types'

/**
 * Scene-linear value at and below which the tone map is the identity.
 *
 * Must sit above 0.18 or middle grey moves. Everything else is a trade, and it
 * is the only real one in the operator: a higher knee leaves an unedited image
 * closer to untouched but crams pushed highlights into fewer code values, and a
 * lower knee spreads the highlights at the cost of dimming nominal white.
 *
 * The default was chosen from a measured sweep rather than by reasoning, on a
 * backlit frame, trading how far an *unedited* image moves against how many
 * distinct code values the recovered highlights occupy:
 *
 *   knee 0.4  unedited shifts 13.3 code values on average   19 highlight levels
 *   knee 0.6  unedited shifts  5.7                          15
 *   knee 0.75 unedited shifts  ~1.9                         ~12
 *   knee 0.8  unedited shifts  1.1                          10
 *
 * Dropping the knee from 0.8 to 0.4 costs twelve code values of fidelity on
 * every unedited photograph to buy nine levels of highlight detail, which is a
 * poor bargain for an editor whose source is 8-bit: a JPEG has no data above
 * diffuse white to recover, so the roll-off is mostly working on values the
 * *pipeline* created rather than rescuing anything from the file.
 *
 * 0.75 sits where the unedited shift is below the threshold of visibility and
 * most of the highlight separation is still there. `tests/README.md` carries the
 * full table.
 */
export const TONE_MAP_KNEE = 0.75

/**
 * Distance from the achromatic axis, as a fraction of the achromatic value, at
 * and below which gamut compression is the identity.
 *
 * A note on what this can and cannot promise. It is often stated that gamut
 * compression should leave in-gamut colours unchanged, and that cannot hold for
 * *all* of them. A colour with a channel at exactly zero — a pure display
 * primary — sits at distance 1.0, which is the same place the compression must
 * be already working if it is to pull negative channels back. Any smooth curve
 * that maps distances above some threshold into a bounded range must therefore
 * start below 1.0 and touch the most saturated in-gamut colours.
 *
 * So the honest guarantee is the one asserted in the tests: **colours within
 * this distance are unchanged exactly**, and beyond it the change grows
 * smoothly. At 0.9 that is everything up to nine tenths of the way to the gamut
 * boundary; a pure primary moves by 0.05 of its own achromatic value.
 */
export const GAMUT_COMPRESS_THRESHOLD = 0.9

export interface DisplaySettings {
  readonly toneMap: boolean
  readonly gamutCompress: boolean
  readonly toneMapKnee: number
  readonly gamutThreshold: number
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  toneMap: true,
  gamutCompress: true,
  toneMapKnee: TONE_MAP_KNEE,
  gamutThreshold: GAMUT_COMPRESS_THRESHOLD,
}

/**
 * The shared shoulder: identity up to `knee`, then a hyperbolic approach to
 * `limit` that never reaches it.
 *
 *     f(x) = limit - d^2 / (x - knee + d)      where d = limit - knee
 *
 * Three properties hold by construction rather than by choice of constants, and
 * all three are asserted:
 *
 * - `f(knee) = knee`, so the two pieces meet.
 * - `f'(knee) = 1`, so they meet *smoothly* — no visible edge where the roll-off
 *   begins, which is what a discontinuity in slope looks like on a gradient.
 * - `f' > 0` everywhere, so ordering is never inverted. A tone map that
 *   reordered two values would make a brighter part of the scene render darker.
 */
function shoulder(x: number, knee: number, limit: number): number {
  if (x <= knee) return x
  const d = limit - knee
  return limit - (d * d) / (x - knee + d)
}

/**
 * Tone map one channel. Identity at and below the knee, asymptotic to 1.
 *
 * Negative input is returned unchanged. Gamut compression removes negatives
 * before this runs, so in the assembled transform it never sees one; on its own
 * it declines to invent a meaning for them rather than producing something
 * plausible from `pow` of a negative.
 */
export function toneMapChannel(linear: number, knee: number): number {
  return shoulder(linear, knee, 1)
}

/**
 * Applied **per channel**, which desaturates highlights as they roll off.
 *
 * That is deliberate and it is what film does: as an emulsion approaches
 * saturation the three layers reach it at different exposures, so a bright
 * saturated colour bleaches toward white rather than holding its hue to the
 * clip point. It is also consistent with the per-channel contrast operator in
 * `grade.ts`, and the two decisions should stay together — a per-channel
 * contrast feeding a hue-preserving tone map would produce saturation that
 * climbs with contrast and then refuses to bleach, which is neither film nor
 * digital.
 *
 * The alternative, noted rather than taken: scale all three channels by the
 * ratio the *peak* channel is compressed by. That preserves hue and saturation
 * exactly, but then needs a separate desaturation control to look like anything
 * photographic, and it can leave individual channels above 1 when the peak is
 * the only one compressed.
 */
export function toneMapRgb(rgb: Vec3, knee: number): Vec3 {
  return [
    toneMapChannel(rgb[0], knee),
    toneMapChannel(rgb[1], knee),
    toneMapChannel(rgb[2], knee),
  ]
}

/**
 * Pull out-of-gamut colours toward the achromatic axis instead of clipping them.
 *
 * # Hue is preserved by construction, and the first attempt was not
 *
 * The obvious implementation compresses each channel's **own** distance from the
 * achromatic value independently. It brings every negative channel back into
 * range and it keeps them ordered, so it looks correct — and it shifts hue,
 * sometimes further than clipping does. Measured on `[0.2, 1.1, -0.35]`: the
 * original sits at a hue angle of 97.9 degrees, clipping moves it to 110.2, and
 * per-channel compression moved it to 111.1. Worse than the thing it replaced.
 *
 * The reason is that compressing distances independently moves each channel by a
 * different proportion, and the direction of the chroma vector — which *is* the
 * hue — changes as a result. Guaranteeing non-negativity makes it worse still:
 * the negative channel has to be pushed past zero, so it travels further than
 * clipping would have taken it.
 *
 * What this does instead is scale the **whole chroma vector** by one factor:
 *
 *     out = achromatic + s * (rgb - achromatic)
 *
 * Every channel moves toward the achromatic value in the same proportion, so the
 * chroma vector keeps its direction exactly and only its length changes. Hue is
 * therefore preserved to floating point, not approximately, and what the
 * operator does is reduce saturation — which is what gamut mapping is. On the
 * same colour it holds 97.9 degrees exactly.
 *
 * `s` comes from the same shoulder as the tone map, applied to the *largest*
 * channel distance:
 *
 * - all distances within the threshold: `s = 1`, the colour is untouched exactly
 * - the worst distance far outside: `s -> 1/distance`, putting that channel at
 *   zero and every other one proportionally
 *
 * The achromatic value is the largest channel, so it is itself unmoved and the
 * colour never darkens as a side effect of being brought into gamut.
 */
export function gamutCompressRgb(rgb: Vec3, threshold: number): Vec3 {
  const achromatic = Math.max(rgb[0], rgb[1], rgb[2])
  // Nothing to compress toward: the colour is black or entirely negative, and
  // the encode's clamp is the right place to resolve it.
  if (achromatic <= 0) return rgb

  const distance = Math.max(
    (achromatic - rgb[0]) / achromatic,
    (achromatic - rgb[1]) / achromatic,
    (achromatic - rgb[2]) / achromatic,
  )
  if (distance <= threshold) return rgb

  const scale = shoulder(distance, threshold, 1) / distance
  return [
    achromatic + scale * (rgb[0] - achromatic),
    achromatic + scale * (rgb[1] - achromatic),
    achromatic + scale * (rgb[2] - achromatic),
  ]
}

/**
 * The whole display transform, mirroring `display.frag` exactly.
 *
 * `identity` skips both stages and the clamp. It is a debug path and must not be
 * reachable from ordinary controls: it exists because an sRGB round trip cannot
 * be verified against a tone-mapped output, and the agreement harness depends on
 * being able to address the matrix without the operator in the way.
 */
export function displayTransform(acescg: Vec3, settings: DisplaySettings): Vec3 {
  let linear = mat3MulVec3(ACESCG_TO_SRGB, acescg)

  if (settings.gamutCompress) linear = gamutCompressRgb(linear, settings.gamutThreshold)
  if (settings.toneMap) linear = toneMapRgb(linear, settings.toneMapKnee)

  const clamped: Vec3 = [
    Math.min(1, Math.max(0, linear[0])),
    Math.min(1, Math.max(0, linear[1])),
    Math.min(1, Math.max(0, linear[2])),
  ]
  return [srgbOetf(clamped[0]), srgbOetf(clamped[1]), srgbOetf(clamped[2])]
}

/** The identity debug path: matrix and encode only, no compression, no clamp. */
export function displayTransformIdentity(acescg: Vec3): Vec3 {
  const linear = mat3MulVec3(ACESCG_TO_SRGB, acescg)
  return [srgbOetf(linear[0]), srgbOetf(linear[1]), srgbOetf(linear[2])]
}
