// Display transform: linear ACEScg in, encoded sRGB out.
//
// Three stages, individually compiled in or out so that the matrix can be
// addressed without the operator in the way:
//
//     ACEScg -> display primaries -> gamut compression -> tone map -> encode
//
// Compression before tone mapping. Compression makes a colour representable;
// tone mapping fits its brightness. Because compression leaves every channel
// non-negative and the shoulder is bounded below 1, their output is already
// inside the encodable range and the clamp below is a safety net rather than
// something the image depends on — which is the whole difference from the
// clamp-only version this replaces.

precision highp float;

#include "./lib/colour.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uToneMapKnee;
uniform float uGamutThreshold;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;
    vec3 linearSrgb = ACESCG_TO_SRGB * acescg;

#ifdef DISPLAY_IDENTITY
    // Debug path only, never reachable from ordinary controls. An sRGB round
    // trip cannot be verified against a tone-mapped output: the check that
    // catches a sign or transpose error needs an unmodified path to measure, and
    // the two-leg agreement harness addresses the matrix through this.
    fragColour = vec4(srgbOetf(linearSrgb), 1.0);
#else

#ifdef GAMUT_COMPRESS
    linearSrgb = gamutCompress(linearSrgb, uGamutThreshold);
#endif

#ifdef TONE_MAP
    linearSrgb = toneMap(linearSrgb, uToneMapKnee);
#endif

    fragColour = vec4(srgbOetf(clamp(linearSrgb, 0.0, 1.0)), 1.0);
#endif
}
