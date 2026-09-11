/**
 * Light leaks: stray light reaching the emulsion without passing through the
 * lens.
 *
 * A failed door seal, a cracked body, a back opened a moment early. The light
 * that gets in has not been focused by anything, so it arrives as a broad
 * gradient rather than as an image, and it enters at the frame's edge because
 * that is where the seams are.
 *
 * # It is exposure, not a colour overlay
 *
 * This is the whole reason the pass sits before the film stage rather than at
 * the end. The leak adds *light to the emulsion*, so the characteristic curves
 * develop it exactly as they develop everything else: it compresses into the
 * shoulder where the frame was already bright, and it lifts the toe where the
 * frame was dark. A leak composited after the curves would sit at a constant
 * density across the frame, which is what makes a fogged frame and a coloured
 * gradient look different from each other.
 *
 * Halation acts on it too, and for the same reason — bright stray light
 * reflects off the film base like any other bright light.
 *
 * # The tint
 *
 * Warm, and more strongly so than halation. Light entering a camera body
 * through a seam has usually passed the edge of the film itself or a red-brown
 * light trap, and what survives is the long end of the spectrum. The exact
 * triple is a choice rather than a measurement, and is stated as such.
 */

/** Relative exposure the leak adds, per channel, at full strength. */
export const LIGHT_LEAK_TINT: readonly [number, number, number] = [1, 0.42, 0.22]

/**
 * How far the leak reaches in from the edge, as a fraction of the frame.
 *
 * Not a parameter. A leak's reach is set by the geometry of the gap it came
 * through, and exposing that as a control would give two sliders that mostly
 * cancel — a wider, weaker leak looks much like a narrower, stronger one.
 */
export const LIGHT_LEAK_REACH = 0.38

/**
 * The leak's profile at a distance from its entry edge, in [0, 1].
 *
 * `exp(-3x)` rather than a linear ramp or a smoothstep. Light spreading into a
 * dark chamber from a slot falls off roughly exponentially, and the difference
 * from a linear ramp is visible: a linear leak has a hard-looking end where the
 * gradient stops, and this one does not end anywhere in particular.
 */
export function lightLeakFalloff(distanceFromEdge: number): number {
  const t = Math.max(0, distanceFromEdge) / LIGHT_LEAK_REACH
  return Math.exp(-3 * t)
}

/**
 * Where along the perimeter the leak enters, as a point on the frame edge.
 *
 * `position` runs 0 to 1 once around the frame, starting at the left edge and
 * going clockwise. One parameter rather than two, because a leak enters at one
 * place and the interesting variation is *which* place — an x and a y would let
 * a caller put it in the middle of the frame, where a leak cannot be.
 */
export function lightLeakEntry(position: number): readonly [number, number] {
  const p = ((position % 1) + 1) % 1
  const side = Math.floor(p * 4)
  const along = p * 4 - side
  if (side === 0) return [0, along]
  if (side === 1) return [along, 1]
  if (side === 2) return [1, 1 - along]
  return [1 - along, 0]
}
