/**
 * CIELAB, for judging colour differences the way a person would rather than the
 * way a channel ratio does.
 *
 * This exists because an RGB-derived hue angle is the wrong instrument for
 * measuring what gamut compression does. Any hue metric built from RGB channel
 * ratios is a linear projection that annihilates the achromatic axis, so an
 * operator which scales the chroma vector about that axis preserves it
 * *identically* — the metric and the algorithm agree by construction, and the
 * measurement carries no information. `display.ts` records where that went
 * wrong.
 *
 * CIELAB hue is not preserved by such a scale, so it can disagree, which is what
 * makes it worth measuring. It also matters for the thing itself: RGB-ratio hue
 * and perceptual hue diverge most in saturated blues, which is exactly the
 * "blue goes purple" failure that shows up in tone mapping, and exactly where the
 * compressor will work hardest once white balance and film curves land.
 */

import type { Vec3 } from './types'
import { D65_WHITE_XYZ, SRGB_TO_XYZ_D65 } from './primaries'
import { mat3MulVec3 } from './types'

/** CIE standard: (6/29)^3, the point where the cube root gives way to a line. */
const EPSILON = 216 / 24389
/** CIE standard: (29/3)^3. */
const KAPPA = 24389 / 27

/**
 * The CIELAB nonlinearity, extended to negative input by odd symmetry.
 *
 * Out-of-gamut colours routinely produce a negative Z — a linear sRGB triple
 * with a negative channel can, and the colours this module exists to measure all
 * do. The standard is undefined there. Mirroring through the origin keeps the
 * function monotone and finite, which is what a *comparison* needs; it is not a
 * claim that CIELAB means anything outside its domain, and nothing but the tests
 * relies on it.
 */
function labF(t: number): number {
  const magnitude = Math.abs(t)
  const value =
    magnitude > EPSILON ? Math.cbrt(magnitude) : (KAPPA * magnitude + 16) / 116
  return t < 0 ? -value : value
}

/** XYZ to CIELAB, relative to the D65 white the display primaries are defined against. */
export function xyzToLab(xyz: Vec3): Vec3 {
  const fx = labF(xyz[0] / D65_WHITE_XYZ[0])
  const fy = labF(xyz[1] / D65_WHITE_XYZ[1])
  const fz = labF(xyz[2] / D65_WHITE_XYZ[2])
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function linearSrgbToLab(linearSrgb: Vec3): Vec3 {
  return xyzToLab(mat3MulVec3(SRGB_TO_XYZ_D65, linearSrgb))
}

/** CIELAB hue angle in degrees, `atan2(b*, a*)`, wrapped to [0, 360). */
export function labHueAngle(lab: Vec3): number {
  const degrees = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI
  return degrees < 0 ? degrees + 360 : degrees
}

/** CIELAB chroma, the distance from the neutral axis. */
export function labChroma(lab: Vec3): number {
  return Math.hypot(lab[1], lab[2])
}

/** The shorter way round between two hue angles in degrees. */
export function hueDifference(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}
