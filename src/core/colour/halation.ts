/**
 * Halation parameters, and the units they are expressed in.
 *
 * The threshold is in **stops from middle grey**, not in linear working-space
 * values, and that is the occupancy rule applied to a parameter rather than to a
 * fixture. A threshold of "0.51 linear" has to be checked against a histogram
 * before it means anything; "one and a half stops above grey" is a place in a
 * photograph. Expressed in linear units, a range would look plausible while
 * sitting almost entirely outside where the data lives — which is exactly how
 * the film curves came to span eight stops that contain no pixels.
 *
 * For reference, on a display-referred image: middle grey is 0 stops, display
 * white is +2.47, and nothing exceeds that until exposure or contrast pushes it.
 * So a threshold above about +2.5 catches only what the pipeline itself created.
 */

import { MIDDLE_GREY_LINEAR } from './grade'

/**
 * Display white, in stops above middle grey.
 *
 * **The hard ceiling of the threshold's useful range.** A display-referred image
 * has no linear value above 1.0 — that is what display-referred means — so at
 * default exposure nothing in any photograph sits above this, and a threshold
 * set above it produces exactly nothing. Only exposure lifts the ceiling.
 */
export const DISPLAY_WHITE_STOPS_ABOVE_GREY = Math.log2(1 / MIDDLE_GREY_LINEAR)

/**
 * Luminance weights for AP1 primaries.
 *
 * Duplicated as a literal in `halationThreshold.frag`, where it has to be. The
 * threshold discriminates on brightness rather than on any single channel, so a
 * saturated red does not halate as though it were as bright as white.
 */
export const AP1_LUMINANCE_WEIGHTS: readonly [number, number, number] = [0.2722, 0.6741, 0.0537]

/** The brightness the threshold is compared against, in ACEScg. */
export function halationLuminance(rgb: readonly [number, number, number]): number {
  const [wr, wg, wb] = AP1_LUMINANCE_WEIGHTS
  return rgb[0] * wr + rgb[1] * wg + rgb[2] * wb
}

/**
 * The width of the threshold's soft shoulder, as a multiplier on the threshold.
 *
 * Half a stop. It matters for occupancy that this is a window and not a step:
 * the population that contributes is `[t, t*sqrt(2)]`, weighted by the
 * smoothstep, so asking whether pixels exist *at* `t` understates what the
 * effect actually acts on.
 */
export const HALATION_SHOULDER = Math.SQRT2

/** The smoothstep the threshold shader applies. Kept here so tests can weigh by it. */
export function halationExcess(luminance: number, thresholdLinear: number): number {
  const upper = thresholdLinear * HALATION_SHOULDER
  const t = Math.min(1, Math.max(0, (luminance - thresholdLinear) / (upper - thresholdLinear)))
  return t * t * (3 - 2 * t)
}

/** Linear working-space value a threshold in stops corresponds to. */
export function halationThresholdLinear(stopsAboveGrey: number): number {
  return MIDDLE_GREY_LINEAR * 2 ** stopsAboveGrey
}

/**
 * The tint scattered light picks up.
 *
 * Weighted toward red because the red-sensitive layer sits closest to the film
 * base the light reflects off, so it receives the most of what comes back. Not
 * pure red: the other layers receive some, and a pure-red halo reads as a
 * coloured overlay rather than as light.
 */
export const HALATION_TINT: readonly [number, number, number] = [1, 0.32, 0.16]

/**
 * The radius at which the effect stops resembling film.
 *
 * Recorded rather than enforced. Halation is scattering within a few tens of
 * microns of emulsion, which on a 35mm frame is a small fraction of a per cent
 * of the long edge. Past roughly 1.5% it stops reading as light bleeding within
 * the image and starts reading as a bloom filter over the top of it — see the
 * observations in `tests/README.md`.
 */
export const HALATION_FILMLIKE_MAX_RADIUS = 0.015
