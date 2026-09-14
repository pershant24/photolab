/**
 * Measuring the *shape* of a characteristic curve, as opposed to its strength.
 *
 * # Why this exists, and what it settles
 *
 * A stock named "reversal" and a stock shaped like reversal are different
 * claims, and the library shipped the first while nothing checked the second.
 * Contrast does not distinguish them: **a high-gamma negative looks contrasty
 * and still rolls off asymptotically over many stops, where reversal compresses
 * its highlights over roughly one stop and then terminates.** Slope at grey says
 * nothing about that, which is why raising contrast until a stock "looks punchy"
 * produces a punchy negative rather than a reversal stock.
 *
 * The discriminating property is the **extent of the shoulder**: how many stops
 * separate the end of the straight-line section from the point where the curve
 * has effectively stopped rising.
 *
 * # Everything here is in stops, because that is what the x axis is
 *
 * The curves live in ACEScct, whose log segment has a fixed scale, so one stop
 * is a constant `1 / 17.52` along x. A distance in x is therefore a number of
 * stops exactly rather than approximately, which is the whole reason the film
 * curves were put in this space.
 */

import { STOP_IN_ACESCCT } from './filmStock'
import { evaluateCurve } from './curve'

/**
 * Where the straight-line section is taken to end: the slope having fallen to
 * 95% of its value at middle grey.
 *
 * Measured against grey rather than against the curve's steepest point
 * anywhere, and that correction came from the measurement. Searching for a
 * global maximum found the **toe** on all three shipping stocks — they are
 * steepest in the deep shadows, by a few percent — so the reported "shoulder"
 * began five stops *under* grey and ran fifteen stops wide. The number was
 * arithmetically correct and meant nothing.
 *
 * Every stock here is anchored at middle grey by construction, so the slope
 * there is the straight-line gamma by definition, and the shoulder is whatever
 * happens above it.
 */
export const SHOULDER_ONSET = 0.95

/**
 * Where the curve is taken to have terminated: the slope having fallen to 5% of
 * its value at grey.
 *
 * # This, and not "reaches its maximum", is what separates the two families
 *
 * Reaching a maximum is not discriminating, because every curve reaches one at
 * the end of its domain. A straight line reaches its maximum at the top and
 * reports a shoulder of zero stops, which would classify it as the *most*
 * reversal-like curve in the library — a metric pointing exactly backwards.
 *
 * The physical property is that reversal film **saturates**: its slope goes to
 * nothing and the curve stops rising, over about a stop. A negative keeps
 * climbing for as long as you can expose it. So the measurement is of the slope,
 * and a curve whose slope never falls this far does not terminate within its
 * domain at all — reported as `Infinity` rather than as a large number, because
 * "does not terminate" is a different statement from "terminates late".
 */
export const TERMINATION_SLOPE = 0.05

/** Samples across the domain. Dense enough that the slope is smooth in stops. */
const SAMPLES = 2048

export interface CurveShape {
  /** Slope at middle grey: the straight-line gamma, and what reads as contrast. */
  readonly gammaAtGrey: number
  /** Slope at the top of the photographic range, relative to the gamma. */
  readonly terminalSlopeRatio: number
  /** Where the shoulder begins, in stops above grey. `Infinity` if it never does. */
  readonly shoulderStartStops: number
  /** Where the slope dies, in stops above grey. `Infinity` if it never does. */
  readonly terminatesStops: number
  /**
   * The figure that separates the families: stops spent in the shoulder. About
   * one for reversal; `Infinity` for a curve that never terminates, which is
   * every negative.
   */
  readonly shoulderStops: number
  /** Output at five stops under grey. Higher is a lifted, matte black. */
  readonly densityFloor: number
}

function stopsOf(x: number, grey: number): number {
  return (x - grey) / STOP_IN_ACESCCT
}

/**
 * Measure one channel.
 *
 * `xs`/`ys` are the split control points; `grey` is middle grey in the same
 * encoding, passed in rather than imported so a curve over some other log axis
 * can still be measured.
 */
export function measureCurveShape(
  xs: readonly number[],
  ys: readonly number[],
  grey: number,
): CurveShape {
  const x0 = xs[0]!
  const x1 = xs[xs.length - 1]!
  const step = (x1 - x0) / (SAMPLES - 1)

  const sampled: { x: number; y: number }[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const x = x0 + i * step
    sampled.push({ x, y: evaluateCurve(xs, ys, x) })
  }

  // Central differences, so the slope is not biased toward one end.
  const slope = (i: number): number => {
    const a = sampled[Math.max(0, i - 1)]!
    const b = sampled[Math.min(SAMPLES - 1, i + 1)]!
    return (b.y - a.y) / (b.x - a.x)
  }

  const greyIndex = Math.min(SAMPLES - 1, Math.max(0, Math.round((grey - x0) / step)))
  const gammaAtGrey = slope(greyIndex)

  // Upward from grey only. The shoulder is by definition what the highlights do.
  let shoulderStart = Infinity
  let terminates = Infinity
  for (let i = greyIndex; i < SAMPLES; i++) {
    const s = slope(i)
    if (shoulderStart === Infinity && s < SHOULDER_ONSET * gammaAtGrey) shoulderStart = i
    if (shoulderStart !== Infinity && s < TERMINATION_SLOPE * gammaAtGrey) {
      terminates = i
      break
    }
  }

  const asStops = (i: number): number =>
    i === Infinity ? Infinity : stopsOf(sampled[i]!.x, grey)

  const floorX = grey - 5 * STOP_IN_ACESCCT

  return {
    gammaAtGrey,
    // At the top of the PHOTOGRAPHIC range rather than the top of the domain:
    // the domain runs to ten stops over grey, which is four hundred times
    // display white and nowhere a photograph has pixels.
    terminalSlopeRatio: slope(
      Math.min(SAMPLES - 1, Math.round((grey + 4 * STOP_IN_ACESCCT - x0) / step)),
    ) / gammaAtGrey,
    shoulderStartStops: asStops(shoulderStart),
    terminatesStops: asStops(terminates),
    shoulderStops:
      shoulderStart === Infinity || terminates === Infinity
        ? Infinity
        : (sampled[terminates]!.x - sampled[shoulderStart]!.x) / STOP_IN_ACESCCT,
    densityFloor: evaluateCurve(xs, ys, floorX),
  }
}

export const REVERSAL_SHOULDER_STOPS = 2.5

/** Whether a measured curve is reversal-shaped rather than merely contrasty. */
export function isReversalShaped(shape: CurveShape): boolean {
  return shape.shoulderStops <= REVERSAL_SHOULDER_STOPS
}
