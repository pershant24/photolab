/**
 * The display transform: display-referred ACEScg to an encoded display signal.
 *
 * Display-referred, not scene-referred — see `docs/ARCHITECTURE.md` §1a. That is
 * why this operator is the identity through the midtones rather than applying a
 * rendering of its own: the data already carries the camera's.
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
 * for an ACES pipeline. It is several hundred lines and carries a pronounced look
 * of its own, which would sit underneath the film curves applying a second look
 * they did not ask for.
 *
 * The decisive reason is better than that, and is about referredness rather than
 * about taste. The RRT maps 0.18 to roughly 0.10 display-linear because it
 * **includes an OOTF** — the rendering that turns scene light into display light
 * for a dim viewing surround. That is correct for scene-referred camera data. The
 * input here is a JPEG, which already carries a camera's rendering, so applying
 * the RRT would apply an OOTF twice. Middle grey preservation is the right
 * constraint *because* this pipeline is display-referred; against scene-referred
 * data it would have been the wrong one.
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
 * # There is no free choice here, and the arithmetic says so exactly
 *
 * Any operator that is the identity below a knee, continuous, and compressing
 * above it maps **everything between the knee and 1.0 below itself**. So
 * preserving unedited white exactly and rolling off above 1.0 cannot both hold.
 * For this shoulder the trade has a closed form:
 *
 *     f(1.0) = (1 + knee) / 2
 *
 * which means **the code values given up below white are exactly the code values
 * gained above it.** Everything from a scene value of 1.0 up to infinity lands
 * between `f(1.0)` and 1, so the deficit and the headroom are the same number:
 *
 *   knee 0.60   white renders at code 231   24 codes given up, 24 gained
 *   knee 0.75   white renders at code 240   15 given up, 15 gained
 *   knee 0.85   white renders at code 246    9 given up, 9 gained
 *   knee 0.95   white renders at code 252    3 given up, 3 gained
 *
 * The knee *is* the white point parameter, seen from the other end.
 *
 * The symmetry is **exact in linear light and only approximate in code values**.
 * The budget of `(1 - knee)/2` either side of `f(1.0)` is exact as a linear
 * quantity; the code figures above are that budget seen through the sRGB encode,
 * which is monotone over the interval but not linear, so the two columns match
 * closely rather than identically.
 *
 * # Measured: no single default serves both an unedited and a graded image
 *
 * Distinct code values along a gradient through a backlit frame's sun, and down
 * its sky:
 *
 *   knee 0.75, unedited   sun 20 levels, sky 45      +2 EV   sun 2, sky 3
 *   knee 0.85, unedited   sun 25 levels, sky 51      +2 EV   sun 1, sky 2
 *
 * Raising the knee **improves** an untouched photograph, because more of it sits
 * below the knee at full resolution, and **flattens** a pushed one, because
 * everything above white has fewer code values to occupy. At +2 EV and a knee of
 * 0.85 the sun collapses to a single code value: not banded, gone.
 *
 * No fixed point on that trade is right for both, which is why this is a user
 * parameter in `EditState` rather than a constant. The largest step between
 * adjacent pixels stayed at one or two code values throughout, so the failure
 * mode is flattening rather than banding; if banding does appear once the film
 * stage generates genuinely wide-range values, ordered dither at the encode step
 * is the candidate mitigation.
 *
 * The earlier default of 0.75 was picked against a mean shift across the whole
 * image, which was the wrong statistic: every pixel below the knee is unchanged
 * by construction, so averaging over them understates the effect at the only
 * place the effect exists. Measured properly, 0.75 renders pure white 15 code
 * values below white — invisible in a mean, invisible on a photograph in
 * isolation, and plainly visible against white interface chrome or in a print.
 *
 * **0.85 is the default**: white within three and a half per cent of paper white,
 * and nine code values of headroom for what the pipeline creates. It errs toward
 * an unedited image looking like the file, which is the right default for an
 * editor; the knee is a parameter for anyone who wants the other trade.
 *
 * Worth revisiting once the film stage exists, in both directions. Its
 * characteristic curve has a shoulder of its own, which reduces what the display
 * roll-off has to do; halation adds light, which increases it.
 *
 * # Two kinds of adaptivity, and only one of them is safe
 *
 * **Adaptivity derived from `EditState` is purity-safe.** `EditState` is
 * identical for preview and for every export tile, so anything computed from it
 * alone gives the same answer everywhere. An automatic knee is derivable this
 * way: exposure stops and contrast slope together bound the largest value that
 * can reach the display transform, so a knee could be chosen to fit that bound
 * without measuring a single pixel.
 *
 * **Adaptivity derived from image content is not.** A tile does not know the
 * frame's global maximum, so a knee fitted to measured content would differ
 * between preview and export and between one tile and the next, and the renderer
 * would stop being a pure function of its inputs.
 *
 * The distinction matters because the earlier rule stated only the second half,
 * and read as a prohibition on adaptivity in general. It is not.
 *
 * The automatic knee is **not implemented**, and the reason is a judgement rather
 * than a constraint: a knee that moves while exposure is being dragged couples
 * two controls, and the highlights would shift for reasons the person dragging
 * did not ask for. Whether that feels like help or like the image getting away
 * from you is a question to answer with a photograph in front of you, not in a
 * comment.
 */
export const TONE_MAP_KNEE = 0.85

/**
 * The knee of the shoulder that pulls an out-of-gamut colour back, expressed as
 * a distance from the achromatic axis in units of the achromatic value.
 *
 * # This used to be the trigger, and that was the defect
 *
 * The comment here used to argue that "in-gamut colours are unchanged" could
 * not hold for all of them, because a pure display primary sits at distance 1.0
 * — the same region the compression must already be working in — so any smooth
 * curve had to start below 1.0 and touch the most saturated in-gamut colours.
 * The argument is sound. Its premise was not: it assumed the *trigger* had to be
 * this distance.
 *
 * It did not, and the cost of assuming so was measured rather than argued. On a
 * real photograph the largest population of colours the compressor harmed was
 * one that had never left the gamut — `distance` measures saturation, and it was
 * being read as though it measured excursion. A neutral edit with no grade at
 * all moved 0.23% of a frame. `tests/README.md` carries the census.
 *
 * The trigger is now an actual out-of-gamut condition — a negative channel after
 * the display matrix — and this value only decides *how hard* something already
 * outside is pulled back. That makes the strong guarantee reachable, and it is
 * asserted rather than measured: **an in-gamut colour is returned exactly**, the
 * same standard white balance and HSL meet at neutral. A pure display primary is
 * now untouched, where it used to move by 0.05 of its own achromatic value.
 *
 * Note what this implies about the number itself. Past the gate, `distance` is
 * always greater than 1, so nothing in the application's range can make this a
 * trigger again by accident.
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
 * chroma vector keeps its direction **exactly** — the cosine between the chroma
 * vectors before and after is 1 to floating point — and only its length changes.
 * What the operator does is reduce saturation, which is what gamut mapping is.
 *
 * # That is not the same as preserving perceptual hue, and this comment used to
 * # claim it was
 *
 * An earlier version of this note said hue was "preserved to floating point" and
 * cited a colour holding its CIELAB angle exactly. That is false, and measurably
 * so: `[0.2, 1.1, -0.35]` moves **17.1 degrees** in CIELAB under this operator.
 *
 * The two claims are different. Preserving the chroma vector's direction in
 * *linear sRGB* is exact and is what the maths gives. CIELAB hue is a nonlinear
 * function of the same values, and a straight line toward the achromatic point in
 * linear RGB is not a constant-hue line in CIELAB — the deviation is the Abney
 * effect, and it is real rather than an artifact of the metric.
 *
 * Measured over a dense sweep of everything the pipeline can hand this function,
 * negatives and values above one included:
 *
 *   worst compressed CIELAB hue shift    63.0 degrees
 *   worst clipped CIELAB hue shift       91.4 degrees
 *   compression at least as good as clipping on 79.8% of samples
 *
 * So compression has the better worst case and is better most of the time, and it
 * is **not** uniformly better. `tests/unit/display.test.ts` states it that way.
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
export function isOutOfGamut(rgb: Vec3): boolean {
  return rgb[0] < 0 || rgb[1] < 0 || rgb[2] < 0
}

export function gamutCompressRgb(rgb: Vec3, threshold: number): Vec3 {
  // THE GATE. A colour with no negative channel is inside the display
  // primaries and is returned as it arrived, exactly.
  if (!isOutOfGamut(rgb)) return rgb

  const achromatic = Math.max(rgb[0], rgb[1], rgb[2])
  // Nothing to compress toward: the colour is entirely negative, and the
  // encode's clamp is the right place to resolve it.
  if (achromatic <= 0) return rgb

  // Equal to `(achromatic - min) / achromatic`, and **greater than 1 by
  // construction** now that the gate has run: `min` is negative and
  // `achromatic` is positive. The threshold is therefore no longer a trigger.
  // It survives as the shoulder's knee, which is what decides how hard a
  // colour past the boundary is pulled back.
  const distance = Math.max(
    (achromatic - rgb[0]) / achromatic,
    (achromatic - rgb[1]) / achromatic,
    (achromatic - rgb[2]) / achromatic,
  )
  // Unreachable for any threshold at or below 1, which is every threshold the
  // application uses. Kept so that a threshold above 1 returns the colour
  // exactly rather than multiplying it by a scale of 1 and rounding.
  if (distance <= threshold) return rgb

  /*
   * `1 / distance`, and not the shoulder this used to use. The shoulder is
   * ill-conditioned once the trigger is a sign test, and that was measured
   * rather than reasoned about.
   *
   * With a knee at `k`, the operator steps by `(1 - k) / 2` the instant a
   * channel crosses zero, *however small the crossing is*. At k = 0.9 that is
   * 0.05 of the achromatic value — so a pixel 0.00006 outside the gamut with an
   * achromatic value of 2.75 moves by 104 code values. Half float and float64
   * do not agree on the sign of a channel within about 1e-3 of zero, so the two
   * implementations of this pipeline disagreed on 241 pixels of a real frame,
   * by up to 108 code values. Measured, in `tests/README.md`.
   *
   * `1 / distance` desaturates by exactly enough to reach the gamut boundary
   * and no further, which gives the property the shoulder lacked:
   *
   *     |change| <= |excursion|
   *
   * A colour a hair outside the gamut moves a hair. Disagreement about the sign
   * of a near-zero channel therefore costs a near-zero difference, and the
   * boundary stops being a cliff. It is also the *only* continuous choice here:
   * the step is `(1 - k) / 2`, which vanishes only at k = 1, and at k = 1 the
   * shoulder degenerates to the constant 1 — which is this.
   *
   * It moves colours less than the shoulder did, not more. The shoulder mapped
   * distances to strictly inside the boundary, overshooting; this lands on it.
   */
  const scale = 1 / distance
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
