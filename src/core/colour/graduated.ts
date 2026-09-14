/**
 * The graduated filter: a linear gradient carrying an exposure and a colour
 * shift across the frame.
 *
 * # What it is, and the one thing it deliberately is not
 *
 * A photographer's graduated neutral density filter is a piece of glass in front
 * of the lens, so the physical ordering this project is built on would put it in
 * the **lens** stage, where its darkening would pass through the characteristic
 * curves exactly as the vignette's does — and a grad would then look different
 * under different stocks, which is the property the vignette is measured for.
 *
 * This one is in the **grade** stage instead, and that is a choice rather than
 * an oversight. It is the digital tool: the local exposure decision a colourist
 * makes on a developed image, the darkroom's burn-in of a sky. The consequence
 * is worth stating plainly because it is the opposite of the vignette's: **this
 * does not pass through the film curves, so it does not vary by stock.**
 *
 * If the glass-filter behaviour is ever wanted, it is a different pass in the
 * lens stage rather than a parameter on this one. The two are not the same
 * effect with a switch.
 *
 * # Exposure is a linear multiply, which is only obvious once you look
 *
 * The grade stage's passes are written as though they work in ACEScct, and they
 * do — but each one encodes, operates and decodes internally. **The buffer
 * between them is linear ACEScg.** So a shift of `s` stops here is `* 2^s`, not
 * an offset, and it is exact at every value including the ones ACEScct's linear
 * toe treats specially.
 *
 * The alternative — adding `s / 17.52` in ACEScct — is a stop shift only above
 * the log/linear break at 0.0078125, which is 4.5 stops under middle grey. It
 * would be wrong in exactly the deep shadows a grad is often used to open up,
 * and it would be wrong quietly.
 *
 * The colour shift is a multiply for a different reason: a coloured grad is
 * absorptive glass, and glass cannot add light.
 *
 * # The frame's extent along the gradient, and why it is not the diagonal
 *
 * The mask runs 0 to 1 across the frame *in the gradient's own direction*, so
 * `position` means the same thing at every angle. That needs the rectangle's
 * extent along the normal — its support function, `|n.x| * w + |n.y| * h` — and
 * not the diagonal, which is the extent along one particular direction only.
 *
 * Using the diagonal would make a horizontal grad on a 3:2 frame reach its
 * endpoint at 0.83 rather than 1, so `position: 1` would leave a band of the
 * frame untouched and the parameter would mean something different at every
 * angle.
 */

/** Aspect-corrected axes, matching `frameAspect` in `lib/lens.glsl`. */
export function graduatedAspect(imageSize: readonly [number, number]): [number, number] {
  const longest = Math.max(imageSize[0], imageSize[1])
  return [imageSize[0] / longest, imageSize[1] / longest]
}

/**
 * The gradient's direction, as a unit vector in frame coordinates.
 *
 * Zero degrees points at the **top** of the frame, and the angle runs clockwise.
 * That default is not arbitrary: an unrotated graduated filter darkens the sky,
 * which is what the overwhelming majority of them are bought for, so angle 0 and
 * a negative exposure is the thing someone reaches for first.
 *
 * Frame y runs downward — `framePosition` puts y = 0 at the top of the image —
 * so "up" is negative y, which is where the sign comes from.
 */
export function graduatedDirection(angleDegrees: number): [number, number] {
  const radians = (angleDegrees * Math.PI) / 180
  return [Math.sin(radians), -Math.cos(radians)]
}

/**
 * Half the frame's extent along `direction`, in aspect-corrected units.
 *
 * The support function of a rectangle centred at the origin. It is what makes
 * `position` mean the same fraction of the frame at every angle.
 */
export function graduatedHalfExtent(
  aspect: readonly [number, number],
  direction: readonly [number, number],
): number {
  return 0.5 * (aspect[0] * Math.abs(direction[0]) + aspect[1] * Math.abs(direction[1]))
}

/**
 * The narrowest transition the parameter allows, as a fraction of the frame.
 *
 * Not zero, and the reason is mechanical rather than aesthetic: `smoothstep`
 * with equal edges is undefined in GLSL, so a width of zero is not a hard edge,
 * it is whatever the driver does. One percent of the frame is 20 pixels on a
 * 2000-pixel edge, which reads as a hard grad and still antialiases.
 */
export const GRADUATED_MIN_WIDTH = 0.01

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Where a frame position sits along the gradient, 0 to 1.
 *
 * Separate from the mask because it is the part with the geometry in it, and it
 * is what the agreement test compares against the shader.
 */
export function graduatedCoordinate(
  framePos: readonly [number, number],
  aspect: readonly [number, number],
  angleDegrees: number,
): number {
  const direction = graduatedDirection(angleDegrees)
  const half = graduatedHalfExtent(aspect, direction)
  const x = framePos[0] * aspect[0] - 0.5 * aspect[0]
  const y = framePos[1] * aspect[1] - 0.5 * aspect[1]
  const along = x * direction[0] + y * direction[1]
  return 0.5 + along / (2 * half)
}

/**
 * How strongly the filter acts at a frame position. 0 is untouched.
 *
 * The mask reaches exactly 0 and exactly 1 outside the transition band rather
 * than approaching them, which is what lets the pass be a bit-exact identity
 * over most of the frame at any setting.
 */
export function graduatedMask(
  framePos: readonly [number, number],
  aspect: readonly [number, number],
  angleDegrees: number,
  position: number,
  width: number,
): number {
  const u = graduatedCoordinate(framePos, aspect, angleDegrees)
  const half = Math.max(width, GRADUATED_MIN_WIDTH) / 2
  return smoothstep(position - half, position + half, u)
}

/** What the filter does to one linear colour at a given mask value. */
export function applyGraduated(
  rgb: readonly [number, number, number],
  mask: number,
  stops: number,
  tint: readonly [number, number, number],
): [number, number, number] {
  // `2^0` is exactly 1 and `mix(1, t, 0)` is exactly 1, so a pixel the mask does
  // not reach is returned bit for bit. The vignette makes the same guarantee by
  // the same construction, and for the same reason: an unedited photograph must
  // be untouched rather than nearly untouched.
  const gain = Math.pow(2, stops * mask)
  return [
    rgb[0] * gain * (1 + (tint[0] - 1) * mask),
    rgb[1] * gain * (1 + (tint[1] - 1) * mask),
    rgb[2] * gain * (1 + (tint[2] - 1) * mask),
  ]
}
