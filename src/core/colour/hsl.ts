/**
 * Banded hue, saturation and luminance.
 *
 * # No HSL round trip, and that is the whole design
 *
 * The obvious implementation converts to HSL, adjusts, and converts back. It
 * cannot meet the requirement. A round trip through a hexagonal model is not
 * bit-exact in floating point, so the moment *any* band is adjusted, every pixel
 * in the frame goes through the conversion and pixels in the untouched bands come
 * back changed. "A neutral setting must be an exact identity" is not satisfied by
 * an `enabled` predicate covering the all-neutral case — a picture with one band
 * adjusted is the normal case, and the other five must be untouched in it.
 *
 * So the three adjustments are applied as operations on RGB directly, each of
 * which is *exactly* the identity at zero:
 *
 * - **hue** is a rotation about the neutral axis. At zero the rotation matrix is
 *   exactly the identity, since `cos 0` is exactly 1 and `sin 0` exactly 0.
 * - **saturation** is `mix(grey, rgb, 1 + s)`. At `s = 0` this is `mix(x, y, 1)`,
 *   which is `x*0 + y*1` and returns `y` unchanged.
 * - **luminance** is a multiply by `2^l`. At `l = 0` that is a multiply by one.
 *
 * No conversion, no error to leak, and the identity holds per pixel rather than
 * per frame.
 *
 * # The bands overlap, and sum to one
 *
 * Six bands on 60-degree centres, each a raised cosine of half-width 60 degrees.
 * That particular pairing is a partition of unity: for any hue the two
 * neighbouring bands contribute `0.5(1 + cos(pi d / 60))` and
 * `0.5(1 + cos(pi (60 - d) / 60))`, and the cosines cancel to leave exactly 1.
 *
 * A partition matters for the same reason it did for the wheels. It means a hue
 * sitting between two bands receives the weighted average of their settings
 * rather than the sum, so setting every band to the same value adjusts the whole
 * picture by that value instead of by six times it.
 */

/** Band centres, in degrees. Red through magenta. */
export const HSL_BANDS: readonly string[] = [
  'Red',
  'Yellow',
  'Green',
  'Cyan',
  'Blue',
  'Magenta',
]
export const HSL_BAND_COUNT = HSL_BANDS.length
export const HSL_BAND_SPACING = 360 / HSL_BAND_COUNT

/** The identity for a banded parameter: every band neutral. */
export const HSL_IDENTITY: readonly number[] = Array<number>(HSL_BAND_COUNT).fill(0)

export function isHslIdentity(bands: readonly number[]): boolean {
  return bands.length === HSL_BAND_COUNT && bands.every((v) => v === 0)
}

/** Shortest signed distance between two hue angles, in degrees. */
export function hueDistance(a: number, b: number): number {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

/**
 * The six band weights at a hue angle.
 *
 * Sums to exactly one for any hue, which is asserted across a full turn rather
 * than argued from the algebra.
 */
export function bandWeights(hueDegrees: number): number[] {
  const out: number[] = []
  for (let i = 0; i < HSL_BAND_COUNT; i++) {
    const d = Math.abs(hueDistance(hueDegrees, i * HSL_BAND_SPACING))
    out.push(d >= HSL_BAND_SPACING ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / HSL_BAND_SPACING)))
  }
  return out
}

/** The weighted setting at a hue, given one adjustment per band. */
export function bandedValue(hueDegrees: number, bands: readonly number[]): number {
  const weights = bandWeights(hueDegrees)
  let sum = 0
  for (let i = 0; i < HSL_BAND_COUNT; i++) sum += (weights[i] ?? 0) * (bands[i] ?? 0)
  return sum
}

/**
 * Hue of an RGB triple, in degrees, by the hexagonal construction.
 *
 * Used only to *weight* the bands, never to reconstruct a colour, so its
 * coarseness relative to a perceptual hue does not propagate into the result. A
 * neutral has no hue; zero is returned and every band then weights a zero
 * adjustment, which is the identity either way.
 */
export function rgbHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = max - min
  if (chroma <= 0) return 0
  let hue: number
  if (max === r) hue = ((g - b) / chroma) % 6
  else if (max === g) hue = (b - r) / chroma + 2
  else hue = (r - g) / chroma + 4
  hue *= 60
  return hue < 0 ? hue + 360 : hue
}

/** Rec.709-style luminance weights for AP1, shared with the halation threshold. */
export const AP1_LUMINANCE: readonly [number, number, number] = [0.2722, 0.6741, 0.0537]

export type Rgb = readonly [number, number, number]

/**
 * Rotate about the neutral axis by `degrees`.
 *
 * Rodrigues' formula for a rotation about `(1,1,1)/sqrt(3)`. At zero degrees
 * `cos` is exactly 1 and `sin` exactly 0, so every off-diagonal term is exactly
 * zero and the matrix is exactly the identity — which is what makes the identity
 * requirement hold by construction rather than within a tolerance.
 */
export function rotateHue(rgb: Rgb, degrees: number): Rgb {
  const a = (degrees * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const t = (1 - c) / 3
  const u = Math.sqrt(1 / 3) * s
  const m00 = c + t
  const m01 = t - u
  const m02 = t + u
  return [
    m00 * rgb[0] + m01 * rgb[1] + m02 * rgb[2],
    m02 * rgb[0] + m00 * rgb[1] + m01 * rgb[2],
    m01 * rgb[0] + m02 * rgb[1] + m00 * rgb[2],
  ]
}

/**
 * Apply the three banded adjustments to one colour.
 *
 * Ordered hue, then saturation, then luminance. Hue first because the band the
 * pixel belongs to is decided by its original hue, and rotating after weighting
 * would let a large rotation carry a colour into a band whose settings it had
 * already been adjusted by.
 */
export function applyHsl(
  rgb: Rgb,
  hueBands: readonly number[],
  saturationBands: readonly number[],
  luminanceBands: readonly number[],
): Rgb {
  const hue = rgbHue(rgb[0], rgb[1], rgb[2])
  const dHue = bandedValue(hue, hueBands)
  const dSat = bandedValue(hue, saturationBands)
  const dLum = bandedValue(hue, luminanceBands)

  const rotated = rotateHue(rgb, dHue)
  const luma =
    rotated[0] * AP1_LUMINANCE[0] + rotated[1] * AP1_LUMINANCE[1] + rotated[2] * AP1_LUMINANCE[2]
  const saturation = 1 + dSat
  const gain = 2 ** dLum
  // The `mix` form, not `luma + (rgb - luma) * s`. They are the same in exact
  // arithmetic and not in floating point: at `s = 1` the mix is `x*0 + y*1`,
  // which returns `y` bit-for-bit, while the other subtracts and re-adds `luma`
  // and does not round-trip. That difference is the entire identity requirement.
  const mix = (x: number, y: number, a: number): number => x * (1 - a) + y * a
  return [
    mix(luma, rotated[0], saturation) * gain,
    mix(luma, rotated[1], saturation) * gain,
    mix(luma, rotated[2], saturation) * gain,
  ]
}

/** The largest adjustment each band offers. Hue in degrees; the others as ratios. */
export const HSL_HUE_RANGE = 30
export const HSL_SATURATION_RANGE = 1
export const HSL_LUMINANCE_RANGE = 1
