// Split toning: a shadow tint and a highlight tint with a movable handover.
//
// In the grade stage after the HSL bands. The tints are ACEScct offsets, the
// same units the wheels use, so the two controls compose by adding rather than
// by interacting through a change of domain.

precision highp float;

#include "./lib/colour.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform vec3 uSplitShadowTint;
uniform vec3 uSplitHighlightTint;
/** In stops from middle grey, not as a position in the encoding. */
uniform float uSplitBalance;

const float SPLIT_MIDDLE_GREY_ACESCCT = 0.4135884025;
const float SPLIT_STOP_IN_ACESCCT = 0.0570776256;
const float SPLIT_TRANSITION_STOPS = 2.0;

in vec2 vTexCoord;
out vec4 fragColour;

float applyChannel(float linear, float shadowTint, float highlightTint) {
    float encoded = encodeACEScct(linear);
    float stops = (encoded - SPLIT_MIDDLE_GREY_ACESCCT) / SPLIT_STOP_IN_ACESCCT;
    float half_ = SPLIT_TRANSITION_STOPS * 0.5;
    float share = smoothstep(uSplitBalance - half_, uSplitBalance + half_, stops);
    // A partition of unity, so two equal tints are one uniform offset rather
    // than a doubled one.
    return decodeACEScct(encoded + shadowTint * (1.0 - share) + highlightTint * share);
}

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(
        applyChannel(acescg.r, uSplitShadowTint.r, uSplitHighlightTint.r),
        applyChannel(acescg.g, uSplitShadowTint.g, uSplitHighlightTint.g),
        applyChannel(acescg.b, uSplitShadowTint.b, uSplitHighlightTint.b),
        1.0
    );
}
