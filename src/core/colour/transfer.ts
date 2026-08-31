/**
 * Transfer functions: the non-linear encodings that values are stored in, and
 * the linear light they represent.
 *
 * Everything in the render graph between ingest and display is linear. These
 * functions are the two ends of that: `srgbEotf` at ingest, `srgbOetf` at
 * encode, and the ACEScct pair wherever an operator needs to work in a
 * perceptually-spaced log domain rather than in linear light — contrast, in
 * `grade.ts`, is the first of those.
 *
 * ## Negative inputs
 *
 * The sRGB functions are extended by **odd symmetry**: `f(-x) = -f(x)`. Within
 * the domain the specifications define (0 to 1, and beyond 1 by extrapolation)
 * they are exactly the standard piecewise functions and the symmetry never
 * comes into play. Outside it the alternative is `Math.pow` of a negative base,
 * which is `NaN` in TypeScript and undefined in GLSL — a value that propagates
 * silently through the rest of the frame. Negatives reach here whenever an
 * ACEScg colour outside the sRGB gamut is converted back for display, which is
 * routine; the display transform's gamut compression is what is meant to handle
 * them, and this is the behaviour if it has not yet run.
 *
 * ACEScct needs no such treatment. Handling negative linear values is the entire
 * reason it exists: its linear toe is defined below the break point and passes
 * negatives through unharmed, where ACEScc's pure log would send them to
 * negative infinity. Real shadow pixels do go negative after a white balance or
 * a saturated-primary conversion, so this is not a hypothetical.
 */

/** Linear value at which the sRGB curve switches from its linear segment. */
export const SRGB_LINEAR_BREAK = 0.0031308

/** Encoded value at which the sRGB curve switches from its linear segment. */
export const SRGB_ENCODED_BREAK = 0.04045

/** Slope of the sRGB linear segment. */
export const SRGB_SLOPE = 12.92

/** Offset of the sRGB power segment. */
export const SRGB_ALPHA = 0.055

/** Exponent of the sRGB power segment. */
export const SRGB_GAMMA = 2.4

/**
 * sRGB EOTF: encoded -> linear. Piecewise, per IEC 61966-2-1.
 *
 * The linear segment near black is not a rounding detail. The pure 2.2 power
 * approximation has zero slope at zero, so it crushes the darkest few code
 * values into an indistinguishable block and cannot be inverted stably there.
 * The piecewise form has finite slope at the origin, which is what makes the
 * round trip in `tests/unit/transfer.test.ts` exact at 0.
 */
export function srgbEotf(encoded: number): number {
  const magnitude = Math.abs(encoded)
  const linear =
    magnitude <= SRGB_ENCODED_BREAK
      ? magnitude / SRGB_SLOPE
      : Math.pow((magnitude + SRGB_ALPHA) / (1 + SRGB_ALPHA), SRGB_GAMMA)
  return encoded < 0 ? -linear : linear
}

/**
 * sRGB OETF: linear -> encoded. The inverse of {@link srgbEotf}.
 *
 * ## The 2.33e-9 discontinuity is deliberate. Do not "fix" it.
 *
 * "Inverse" holds to about 1e-15 everywhere except in a narrow band around the
 * break point, where it holds to about 3e-9. That is a property of the
 * specification, not of this implementation: 0.04045 and 0.0031308 are rounded
 * values, and the two segments they separate therefore cross at
 * **0.0031308072830676845** rather than at 0.0031308 exactly. Inputs falling
 * inside that 2.33e-9 gap take the linear branch in one direction and the power
 * branch in the other.
 *
 * There is a tidier variant in circulation that solves for the exact threshold
 * and is continuous to machine precision. **It is not used here, and replacing
 * these constants with it would be a regression rather than a cleanup.** This
 * is a photo editor: the values it produces have to match what browsers,
 * display drivers and every other imaging application actually implement, and
 * all of them implement the rounded specification values. Being right to 1e-9
 * against a definition nobody else uses is worse than being bit-compatible with
 * everyone.
 *
 * ## The tolerances this forces, and where they come from
 *
 * `tests/unit/transfer.test.ts` asserts the round trip at two bounds, and both
 * are **derived rather than tuned until the test passed**:
 *
 *  - **Linear space: 2.4e-9**, the measured gap of 2.33e-9 with a little room,
 *    since a bound sitting exactly on the observed value is not a bound.
 *  - **Encoded space: that same gap multiplied by 12.92**, the slope of the
 *    linear segment the discrepancy falls on. Predicted 3.1e-8 before running;
 *    observed 2.96e-8. Had the number been tuned, its agreement with the slope
 *    would be a coincidence rather than evidence.
 *
 * Away from the break the same tests assert the round trip to 1e-12, so
 * loosening for the break point does not buy slack anywhere else on the ramp.
 */
export function srgbOetf(linear: number): number {
  const magnitude = Math.abs(linear)
  const encoded =
    magnitude <= SRGB_LINEAR_BREAK
      ? magnitude * SRGB_SLOPE
      : (1 + SRGB_ALPHA) * Math.pow(magnitude, 1 / SRGB_GAMMA) - SRGB_ALPHA
  return linear < 0 ? -encoded : encoded
}

/**
 * ACEScct constants, from the ACES specification as published at
 * docs.acescentral.com/encodings/acescct/:
 *
 *     ACEScct = A * lin + B                    for lin <= X_BRK
 *             = (log2(lin) + 9.72) / 17.52     for lin >  X_BRK
 *
 * `A` and `B` are not free parameters and are not merely transcribed here.
 * `A` is the slope the log segment already has at the break point, and `B` is
 * whatever makes the two segments meet there. Both derivations are asserted in
 * `tests/unit/transfer.test.ts`, so the constants are validated against the log
 * function itself rather than against the source they were copied from.
 */
export const ACESCCT_X_BRK = 0.0078125
export const ACESCCT_Y_BRK = 0.155251141552511
export const ACESCCT_A = 10.5402377416545
export const ACESCCT_B = 0.0729055341958355
export const ACESCCT_LOG_OFFSET = 9.72
export const ACESCCT_LOG_SCALE = 17.52

/**
 * The largest linear value ACEScct can represent: the maximum finite half float.
 * The specification clamps decoding to it, which is deliberate — ACEScct is
 * designed to be carried in a half-float buffer, which is what this project's
 * intermediates are.
 */
export const ACESCCT_MAX_LINEAR = 65504

/** The encoded value at which decoding clamps to {@link ACESCCT_MAX_LINEAR}. */
export const ACESCCT_MAX_ENCODED =
  (Math.log2(ACESCCT_MAX_LINEAR) + ACESCCT_LOG_OFFSET) / ACESCCT_LOG_SCALE

/**
 * Linear ACES -> ACEScct.
 *
 * ACEScct rather than ACEScc because ACEScc is pure log all the way down and
 * therefore diverges at zero. A black pixel is not an edge case in a photograph.
 */
export function encodeACEScct(linear: number): number {
  if (linear <= ACESCCT_X_BRK) {
    return ACESCCT_A * linear + ACESCCT_B
  }
  return (Math.log2(linear) + ACESCCT_LOG_OFFSET) / ACESCCT_LOG_SCALE
}

/** ACEScct -> linear ACES. The inverse of {@link encodeACEScct} below the clamp. */
export function decodeACEScct(encoded: number): number {
  if (encoded <= ACESCCT_Y_BRK) {
    return (encoded - ACESCCT_B) / ACESCCT_A
  }
  if (encoded < ACESCCT_MAX_ENCODED) {
    return Math.pow(2, encoded * ACESCCT_LOG_SCALE - ACESCCT_LOG_OFFSET)
  }
  return ACESCCT_MAX_LINEAR
}
