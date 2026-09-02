/**
 * Lift, gamma and gain: three per-channel offsets, each owning a tonal zone.
 *
 * # The domain is ACEScct, not linear
 *
 * The same domain as contrast and the tone curve, which are the passes either
 * side of this one in the grade stage. `CLAUDE.md` and the brief both say the
 * same thing here: consistency with the neighbouring grade passes is worth more
 * than matching any particular reference implementation, and a colourist moving
 * between a contrast slider and a lift wheel should not be crossing a domain
 * boundary they were never told about.
 *
 * Linear would also be wrong for a different reason. A lift in linear light is
 * an addition of light, which is not what lifting shadows means to anyone — it
 * fogs the whole frame, because a constant added to a small value is a large
 * relative change and to a large value is nothing.
 *
 * # This is not ASC CDL, deliberately
 *
 * CDL is `out = (in * slope + offset)^power`, where the offset raises the black
 * point across the entire range and the slope multiplies across the entire
 * range. Every term acts everywhere and the zones overlap completely.
 *
 * Here each wheel owns a zone through a weight, and the three weights form a
 * **partition of unity**: they sum to exactly one at every value. That is not
 * for the tidiness of it. It makes each wheel's region of influence a
 * well-defined weight function, which is exactly what an occupancy assertion
 * needs something to integrate against — "does lift act where the data is" is
 * not answerable about a CDL offset, because a CDL offset acts everywhere and
 * the question has no numerical form.
 *
 * A reader who knows CDL will notice the difference. It is a decision, recorded
 * here, not a defect.
 */

import { DISPLAY_WHITE_STOPS_ABOVE_GREY } from './halation'
import { MIDDLE_GREY_ACESCCT, STOP_IN_ACESCCT } from './filmStock'

/**
 * The two smoothstep edges that define all three zones.
 *
 * **Chosen by measurement, not by symmetry.** The obvious choice — lift spanning
 * the four stops below grey, gain the range from grey to display white — was
 * tried first and rejected. Integrated against the two real photographs in
 * `tests/fixtures/luminance-histograms.ts`, it gives the gain wheel 7.8% of the
 * night frame: a control that does almost nothing on a whole class of picture.
 *
 * Share of each photograph each wheel acts on, as measured:
 *
 *   edges                          night L/M/G     talk L/M/G   worst
 *   a(-4, 0)    b(0, 2.47)          42/51/ 8       12/48/40      7.8%
 *   a(-2.5, 1)  b(1, 2.47)          55/43/ 2       21/60/19      1.6%
 *   a(-3, 1.5)  b(-0.5, 2.47)       57/31/13       22/31/48     12.6%
 *
 * The last is what ships. Gamma holds near a third of both frames while lift and
 * gain swap dominance with the key of the picture — which is the behaviour a
 * colourist expects, and the asymmetry is correct rather than residual: the
 * shadows of a night scene *are* most of it, and its highlights are not.
 *
 * The zones overlap, which is why `A_HIGH` exceeds `B_LOW`. A hard handover at a
 * single value would put a visible edge across the picture wherever that value
 * happened to fall.
 */
export const ZONE_A_LOW = -3
export const ZONE_A_HIGH = 1.5
export const ZONE_B_LOW = -0.5
export const ZONE_B_HIGH = DISPLAY_WHITE_STOPS_ABOVE_GREY

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export interface ZoneWeights {
  readonly lift: number
  readonly gamma: number
  readonly gain: number
}

/**
 * How much each wheel owns at a position given in stops from middle grey.
 *
 * Sums to exactly one everywhere, and every term is non-negative: `a >= b` for
 * all inputs because both edges of `a` sit at or below the matching edge of `b`,
 * which is the condition the constants above are chosen to satisfy.
 */
export function zoneWeights(stopsFromGrey: number): ZoneWeights {
  const a = smoothstep(ZONE_A_LOW, ZONE_A_HIGH, stopsFromGrey)
  const b = smoothstep(ZONE_B_LOW, ZONE_B_HIGH, stopsFromGrey)
  return { lift: 1 - a, gamma: a - b, gain: b }
}

/** The same, for a value already encoded as ACEScct. */
export function zoneWeightsFromEncoded(encoded: number): ZoneWeights {
  return zoneWeights((encoded - MIDDLE_GREY_ACESCCT) / STOP_IN_ACESCCT)
}

/**
 * The largest offset one wheel applies, in ACEScct, at full deflection.
 *
 * 0.06 is a little over one stop. Wheels are a trim control rather than a
 * primary one — exposure and the curve are for moving the picture — and a range
 * that can move a zone by more than a stop is already past where the result
 * stops looking like a photograph.
 */
export const WHEEL_RANGE = 0.06

/**
 * Apply the three wheels to one channel, in ACEScct.
 *
 * The offsets are in the same units as the value, so the result is a sum rather
 * than anything requiring a pivot. Values are not clamped here: the display
 * transform is what decides how out-of-range values are shown, and clamping
 * mid-chain would discard highlight detail the tone map is there to recover.
 */
export function applyWheelsEncoded(
  encoded: number,
  lift: number,
  gamma: number,
  gain: number,
): number {
  const w = zoneWeightsFromEncoded(encoded)
  return encoded + lift * w.lift + gamma * w.gamma + gain * w.gain
}

/** The identity for one wheel: no offset on any channel. */
export const WHEEL_IDENTITY: readonly number[] = [0, 0, 0]

export function isWheelIdentity(wheel: readonly number[]): boolean {
  return wheel.length === 3 && wheel.every((v) => v === 0)
}
