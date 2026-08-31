// Shared colour functions, transliterated from src/core/colour/.
//
// This file and the TypeScript are two implementations of the same maths, and
// they are kept in agreement by a test rather than by care: see
// tests/render/colour-agreement.spec.ts, which renders known patches through the
// graph and compares the readback against the TypeScript reference. A test that
// compared a shader to a previous render of itself would measure only that the
// shader is deterministic, which was never in question.
//
// Include this rather than copying out of it. `removeDuplicatedImports` is on in
// vite.config.ts, so a function reached through two include paths in one shader
// is emitted once.

// ---------------------------------------------------------------------------
// sRGB transfer functions
// ---------------------------------------------------------------------------
//
// The piecewise definition, not the 2.2 power approximation. The linear segment
// near black is not a rounding detail: 2.2 has zero slope at the origin, which
// crushes the darkest code values into an indistinguishable block.
//
// The thresholds are the rounded values the specification states, which leaves a
// 2.33e-9 discontinuity where the segments meet. That is deliberate and matches
// what browsers and display drivers implement; src/core/colour/transfer.ts
// carries the argument in full. Do not replace them with the continuous variant.
//
// Both functions extend to negatives by odd symmetry. `pow()` of a negative base
// is undefined in GLSL, and ACEScg legitimately produces negative values for
// colours outside the sRGB gamut, so without this the first out-of-gamut pixel
// is undefined behaviour rather than a clamped one.

const float SRGB_ENCODED_BREAK = 0.04045;
const float SRGB_LINEAR_BREAK = 0.0031308;
const float SRGB_SLOPE = 12.92;
const float SRGB_ALPHA = 0.055;
const float SRGB_GAMMA = 2.4;

float srgbEotf(float encoded) {
    float m = abs(encoded);
    float linear = m <= SRGB_ENCODED_BREAK
        ? m / SRGB_SLOPE
        : pow((m + SRGB_ALPHA) / (1.0 + SRGB_ALPHA), SRGB_GAMMA);
    return encoded < 0.0 ? -linear : linear;
}

vec3 srgbEotf(vec3 encoded) {
    return vec3(srgbEotf(encoded.r), srgbEotf(encoded.g), srgbEotf(encoded.b));
}

float srgbOetf(float linear) {
    float m = abs(linear);
    float encoded = m <= SRGB_LINEAR_BREAK
        ? m * SRGB_SLOPE
        : (1.0 + SRGB_ALPHA) * pow(m, 1.0 / SRGB_GAMMA) - SRGB_ALPHA;
    return linear < 0.0 ? -encoded : encoded;
}

vec3 srgbOetf(vec3 linear) {
    return vec3(srgbOetf(linear.r), srgbOetf(linear.g), srgbOetf(linear.b));
}

// ---------------------------------------------------------------------------
// Space conversion
// ---------------------------------------------------------------------------
//
// Generated from src/core/colour/matrices.ts rather than transcribed, because
// the transpose below is easy to get wrong and produces a plausible-looking
// image with wrong colour.
//
// GLSL's mat3(...) constructor fills COLUMNS first, while the TypeScript stores
// these row-major. The argument lists are therefore the transpose of the row
// listings in the comments. With the columns laid out this way, `m * v` is the
// same operation as mat3MulVec3(m, v) in the TypeScript.
//
// Both carry a Bradford adaptation from D65 to the ACES white point. Every row
// of the row listing sums to 1, which is what "white maps to white" looks like
// and is the cheapest check that the adaptation is present and correctly
// oriented.

// Rows, as written in src/core/colour/matrices.ts and in published tables:
//   0.6130974024, 0.3395231462, 0.0473794514
//   0.0701937225, 0.9163538791, 0.0134523985
//   0.0206155929, 0.1095697729, 0.8698146342
const mat3 SRGB_TO_ACESCG = mat3(
    0.6130974024, 0.0701937225, 0.0206155929,   // column 0
    0.3395231462, 0.9163538791, 0.1095697729,   // column 1
    0.0473794514, 0.0134523985, 0.8698146342    // column 2
);

// Rows, as written in src/core/colour/matrices.ts and in published tables:
//   1.7050509927, -0.6217921207, -0.0832588720
//   -0.1302564175, 1.1408047366, -0.0105483191
//   -0.0240033568, -0.1289689761, 1.1529723329
const mat3 ACESCG_TO_SRGB = mat3(
    1.7050509927, -0.1302564175, -0.0240033568,   // column 0
    -0.6217921207, 1.1408047366, -0.1289689761,   // column 1
    -0.0832588720, -0.0105483191, 1.1529723329    // column 2
);
