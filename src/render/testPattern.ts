/**
 * The generated test pattern, and the single definition of its patch colours.
 *
 * The pattern is produced in the shader rather than loaded, so that the render
 * path can be exercised end to end before image decoding exists. The patch
 * values live here in TypeScript and are uploaded as a uniform array, which
 * means there is one definition rather than a GLSL copy and a test copy that can
 * drift — and it also puts them on the correct side of the recompile boundary,
 * since changing a patch colour is a uniform update and not a new program.
 *
 * Values are **encoded sRGB**, standing in for the 8-bit data a decoded JPEG
 * would supply. Ingest linearises them and converts to ACEScg exactly as it will
 * for a real image.
 */

/** Fixed, because a GLSL array needs a compile-time length. */
export const PATCH_COUNT = 16

/** 4x4 grid over the upper part of the frame; the remainder is a ramp. */
export const PATCH_GRID = 4

/** Fraction of the frame height given to the ramp band along the bottom. */
export const RAMP_HEIGHT_FRACTION = 0.25

/** Middle grey, encoded. The value every tonal decision is anchored to. */
const MID_GREY_ENCODED = 0.4586300108

/**
 * Encoded sRGB patch values, row-major from the top left.
 *
 * The set is chosen so that each patch can fail for a distinguishable reason:
 *
 * - **Black and white** catch a matrix that does not preserve neutrals, which is
 *   the row-sum property expressed as a pixel.
 * - **Middle grey** is where a gamma or transfer-function error is largest in
 *   absolute terms.
 * - **Primaries and secondaries** catch a transposed matrix. A transpose leaves
 *   neutrals alone and moves saturated colours, so a pattern of only greys would
 *   pass with the columns swapped.
 * - **Values straddling the sRGB piecewise break** (0.04 and 0.045, either side
 *   of 0.04045) catch a branch that took the wrong segment.
 * - **1.2 and -0.05** are outside the encodable range. They exercise the display
 *   clamp and the odd-symmetric extension of the transfer functions, which is
 *   the path a real out-of-gamut pixel takes.
 */
export const PATCH_COLOURS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 1, 1],
  [MID_GREY_ENCODED, MID_GREY_ENCODED, MID_GREY_ENCODED],
  [0.5, 0.5, 0.5],

  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.25, 0.5, 0.75],

  [0, 1, 1],
  [1, 0, 1],
  [1, 1, 0],
  [0.75, 0.25, 0.5],

  [0.04, 0.04, 0.04],
  [0.045, 0.045, 0.045],
  [1.2, 1.2, 1.2],
  [-0.05, 0.3, 0.6],
]

if (PATCH_COLOURS.length !== PATCH_COUNT) {
  throw new Error(
    `testPattern: PATCH_COLOURS has ${PATCH_COLOURS.length} entries but the shader array is ${PATCH_COUNT}`,
  )
}

/** Flattened for `uniform3fv`. */
export function patchUniformArray(): Float32Array {
  const out = new Float32Array(PATCH_COUNT * 3)
  for (let i = 0; i < PATCH_COUNT; i++) {
    const patch = PATCH_COLOURS[i]
    if (!patch) throw new Error(`testPattern: missing patch ${i}`)
    out[i * 3] = patch[0]
    out[i * 3 + 1] = patch[1]
    out[i * 3 + 2] = patch[2]
  }
  return out
}

/**
 * The centre of patch `index` in normalised coordinates with **y up**, matching
 * the shader's `vTexCoord`. The test uses this to sample the same pixel the
 * shader wrote, so a disagreement is a colour error rather than an off-by-one in
 * two different grid derivations.
 */
export function patchCentreUv(index: number): readonly [number, number] {
  if (!Number.isInteger(index) || index < 0 || index >= PATCH_COUNT) {
    throw new RangeError(`patchCentreUv: index ${index} out of range`)
  }
  const column = index % PATCH_GRID
  const row = Math.floor(index / PATCH_GRID)
  const u = (column + 0.5) / PATCH_GRID
  // Row 0 is the top of the frame; the grid occupies everything above the ramp.
  const gridTop = 1
  const gridBottom = RAMP_HEIGHT_FRACTION
  const v = gridTop - ((row + 0.5) / PATCH_GRID) * (gridTop - gridBottom)
  return [u, v]
}
