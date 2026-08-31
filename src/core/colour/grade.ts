/**
 * Exposure and contrast: the two scalar operators of pass 1 and pass 4.
 *
 * Both are per-channel scalar functions with `Vec3` wrappers, and both
 * transliterate into GLSL directly.
 */

import type { Vec3 } from './types'
import { decodeACEScct, encodeACEScct } from './transfer'

/**
 * Exposure is a **multiplication in linear light** and nothing else.
 *
 * That is not a simplification, it is the definition: opening the aperture a
 * stop doubles the number of photons reaching every part of the frame. Anything
 * that changes the *shape* of the response rather than scaling it — a curve, a
 * gamma, an S-shape — is the film stage's job or the grade's, not exposure's.
 * This is also why exposure is applied before the lens stage: a vignette
 * darkens an already-exposed frame, so exposure applied afterwards would scale
 * the vignette with it, which no aperture does.
 */
export function applyExposure(linear: number, stops: number): number {
  return linear * Math.pow(2, stops)
}

export function applyExposureRgb(rgb: Vec3, stops: number): Vec3 {
  const gain = Math.pow(2, stops)
  return [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain]
}

/** Middle grey in linear ACES: the exposure a reflectance of 18% produces. */
export const MIDDLE_GREY_LINEAR = 0.18

/**
 * The contrast pivot, in ACEScct.
 *
 * Computed by putting middle grey through the encode function, never written
 * out as a literal. The trap this closes is pivoting at the *number* 0.18 in
 * encoded space: 0.18 linear encodes to roughly 0.4136, so a pivot of 0.18 in
 * ACEScct is about two and a half stops below middle grey, and contrast applied
 * around it lifts the whole image as it steepens. That reads as a broken
 * contrast control rather than an obviously wrong pivot, so it is exported as a
 * named constant with a test asserting the relationship.
 */
export const CONTRAST_PIVOT_ACESCCT = encodeACEScct(MIDDLE_GREY_LINEAR)

/**
 * Contrast: a slope change about middle grey, applied in ACEScct.
 *
 * `slope` is a multiplier on the distance from the pivot, so 1 is identity,
 * above 1 steepens, and 0 flattens the image to middle grey. Values below 0
 * invert it, which is allowed rather than clamped — nothing here needs to
 * decide what the UI should offer.
 *
 * ## Why ACEScct and not linear or sRGB
 *
 * In linear light a slope change is a multiply, which is exposure, not
 * contrast. In sRGB it would work but the pipeline is not in sRGB at this point
 * and round-tripping through a display encoding mid-chain would clip everything
 * above display white. ACEScct is log-spaced, so equal distances are equal
 * stops and the operator behaves the same everywhere in the tonal range, and it
 * has a linear toe so shadow values at or below zero survive it.
 *
 * ## This is applied per channel, and that increases saturation
 *
 * Deliberate, recorded here so it is not rediscovered as a bug once sliders
 * exist. Steepening each channel independently pushes each channel further from
 * the pivot, and a colour whose channels were already unequal becomes more
 * unequal — which is a saturation increase. Photographic contrast behaves this
 * way: a higher-contrast film stock is also a more saturated one, because the
 * three emulsion layers each have their own steeper characteristic curve.
 *
 * The alternative, if this proves wrong in use, is a luminance-preserving
 * variant: derive a luminance, apply the slope to that alone, and scale the
 * chroma back. It is a different look, not a bug fix, and it would be an
 * additional mode rather than a replacement.
 */
export function applyContrast(linear: number, slope: number): number {
  const encoded = encodeACEScct(linear)
  return decodeACEScct(CONTRAST_PIVOT_ACESCCT + (encoded - CONTRAST_PIVOT_ACESCCT) * slope)
}

export function applyContrastRgb(rgb: Vec3, slope: number): Vec3 {
  return [
    applyContrast(rgb[0], slope),
    applyContrast(rgb[1], slope),
    applyContrast(rgb[2], slope),
  ]
}
