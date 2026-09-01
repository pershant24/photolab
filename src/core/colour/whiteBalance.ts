/**
 * White balance: temperature and tint to a chromatic adaptation matrix.
 *
 * The adaptation itself is CAT02, already written and tested in
 * `adaptation.ts`. What this adds is the part a person interacts with — turning
 * "the light was 3200K, slightly green" into a source white point.
 *
 * # Relative, not absolute, and that is what makes neutral exact
 *
 * The adaptation runs from the white point the user names **to the white point
 * at the neutral setting**, rather than to the working space's white. Two
 * reasons, and the first is decisive:
 *
 * 1. **At the neutral setting the source and destination are the same point, so
 *    the transform is the identity by construction** rather than by arithmetic
 *    landing close. Adapting to the working space's white instead would leave a
 *    residue at the default — the Planckian approximation does not pass exactly
 *    through the ACES white — and every unedited photograph would be altered by
 *    a white balance nobody asked for.
 * 2. It matches what the numbers mean to a photographer. Setting the slider to
 *    3200 says "this was lit by tungsten", and the application removes that
 *    cast; the image gets cooler, which is the direction every editor moves it.
 */

import type { Mat3, Vec3 } from './types'
import { MAT3_IDENTITY, mat3Mul } from './types'
import { cat02AdaptationMatrix } from './adaptation'
import { AP1_TO_XYZ_ACES_WHITE, XYZ_ACES_WHITE_TO_AP1, xyToXYZ } from './primaries'

/**
 * The setting at which white balance does nothing at all.
 *
 * **This is a definition, not a measurement, and the scale is Planckian.** The
 * image's own white is D65, which is a *daylight* illuminant sitting above the
 * Planckian locus — at 6504K the two differ by 5.4e-3 in y, twenty times the
 * fit's own error. So 6500 on this slider is not exactly D65, and the number is
 * a label on a relative control rather than a claim about the light.
 *
 * That is consistent because the adaptation runs from the named white point to
 * *this* one, so the two offsets cancel and the neutral setting is exactly the
 * identity. It would not be consistent if the destination were the working
 * space's white, which is the other reason for the choice above.
 *
 * A daylight-locus scale would put the number on firmer ground for the range
 * most photographs live in. It is not done here because the Planckian locus
 * covers tungsten as well, and one locus that is honest about being a label
 * beats two that have to be switched between.
 */
export const NEUTRAL_TEMPERATURE = 6500
export const NEUTRAL_TINT = 0

/** The range the Planckian approximation below is valid over. */
export const MIN_TEMPERATURE = 1700
export const MAX_TEMPERATURE = 25000

/**
 * Tint units to a displacement in CIE 1960 `v`.
 *
 * Chosen so the full slider travel of ±100 spans ±0.05 in `v`, which is roughly
 * the green-to-magenta range a corrective tint needs. It is a scale on a
 * perceptual axis rather than a physical constant, so it is a judgement.
 */
const TINT_TO_V = 0.0005

/**
 * The Planckian locus in CIE xy, from Kang et al. (2002).
 *
 * A cubic fit rather than an integration of Planck's law, which would need the
 * colour matching functions at runtime for no visible gain: the fit is within
 * 5e-5 of the true locus across its range, which is far below the precision of
 * a slider a person drags by eye.
 *
 * Three pieces because the fit for `y` changes below 2222K and again below
 * 4000K. The `x` fit changes once, at 4000K.
 */
export function planckianXy(temperatureK: number): readonly [number, number] {
  const t = Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, temperatureK))
  const t2 = t * t
  const t3 = t2 * t

  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039

  const x2 = x * x
  const x3 = x2 * x
  const y =
    t <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483

  return [x, y]
}

/** CIE 1931 xy to CIE 1960 uv, the space tint is displaced in. */
export function xyToUv(x: number, y: number): readonly [number, number] {
  const denominator = -2 * x + 12 * y + 3
  return [(4 * x) / denominator, (6 * y) / denominator]
}

export function uvToXy(u: number, v: number): readonly [number, number] {
  const denominator = 2 * u - 8 * v + 4
  return [(3 * u) / denominator, (2 * v) / denominator]
}

/**
 * The white point a temperature and tint describe.
 *
 * Tint displaces `v` in CIE 1960, which is the axis a green-magenta correction
 * moves along. Strictly the displacement should follow the isotherm — the normal
 * to the Planckian locus at that temperature — and near the locus the two differ
 * by a small rotation. The approximation is recorded rather than hidden: it costs
 * a slight coupling between tint and temperature at the extremes of both, and it
 * saves computing the locus derivative for a control that is dragged by eye.
 */
export function whitePointXy(
  temperatureK: number,
  tint: number,
): readonly [number, number] {
  const [x, y] = planckianXy(temperatureK)
  if (tint === 0) return [x, y]
  const [u, v] = xyToUv(x, y)
  return uvToXy(u, v + tint * TINT_TO_V)
}

export function isNeutralWhiteBalance(temperatureK: number, tint: number): boolean {
  return temperatureK === NEUTRAL_TEMPERATURE && tint === NEUTRAL_TINT
}

/**
 * The white balance matrix, operating on ACEScg.
 *
 * Adaptation happens in XYZ, where a white point is a white point, so the
 * working space's primaries are stepped out of and back into around it. That is
 * three matrices composed once per parameter change on the CPU, not per pixel:
 * the shader receives one `mat3`.
 *
 * Returns the identity **exactly** at the neutral setting rather than composing
 * a matrix with its own inverse and accepting the residue. The composition is
 * accurate to about 1e-16, which would be invisible — and that is the problem:
 * "invisible" is how an unedited photograph gets altered without anyone
 * noticing.
 */
export function whiteBalanceMatrix(temperatureK: number, tint: number): Mat3 {
  if (isNeutralWhiteBalance(temperatureK, tint)) return MAT3_IDENTITY

  const source = whitePointXy(temperatureK, tint)
  const destination = whitePointXy(NEUTRAL_TEMPERATURE, NEUTRAL_TINT)

  const sourceXYZ: Vec3 = xyToXYZ(source[0], source[1])
  const destinationXYZ: Vec3 = xyToXYZ(destination[0], destination[1])

  return mat3Mul(
    XYZ_ACES_WHITE_TO_AP1,
    mat3Mul(cat02AdaptationMatrix(sourceXYZ, destinationXYZ), AP1_TO_XYZ_ACES_WHITE),
  )
}
