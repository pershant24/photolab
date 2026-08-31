/**
 * RGB colour space primaries, and the derivation of an RGB -> XYZ matrix from
 * them.
 *
 * The matrices are **derived from chromaticities**, not pasted in from a
 * reference. A pasted matrix is nine opaque numbers that no test can check
 * against anything except another pasted matrix; a derived one can be checked
 * against properties that must hold by construction — notably that white maps
 * to white, which is what `tests/unit/matrices.test.ts` asserts via row sums.
 *
 * Published matrices remain useful as a cross-check, but they disagree with each
 * other in the fourth decimal depending on how many digits of the chromaticities
 * the author carried and which chromatic adaptation they used, so they are the
 * weaker of the two checks.
 */

import type { Mat3, Vec3 } from './types'
import { mat3FromDiagonal, mat3Inverse, mat3Mul, mat3MulVec3 } from './types'

/**
 * The CIE xyY -> XYZ conversion at unit luminance (Y = 1).
 *
 * Undefined at y = 0, which no real chromaticity has; the guard turns a silent
 * Infinity into a diagnosable error, since an Infinity here would propagate
 * through the whole matrix derivation as NaN and surface far from its cause.
 */
export function xyToXYZ(x: number, y: number): Vec3 {
  if (y === 0) {
    throw new RangeError(`xyToXYZ: y must be non-zero (got x=${x}, y=${y})`)
  }
  return [x / y, 1, (1 - x - y) / y]
}

/**
 * Build the RGB -> XYZ matrix for a set of primaries and a white point, all
 * given as CIE 1931 xy chromaticities.
 *
 * The derivation is the standard one. Each primary's chromaticity fixes the
 * *direction* of its XYZ vector but not its length; the white point fixes the
 * lengths, because R = G = B = 1 must produce exactly the white point's XYZ.
 * So: assemble the three primary directions as columns, solve for the scale
 * vector that maps (1,1,1) onto the white point, and scale the columns by it.
 *
 * Arguments are plain numbers rather than a primaries object so the signature
 * stays transliterable. This runs once at module load, never per pixel.
 */
export function rgbToXyzMatrix(
  rx: number,
  ry: number,
  gx: number,
  gy: number,
  bx: number,
  by: number,
  wx: number,
  wy: number,
): Mat3 {
  const r = xyToXYZ(rx, ry)
  const g = xyToXYZ(gx, gy)
  const b = xyToXYZ(bx, by)

  // Primary directions as columns: column 0 is red, column 1 green, column 2
  // blue. Row-major storage, so the columns interleave.
  const directions: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]]

  const white = xyToXYZ(wx, wy)
  const scale = mat3MulVec3(mat3Inverse(directions), white)

  return mat3Mul(directions, mat3FromDiagonal(scale))
}

/**
 * sRGB / Rec.709 primaries and the D65 white point, from IEC 61966-2-1 and
 * ITU-R BT.709-6. sRGB and Rec.709 share primaries and white point; they differ
 * only in transfer function.
 *
 * D65 is carried at four digits (0.3127, 0.3290) because that is the value the
 * sRGB and Rec.709 specifications themselves state, and the white point is then
 * derived from it. The alternative convention — the ASTM tabulated D65 white
 * (0.95047, 1, 1.08883) — is not interchangeable with this one: the two differ
 * in the fourth decimal of Z and produce sRGB matrices that disagree by 6.6e-5,
 * which is why two widely copied published sRGB matrices disagree. Deriving
 * everything from the stated chromaticities keeps this module internally
 * consistent and matches the references in `tests/unit/`, which explain the
 * divergence at length.
 */
export const SRGB_RED_X = 0.64
export const SRGB_RED_Y = 0.33
export const SRGB_GREEN_X = 0.3
export const SRGB_GREEN_Y = 0.6
export const SRGB_BLUE_X = 0.15
export const SRGB_BLUE_Y = 0.06
export const D65_X = 0.3127
export const D65_Y = 0.329

/**
 * ACES AP1 primaries and the ACES white point ("D60"), from the ACES
 * specifications. Quoted at docs.acescentral.com/encodings/acescct/ as:
 *
 *   R (0.713, 0.293)  G (0.165, 0.830)  B (0.128, 0.044)  W (0.32168, 0.33767)
 *
 * The ACES white point is deliberately *not* the CIE D60 illuminant. It is a
 * rounded chromaticity close to it, and the ACES documents use the two names
 * interchangeably. Deriving from the stated chromaticity rather than from a
 * daylight-locus formula is what matches every ACES matrix in circulation.
 */
export const AP1_RED_X = 0.713
export const AP1_RED_Y = 0.293
export const AP1_GREEN_X = 0.165
export const AP1_GREEN_Y = 0.83
export const AP1_BLUE_X = 0.128
export const AP1_BLUE_Y = 0.044
export const ACES_WHITE_X = 0.32168
export const ACES_WHITE_Y = 0.33767

/** XYZ of the D65 white point at unit luminance. */
export const D65_WHITE_XYZ: Vec3 = xyToXYZ(D65_X, D65_Y)

/** XYZ of the ACES white point at unit luminance. */
export const ACES_WHITE_XYZ: Vec3 = xyToXYZ(ACES_WHITE_X, ACES_WHITE_Y)

/** Linear sRGB (D65) -> CIE XYZ, still adapted to D65. */
export const SRGB_TO_XYZ_D65: Mat3 = rgbToXyzMatrix(
  SRGB_RED_X,
  SRGB_RED_Y,
  SRGB_GREEN_X,
  SRGB_GREEN_Y,
  SRGB_BLUE_X,
  SRGB_BLUE_Y,
  D65_X,
  D65_Y,
)

/** ACEScg / AP1 (ACES white) -> CIE XYZ, adapted to the ACES white point. */
export const AP1_TO_XYZ_ACES_WHITE: Mat3 = rgbToXyzMatrix(
  AP1_RED_X,
  AP1_RED_Y,
  AP1_GREEN_X,
  AP1_GREEN_Y,
  AP1_BLUE_X,
  AP1_BLUE_Y,
  ACES_WHITE_X,
  ACES_WHITE_Y,
)

export const XYZ_D65_TO_SRGB: Mat3 = mat3Inverse(SRGB_TO_XYZ_D65)
export const XYZ_ACES_WHITE_TO_AP1: Mat3 = mat3Inverse(AP1_TO_XYZ_ACES_WHITE)
