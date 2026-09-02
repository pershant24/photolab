// Colour wheels: lift, gamma and gain as per-channel offsets in ACEScct.
//
// In the GRADE stage, after the tone curve. A grade is a human interpreting a
// developed negative, and the wheels are the last shaping before the display
// transform decides how to show it.
//
// Per channel and not per luminance: the whole point of a colour wheel is that
// the three channels move by different amounts, which is what tints a zone.

precision highp float;

#include "./lib/colour.glsl"
#include "./lib/wheels.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;

in vec2 vTexCoord;
out vec4 fragColour;

float applyChannel(float linear, float lift, float gamma, float gain) {
    float encoded = encodeACEScct(linear);
    vec3 w = zoneWeights(encoded);
    // Not clamped: the display transform decides how out-of-range values are
    // shown, and clamping here would throw away highlight detail the tone map
    // exists to bring back.
    return decodeACEScct(encoded + lift * w.x + gamma * w.y + gain * w.z);
}

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(
        applyChannel(acescg.r, uLift.r, uGamma.r, uGain.r),
        applyChannel(acescg.g, uLift.g, uGamma.g, uGain.g),
        applyChannel(acescg.b, uLift.b, uGamma.b, uGain.b),
        1.0
    );
}
