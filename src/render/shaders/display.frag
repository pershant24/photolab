// Display transform: linear ACEScg in, encoded sRGB out.
//
// ## This is the minimal version: PRE-TONE-MAP and PRE-GAMUT-COMPRESSION
//
// It is ACEScg -> sRGB primaries, a clamp, and the sRGB OETF. The two stages
// that belong here and are not yet built are named so their absence is a stated
// gap rather than something to discover later:
//
//   - **Tone mapping.** Values above display white exist throughout this
//     pipeline and need a curve that brings them down while preserving their
//     ordering. The clamp below is not that curve; it discards the ordering.
//   - **Gamut compression.** AP1 holds colours sRGB cannot show. Clamping them
//     per channel shifts hue, because the channel that clipped moves and the
//     others do not.
//
// Both layer in between the matrix and the OETF without changing this file's
// structure. Until they do, out-of-range values read as flat crushed shadows and
// flat blown highlights, which is what "the tone map is not built yet" is
// supposed to look like.
//
// ## The clamp is load-bearing
//
// It is not defensive tidying. A contrast control above 1 legitimately pushes
// near-black pixels negative, because the ACEScct toe is signed. Without the
// clamp those pixels reach the OETF's odd-symmetric branch, come back negative,
// and land in an 8-bit canvas as undefined garbage — which reads as "the
// pipeline is broken" rather than "the tone map is missing". With it they read
// as crushed black, which is true and is the far more useful lie.

precision highp float;

#include "./lib/colour.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;

#ifdef DISPLAY_IDENTITY
    // Debug path only, and never reachable from ordinary controls. It exists
    // because an sRGB-in-equals-sRGB-out round trip cannot be verified against a
    // clamped, tone-mapped output: the check that catches a sign or transpose
    // error needs an unmodified path to measure.
    vec3 linearSrgb = ACESCG_TO_SRGB * acescg;
    fragColour = vec4(srgbOetf(linearSrgb), 1.0);
#else
    vec3 linearSrgb = ACESCG_TO_SRGB * acescg;
    vec3 clamped = clamp(linearSrgb, 0.0, 1.0);
    fragColour = vec4(srgbOetf(clamped), 1.0);
#endif
}
