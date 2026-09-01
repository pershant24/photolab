/**
 * The generated test pattern, and the single definition of its patches.
 *
 * The pattern is produced in the shader rather than loaded, so the render path
 * can be exercised without an image. Patch values live here and are uploaded as
 * a uniform array, so there is one definition rather than a GLSL copy and a test
 * copy that can drift — and changing one is a uniform update, not a recompile.
 *
 * `encoded` values stand in for the 8-bit data a decoded JPEG supplies. Ingest
 * linearises them and converts to ACEScg exactly as it will for a real image.
 */

import { ACESCG_TO_SRGB } from '../core/colour/matrices'
import { MIDDLE_GREY_LINEAR } from '../core/colour/grade'
import { SRGB_ENCODED_BREAK, srgbOetf } from '../core/colour/transfer'
import { mat3MulVec3 } from '../core/colour/types'
import type { Vec3 } from '../core/colour/types'

export const PATCH_GRID = 5
export const PATCH_COUNT = PATCH_GRID * PATCH_GRID

/** Fraction of the frame height given to the ramp band along the bottom. */
export const RAMP_HEIGHT_FRACTION = 0.2

export interface Patch {
  /** Encoded sRGB, as it enters ingest. */
  readonly encoded: Vec3
  readonly label: string
  /**
   * Every channel of the *displayed* result sits well away from 0 and 1.
   *
   * Leg 2 of the agreement test uses only these. A patch whose result clamps
   * loses the signal precisely where a display-matrix error is largest, which
   * was half of what made the original canvas assertion weak.
   */
  readonly midtone: boolean
  /** The ACEScg value is outside what sRGB can represent. */
  readonly outOfGamut: boolean
}

/**
 * Middle grey, encoded.
 *
 * **Derived, not transcribed.** The literal that was here originally was
 * 0.4586300108, which is `0.18 ** (1/2.2)` — the pure gamma-2.2 value, not the
 * sRGB piecewise one, which is 0.4613561295. It decoded to 0.1777, so the patch
 * labelled "middle grey" was 1.26% dark and this test pattern's mid grey was not
 * mid grey.
 *
 * Nothing caught it for two stages, because nothing had asserted *where* middle
 * grey is: the agreement tests compare the shader against the reference, and
 * both were given the same wrong number. It surfaced only when the contrast
 * pivot test asserted that middle grey does not move at any slope, which is the
 * first assertion that depends on the value being what its label says.
 *
 * Confusing the 2.2 approximation with the piecewise definition is the exact
 * mistake `src/core/colour/transfer.ts` is written to warn about, and it still
 * happened. Deriving it removes the opportunity.
 */
const MID_GREY_ENCODED = srgbOetf(MIDDLE_GREY_LINEAR)

/**
 * Either side of the sRGB piecewise break, derived from the break itself.
 *
 * These were 0.04 and 0.045 against a break at 0.04045 — correct, but only
 * because someone had done the arithmetic once and it happened to stay true.
 * Written against the constant, a patch labelled "just below the break" is below
 * the break by construction, and it stays there if the break is ever corrected.
 */
const BREAK_MARGIN = 0.0005
const BELOW_BREAK = SRGB_ENCODED_BREAK - BREAK_MARGIN
const ABOVE_BREAK = SRGB_ENCODED_BREAK + BREAK_MARGIN

/**
 * Patches whose **ACEScg** value is the specification, not their sRGB input.
 *
 * AP1 encloses Rec.709, so no sRGB input can produce an out-of-gamut ACEScg
 * value — the pattern structurally could not reach this region. These are
 * synthesised by working backwards: the encoded input that ingest turns into the
 * wanted ACEScg value is `srgbOetf(ACESCG_TO_SRGB * target)`, since the transfer
 * functions are exact inverses and the matrices are too.
 *
 * They matter now rather than later. Negative channels arrive for real the
 * moment white balance and the film curves land, and the display path's
 * behaviour on them is much better pinned before that than discovered then.
 */
const OUT_OF_GAMUT_ACESCG: readonly (readonly [Vec3, string])[] = [
  [[0, 1, 0], 'AP1 green, negative red and blue in sRGB'],
  [[0, 0.55, 0.8], 'AP1 cyan, negative red in sRGB'],
  [[0.75, 0.1, 0.9], 'AP1 magenta, negative green in sRGB'],
  [[3.5, 3.5, 3.5], 'far above display white'],
]

function encodedFromAcescg(target: Vec3): Vec3 {
  const linear = mat3MulVec3(ACESCG_TO_SRGB, target)
  return [srgbOetf(linear[0]), srgbOetf(linear[1]), srgbOetf(linear[2])]
}

/**
 * The set is chosen so each patch can fail for a distinguishable reason:
 *
 * - **Black and white** catch a matrix that does not preserve neutrals, which is
 *   the row-sum property expressed as a pixel.
 * - **Primaries and secondaries** catch a transposed matrix, which leaves
 *   neutrals alone and moves saturated colours.
 * - **Values straddling the sRGB piecewise break** catch a branch that took the
 *   wrong segment.
 * - **Midtones** are the only ones leg 2 can use, because nothing about them
 *   clamps.
 * - **Out-of-gamut** pin what the display transform does with values it cannot
 *   show.
 */
export const PATCHES: readonly Patch[] = [
  { encoded: [0, 0, 0], label: 'black', midtone: false, outOfGamut: false },
  { encoded: [1, 1, 1], label: 'white', midtone: false, outOfGamut: false },
  {
    encoded: [MID_GREY_ENCODED, MID_GREY_ENCODED, MID_GREY_ENCODED],
    label: 'middle grey 0.18 linear',
    midtone: true,
    outOfGamut: false,
  },
  { encoded: [0.5, 0.5, 0.5], label: 'half encoded grey', midtone: true, outOfGamut: false },
  { encoded: [0.25, 0.25, 0.25], label: 'quarter grey', midtone: true, outOfGamut: false },

  { encoded: [1, 0, 0], label: 'red primary', midtone: false, outOfGamut: false },
  { encoded: [0, 1, 0], label: 'green primary', midtone: false, outOfGamut: false },
  { encoded: [0, 0, 1], label: 'blue primary', midtone: false, outOfGamut: false },
  { encoded: [0, 1, 1], label: 'cyan', midtone: false, outOfGamut: false },
  { encoded: [1, 0, 1], label: 'magenta', midtone: false, outOfGamut: false },

  { encoded: [1, 1, 0], label: 'yellow', midtone: false, outOfGamut: false },
  { encoded: [0.25, 0.5, 0.75], label: 'desaturated blue', midtone: true, outOfGamut: false },
  { encoded: [0.75, 0.25, 0.5], label: 'desaturated pink', midtone: true, outOfGamut: false },
  { encoded: [0.6, 0.45, 0.3], label: 'warm midtone', midtone: true, outOfGamut: false },
  { encoded: [0.3, 0.45, 0.6], label: 'cool midtone', midtone: true, outOfGamut: false },

  { encoded: [0.35, 0.7, 0.55], label: 'muted green', midtone: true, outOfGamut: false },
  { encoded: [0.7, 0.35, 0.2], label: 'muted orange', midtone: true, outOfGamut: false },
  {
    encoded: [BELOW_BREAK, BELOW_BREAK, BELOW_BREAK],
    label: 'just below the sRGB break',
    midtone: false,
    outOfGamut: false,
  },
  {
    encoded: [ABOVE_BREAK, ABOVE_BREAK, ABOVE_BREAK],
    label: 'just above the sRGB break',
    midtone: false,
    outOfGamut: false,
  },
  { encoded: [0.2, 0.6, 0.4], label: 'mid green', midtone: true, outOfGamut: false },

  { encoded: [1.2, 1.2, 1.2], label: 'encoded above 1.0', midtone: false, outOfGamut: true },
  { encoded: [-0.05, 0.3, 0.6], label: 'negative encoded channel', midtone: false, outOfGamut: true },
  ...OUT_OF_GAMUT_ACESCG.slice(0, 3).map(([target, label]) => ({
    encoded: encodedFromAcescg(target),
    label,
    midtone: false,
    outOfGamut: true,
  })),
]

if (PATCHES.length !== PATCH_COUNT) {
  throw new Error(
    `testPattern: PATCHES has ${PATCHES.length} entries but the grid is ${PATCH_COUNT}`,
  )
}

/** Indices leg 2 of the agreement test may use. */
export const MIDTONE_PATCH_INDICES: readonly number[] = PATCHES.flatMap((patch, i) =>
  patch.midtone ? [i] : [],
)

/** Indices whose ACEScg value the display transform cannot represent. */
export const OUT_OF_GAMUT_PATCH_INDICES: readonly number[] = PATCHES.flatMap((patch, i) =>
  patch.outOfGamut ? [i] : [],
)

/** Flattened for `uniform3fv`. */
export function patchUniformArray(): Float32Array {
  const out = new Float32Array(PATCH_COUNT * 3)
  for (let i = 0; i < PATCH_COUNT; i++) {
    const patch = PATCHES[i]
    if (!patch) throw new Error(`testPattern: missing patch ${i}`)
    out[i * 3] = patch.encoded[0]
    out[i * 3 + 1] = patch.encoded[1]
    out[i * 3 + 2] = patch.encoded[2]
  }
  return out
}

/**
 * The centre of patch `index` in normalised coordinates with **y up**, matching
 * the shader's `vTexCoord`. The test samples the same pixel the shader wrote, so
 * a disagreement is a colour error rather than an off-by-one in two independent
 * derivations of a grid.
 */
export function patchCentreUv(index: number): readonly [number, number] {
  if (!Number.isInteger(index) || index < 0 || index >= PATCH_COUNT) {
    throw new RangeError(`patchCentreUv: index ${index} out of range`)
  }
  const column = index % PATCH_GRID
  const row = Math.floor(index / PATCH_GRID)
  const u = (column + 0.5) / PATCH_GRID
  const v = 1 - ((row + 0.5) / PATCH_GRID) * (1 - RAMP_HEIGHT_FRACTION)
  return [u, v]
}
