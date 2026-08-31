/**
 * Chromatic adaptation transforms.
 *
 * # Why there are two of these, and which is which
 *
 * This module exports **Bradford** and **CAT02**. They do the same kind of
 * arithmetic and they are used for two unrelated purposes. Confusing them is
 * easy and the symptom — a slight, uniform colour cast — looks like a bug in
 * something else entirely, so the split is stated here rather than left to be
 * rediscovered.
 *
 * **Bradford is structural, static, and invisible when correct.** It is baked
 * into the sRGB <-> ACEScg matrices in `matrices.ts`, adapting D65 (the sRGB
 * white point) to the ACES white point. It exists because the two spaces are
 * defined against different white points and a matrix that ignores that does
 * not map white to white. Bradford specifically, because that is what the ACES
 * specifications prescribe and what every published ACES matrix was built with;
 * substituting CAT02 here would put this project's matrices out of agreement
 * with every reference it could be checked against. It is computed once at
 * module load and never varies.
 *
 * **CAT02 is creative, dynamic, and meant to be seen.** It is the white balance
 * control in pass 1 of the pipeline: the user picks a source white (what the
 * scene was lit by) and a destination white (what it should look like it was
 * lit by), and this produces the matrix. It is recomputed whenever that
 * parameter changes. CAT02 rather than Bradford because CAT02 is the more
 * recent transform, fitted to newer corresponding-colour data, and this is the
 * adaptation a human will actually judge by eye.
 *
 * `docs/COLOUR_PIPELINE.md` states the same division under "White balance".
 *
 * # Why this is not a per-channel RGB scale
 *
 * The obvious way to warm an image is to multiply R up and B down. That also
 * changes saturation and hue, because the RGB primaries are not the axes the
 * human visual system adapts along. A von Kries adaptation scales in a *cone
 * response* space, where adaptation actually happens, so a temperature change
 * reads as a temperature change and nothing else. The cone response matrix is
 * the only thing separating Bradford from CAT02 — the surrounding structure is
 * identical, which is why they share one implementation here.
 */

import type { Mat3, Vec3 } from './types'
import { mat3FromDiagonal, mat3Inverse, mat3Mul, mat3MulVec3 } from './types'

/**
 * The Bradford cone response matrix, as used by the ACES specifications and by
 * every ICC-derived implementation. Row-major.
 *
 * Bradford is a "sharpened" transform: its axes are more spectrally separated
 * than real cone responses, which is why it outperforms a literal von Kries
 * scale despite being less physiological.
 */
export const CONE_RESPONSE_BRADFORD: Mat3 = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
]

/**
 * The CAT02 cone response matrix, from CIECAM02 (CIE 159:2004). Row-major.
 */
export const CONE_RESPONSE_CAT02: Mat3 = [
  0.7328, 0.4296, -0.1624,
  -0.7036, 1.6975, 0.0061,
  0.003, 0.0136, 0.9834,
]

/**
 * The general von Kries adaptation: move XYZ into the cone space defined by
 * `coneResponse`, scale each cone response by the ratio of destination to
 * source white, and move back.
 *
 * Returns a matrix operating on XYZ column vectors, so that
 * `mat3MulVec3(m, srcWhiteXYZ)` is `dstWhiteXYZ` exactly. That identity is a
 * property of the construction rather than of the particular numbers, and
 * `tests/unit/adaptation.test.ts` asserts it for both transforms.
 *
 * CPU-side: this builds a uniform, it does not run per pixel. Applying the
 * result is one `m * v`.
 */
export function chromaticAdaptationMatrix(
  coneResponse: Mat3,
  srcWhiteXYZ: Vec3,
  dstWhiteXYZ: Vec3,
): Mat3 {
  const src = mat3MulVec3(coneResponse, srcWhiteXYZ)
  const dst = mat3MulVec3(coneResponse, dstWhiteXYZ)

  if (src[0] === 0 || src[1] === 0 || src[2] === 0) {
    throw new RangeError(
      `chromaticAdaptationMatrix: source white has a zero cone response (${src.join(', ')})`,
    )
  }

  const gain = mat3FromDiagonal([dst[0] / src[0], dst[1] / src[1], dst[2] / src[2]])

  return mat3Mul(mat3Inverse(coneResponse), mat3Mul(gain, coneResponse))
}

/** Bradford adaptation. Structural: baked into the space conversion matrices. */
export function bradfordAdaptationMatrix(srcWhiteXYZ: Vec3, dstWhiteXYZ: Vec3): Mat3 {
  return chromaticAdaptationMatrix(CONE_RESPONSE_BRADFORD, srcWhiteXYZ, dstWhiteXYZ)
}

/** CAT02 adaptation. Creative: this is the runtime white balance control. */
export function cat02AdaptationMatrix(srcWhiteXYZ: Vec3, dstWhiteXYZ: Vec3): Mat3 {
  return chromaticAdaptationMatrix(CONE_RESPONSE_CAT02, srcWhiteXYZ, dstWhiteXYZ)
}
