/**
 * Split toning: one tint for the shadows, one for the highlights, and a movable
 * handover between them.
 *
 * # The balance is in stops from middle grey
 *
 * This is the third parameter in the project to face that choice, and the first
 * two got it wrong the same way. A balance expressed as a position in the
 * encoded domain looks reasonable in the source and puts most of its travel
 * where no photograph has pixels — the film curve control points spread over a
 * domain whose top half decodes above eight stops over display white, and the
 * halation threshold ran to `+4` when nothing in a display-referred image
 * exceeds `+2.474`.
 *
 * In stops it is directly assertable against a real histogram, which is what
 * `tests/unit/split-tone.test.ts` does.
 *
 * # The tints are ACEScct offsets, like the wheels
 *
 * Same domain as the wheels, the contrast pass and the tone curve, for the same
 * reason: the grade stage should not contain a domain boundary a colourist has
 * to know about. A split tone is then the same operation as a two-zone wheel
 * pair whose handover the user can move, and the two controls compose predictably
 * because they are adding in the same units.
 */

import { DISPLAY_WHITE_STOPS_ABOVE_GREY } from './halation'
import { MIDDLE_GREY_ACESCCT, STOP_IN_ACESCCT } from './filmStock'

/**
 * How far the balance can travel, in stops from middle grey.
 *
 * Bounded by where photographs have pixels rather than by a round number. The
 * range spans from well down in the shadows to display white, and stops there:
 * a balance above display white would put every pixel on the shadow side and the
 * highlight tint would do nothing at all.
 */
export const SPLIT_BALANCE_MIN = -4
export const SPLIT_BALANCE_MAX = DISPLAY_WHITE_STOPS_ABOVE_GREY

/**
 * The width of the handover, in stops.
 *
 * Two stops, which is wide. A narrow handover puts a visible line across the
 * picture wherever the balance falls — the same failure the wheel zones overlap
 * to avoid — and split toning is a mood control rather than a mask.
 */
export const SPLIT_TRANSITION_STOPS = 2

/** The largest offset a tint applies, in ACEScct. */
export const SPLIT_TINT_RANGE = 0.05

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * How much of the highlight tint applies at a position, in stops from grey.
 *
 * The shadow share is one minus this, so the two form a partition of unity and
 * setting both tints to the same value is a uniform offset rather than a doubled
 * one.
 */
export function highlightShare(stopsFromGrey: number, balance: number): number {
  const half = SPLIT_TRANSITION_STOPS / 2
  return smoothstep(balance - half, balance + half, stopsFromGrey)
}

/** The same, for a value already encoded as ACEScct. */
export function highlightShareFromEncoded(encoded: number, balance: number): number {
  return highlightShare((encoded - MIDDLE_GREY_ACESCCT) / STOP_IN_ACESCCT, balance)
}

/** Apply both tints to one channel, in ACEScct. */
export function applySplitToneEncoded(
  encoded: number,
  shadowTint: number,
  highlightTint: number,
  balance: number,
): number {
  const share = highlightShareFromEncoded(encoded, balance)
  return encoded + shadowTint * (1 - share) + highlightTint * share
}

export function isSplitToneIdentity(shadow: readonly number[], highlight: readonly number[]): boolean {
  return shadow.every((v) => v === 0) && highlight.every((v) => v === 0)
}
