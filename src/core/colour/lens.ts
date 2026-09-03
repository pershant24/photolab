/**
 * The lens stage: distortion, chromatic aberration, diffusion, vignette.
 *
 * Between the scene and the film. The lens forms the image the emulsion records,
 * so everything here acts on light that has left the scene and has not yet been
 * developed — which is why the vignette's darkening passes through the
 * characteristic curves rather than being applied to a finished picture.
 *
 * # Everything here is measured from the centre of the FULL FRAME
 *
 * This is the distinction the vignette worked example in `docs/ARCHITECTURE.md`
 * was written to make, and the lens stage is where it stops being hypothetical.
 * A pass that reads only its own buffer gives every export tile its own lens: its
 * own centre, its own corners, its own vignette. The frame position has to come
 * through `uSourceRect.xy` — the tile's origin — and not merely from its scale.
 *
 * Two of these four also *move* pixels, which is new. A geometric pass reads from
 * a position that may lie outside its own tile, and the offset varies with radius
 * rather than being constant, so the overlap each declares is a function of its
 * parameter and of the frame diagonal.
 */

/**
 * Radius normalised so that 1.0 is the corner of the frame, whatever its shape.
 *
 * Aspect is corrected before the length is taken, so a circle stays a circle on a
 * frame that is not square. Dividing by the corner's own length is what puts the
 * corner at exactly 1: without it the normaliser would be the half-width and a
 * portrait frame would have a different lens from a landscape one.
 */
export function frameRadius(
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const longEdge = Math.max(width, height)
  const ax = width / longEdge
  const ay = height / longEdge
  // Centred, in -1..1 before aspect correction.
  const cx = (x / width) * 2 - 1
  const cy = (y / height) * 2 - 1
  return Math.hypot(cx * ax, cy * ay) / Math.hypot(ax, ay)
}

/** Half the frame diagonal, in source pixels. The unit radius 1.0 corresponds to. */
export function halfDiagonal(width: number, height: number): number {
  return Math.hypot(width, height) / 2
}

/**
 * The radial scale a distorted output samples its source at.
 *
 * `out = r * (1 + k r^2)`. A single quadratic term rather than the usual pair:
 * the second term only matters when correcting a real lens against a measured
 * profile, and this is a creative control where it would be two sliders doing
 * nearly the same thing.
 *
 * **Positive is pincushion and negative is barrel**, which is worth stating
 * because the sign convention is not self-evident from the formula. An output
 * pixel at radius `r` reads from `r(1 + k r^2)`, so with `k > 0` it reads from
 * further out: content from the edge of the frame is pulled inward, straight
 * lines bow toward the centre, and that is pincushion.
 */
export function distortionScale(radius: number, k: number): number {
  return 1 + k * radius * radius
}

/**
 * Overlap a distorted tile needs, in source pixels.
 *
 * The displacement is `|k| r^3` in normalised radius, largest at the corner where
 * `r = 1`, so the bound is `|k|` times the half-diagonal. Conservative for tiles
 * that do not contain a corner, which is the right direction to be wrong in — an
 * under-declared overlap is a seam and an over-declared one is wasted work.
 */
export function distortionOverlap(k: number, width: number, height: number): number {
  return Math.ceil(Math.abs(k) * halfDiagonal(width, height)) + 1
}

/**
 * Per-channel radial scale for lateral chromatic aberration.
 *
 * Red is pulled in and blue pushed out, or the reverse for negative amounts,
 * with green fixed. Green is the reference because it carries most of the
 * luminance, so a CA setting does not shift the picture's apparent geometry.
 *
 * Lateral only. Longitudinal aberration is a focus effect — different wavelengths
 * focusing at different distances — which would need a per-channel blur that
 * varies with depth, and there is no depth here.
 */
export function aberrationScale(channel: 0 | 1 | 2, amount: number): number {
  const direction = channel === 0 ? -1 : channel === 2 ? 1 : 0
  return 1 + amount * direction
}

/** Overlap lateral CA needs. The displacement is `|amount| r`, largest at the corner. */
export function aberrationOverlap(amount: number, width: number, height: number): number {
  return Math.ceil(Math.abs(amount) * halfDiagonal(width, height)) + 1
}

/**
 * The `cos^4` falloff, which is the physical shape rather than a radial gradient.
 *
 * Off-axis illumination falls as the fourth power of the cosine of the angle from
 * the optical axis: one factor from the inverse-square distance to the corner of
 * the frame, one from the tilt of the film plane, and two from the foreshortening
 * of the aperture as seen off-axis. A radial gradient multiply has none of that
 * and reads as a darkened overlay, which is exactly the thing this is not.
 *
 * `reach` is the tangent of the half-angle at the corner — a wide lens has a
 * larger one and vignettes harder, which is the physical reason wide lenses do.
 */
export function vignetteFalloff(radius: number, reach: number): number {
  const c = Math.cos(Math.atan(radius * reach))
  return c * c * c * c
}

/**
 * The multiplier a vignette applies.
 *
 * At `amount = 0` this is exactly 1: `mix(1, f, 0)` is `1*(1-0) + f*0`, which is
 * 1 bit-for-bit, so an unedited photograph is untouched.
 */
export function vignetteMultiplier(radius: number, amount: number, reach: number): number {
  return 1 * (1 - amount) + vignetteFalloff(radius, reach) * amount
}

/** Ranges, in the units each parameter is expressed in. */
export const DISTORTION_RANGE = 0.3
export const ABERRATION_RANGE = 0.01
export const DIFFUSION_MAX_RADIUS = 0.05
/** Past roughly this, diffusion stops reading as a lens and starts reading as fog. */
export const DIFFUSION_LENSLIKE_MAX_RADIUS = 0.02
export const VIGNETTE_REACH = 1.1
