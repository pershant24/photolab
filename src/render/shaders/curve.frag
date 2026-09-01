// Tone curve, in the grade stage.
//
// An RGB master curve: the same shape applied to all three channels, so it
// changes tonality without changing hue. Per-channel curves are a film-stage
// concern — their whole point is that the channels differ, which is what
// produces crossover — and they share this machinery rather than duplicating it.
//
// The curve is applied in ACEScct rather than in linear light, for the same
// reason contrast is: the control points a person places are spaced by eye, and
// eyes are closer to logarithmic than linear. A curve dragged in linear light
// puts almost all of its useful travel in the top stop.

precision highp float;

#include "./lib/colour.glsl"
#include "./lib/curve.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform sampler2D uCurveLut;
uniform vec2 uCurveDomain;
uniform float uCurveLutSize;

in vec2 vTexCoord;
out vec4 fragColour;

float applyCurve(float linear) {
    float encoded = encodeACEScct(linear);
    return decodeACEScct(sampleCurveLut(uCurveLut, encoded, uCurveDomain, uCurveLutSize));
}

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(
        applyCurve(acescg.r),
        applyCurve(acescg.g),
        applyCurve(acescg.b),
        1.0
    );
}
