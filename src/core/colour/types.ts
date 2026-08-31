/**
 * Fixed-length vector and matrix types, and the unrolled arithmetic on them.
 *
 * ## Why tuples and not `number[][]`
 *
 * Two constraints meet here. `noUncheckedIndexedAccess` makes every array index
 * `T | undefined`, and the colour module must stay transliterable into GLSL.
 * A flat nine-element tuple satisfies both: indexing it with a *literal* is
 * known-present so the flag never fires, and a flat nine-float layout is what a
 * GLSL `mat3` already is. The arithmetic below is therefore unrolled rather
 * than looped — a loop variable would reintroduce `| undefined` on every access
 * and force non-null assertions, which is exactly the noise the flag exists to
 * prevent.
 *
 * ## Storage order, and the trap in it
 *
 * `Mat3` is **row-major**: `m[0], m[1], m[2]` is the first row. This matches how
 * matrices are written in the ACES specifications and in every published matrix
 * this module is checked against, so a value can be compared to its source
 * without a mental transpose.
 *
 * **GLSL is column-major.** `mat3(a, b, c, ...)` fills the first *column* first,
 * and `m[0]` in GLSL is a column, not a row. When one of these matrices is
 * uploaded, either transpose it first or pass `transpose = true` to
 * `uniformMatrix3fv` — WebGL2 permits that, WebGL1 did not. Getting this wrong
 * produces a plausible-looking image with wrong colour, which is precisely the
 * failure `docs/COLOUR_PIPELINE.md` says the sRGB round-trip test exists to
 * catch.
 *
 * ## Which functions are per-pixel
 *
 * `mat3MulVec3` is the only function here that runs per pixel; in a shader it is
 * a single `m * v`. The rest — multiply, inverse, diagonal — build matrices on
 * the CPU that are then uploaded as uniforms. `mat3Inverse` throws, which has no
 * GLSL equivalent, and that is fine because it never runs on the GPU.
 */

/** An RGB or XYZ triple. */
export type Vec3 = readonly [number, number, number]

/** A 3x3 matrix, row-major: `[r0c0, r0c1, r0c2, r1c0, ...]`. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

export const MAT3_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** `m * v`, treating `v` as a column vector. Per-pixel; one `m * v` in GLSL. */
export function mat3MulVec3(m: Mat3, v: Vec3): Vec3 {
  const [x, y, z] = v
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ]
}

/** `a * b`. Applying the result is the same as applying `b` and then `a`. */
export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],

    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],

    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ]
}

export function mat3Transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

/** The diagonal matrix whose diagonal is `d`. Used to build the von Kries scale. */
export function mat3FromDiagonal(d: Vec3): Mat3 {
  const [x, y, z] = d
  return [x, 0, 0, 0, y, 0, 0, 0, z]
}

export function mat3Determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  )
}

/**
 * Inverse by cofactors. CPU-side only — it throws, and the matrices it inverts
 * are built once and uploaded, never inverted per pixel.
 */
export function mat3Inverse(m: Mat3): Mat3 {
  const det = mat3Determinant(m)
  if (!Number.isFinite(det) || det === 0) {
    throw new RangeError(`mat3Inverse: matrix is singular (determinant ${det})`)
  }
  const inv = 1 / det
  return [
    (m[4] * m[8] - m[5] * m[7]) * inv,
    (m[2] * m[7] - m[1] * m[8]) * inv,
    (m[1] * m[5] - m[2] * m[4]) * inv,

    (m[5] * m[6] - m[3] * m[8]) * inv,
    (m[0] * m[8] - m[2] * m[6]) * inv,
    (m[2] * m[3] - m[0] * m[5]) * inv,

    (m[3] * m[7] - m[4] * m[6]) * inv,
    (m[1] * m[6] - m[0] * m[7]) * inv,
    (m[0] * m[4] - m[1] * m[3]) * inv,
  ]
}
