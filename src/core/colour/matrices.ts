/**
 * The composed conversions between linear sRGB and the ACEScg working space.
 *
 * sRGB is defined against D65 and ACEScg against the ACES white point, so the
 * conversion is three steps, not two:
 *
 *     linear sRGB -> XYZ (D65) -> XYZ (ACES white) -> ACEScg
 *
 * The middle step is a **Bradford** chromatic adaptation, per the ACES
 * specifications. Omitting it is the standard mistake, and the standard mistake
 * is nearly invisible: the image is not obviously broken, white simply picks up
 * a slight cast that everything downstream inherits. `adaptation.ts` explains
 * why Bradford here and CAT02 for the runtime white balance control.
 *
 * The cheap check on all of this is that every row must sum to 1, which holds
 * exactly when white maps to white, which holds exactly when the adaptation is
 * present and pointing the right way. Without it the first row sums to 0.977 —
 * a 2.3% error on red, well under the threshold of "looks wrong".
 */

import type { Mat3 } from './types'
import { mat3Inverse, mat3Mul } from './types'
import { bradfordAdaptationMatrix } from './adaptation'
import {
  ACES_WHITE_XYZ,
  D65_WHITE_XYZ,
  SRGB_TO_XYZ_D65,
  XYZ_ACES_WHITE_TO_AP1,
} from './primaries'

/** Bradford adaptation from the sRGB white point to the ACES white point. */
export const BRADFORD_D65_TO_ACES_WHITE: Mat3 = bradfordAdaptationMatrix(
  D65_WHITE_XYZ,
  ACES_WHITE_XYZ,
)

/**
 * Linear sRGB -> ACEScg. This is the ingest matrix: it runs once per pixel at
 * the end of pass 0, immediately after linearisation.
 */
export const SRGB_TO_ACESCG: Mat3 = mat3Mul(
  XYZ_ACES_WHITE_TO_AP1,
  mat3Mul(BRADFORD_D65_TO_ACES_WHITE, SRGB_TO_XYZ_D65),
)

/**
 * ACEScg -> linear sRGB, for the display transform in pass 5.
 *
 * Derived by inverting the forward matrix rather than by composing the three
 * inverse steps, so the two cannot drift apart: `M * M^-1 = I` is then true by
 * construction and the test asserting it is checking the inverse routine, while
 * the round-trip test through the transfer functions checks the composition.
 */
export const ACESCG_TO_SRGB: Mat3 = mat3Inverse(SRGB_TO_ACESCG)
