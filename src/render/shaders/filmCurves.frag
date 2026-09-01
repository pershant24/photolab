// Per-channel characteristic curves, in the film stage.
//
// Three independent curves, one per channel, each with its own toe, shoulder and
// gamma. That independence is the whole feature: the difference between the
// channels produces COLOUR CROSSOVER — shadows drifting one way and highlights
// the other, with the drift changing across the exposure range — and a single
// shared RGB curve cannot produce it at all. A shared curve is a contrast
// adjustment, and its absence of crossover is why lookup-table film emulations
// read as flat.
//
// The curves operate over log DISPLAY-referred exposure, which is ACEScct here,
// not the log scene exposure a published characteristic curve is defined
// against. src/core/colour/filmStock.ts carries the consequence.

precision highp float;

#include "./lib/colour.glsl"
#include "./lib/curve.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform sampler2D uFilmLutR;
uniform sampler2D uFilmLutG;
uniform sampler2D uFilmLutB;
uniform vec2 uFilmDomain;
uniform vec3 uFilmLutSizes;

// Blended here rather than by blending the control points before baking, so that
// dragging strength updates a uniform instead of rebuilding three lookup tables
// every frame.
uniform float uFilmStrength;

in vec2 vTexCoord;
out vec4 fragColour;

float applyChannel(sampler2D lut, float linear, float size) {
    float encoded = encodeACEScct(linear);
    float curved = sampleCurveLut(lut, encoded, uFilmDomain, size);
    return decodeACEScct(mix(encoded, curved, uFilmStrength));
}

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(
        applyChannel(uFilmLutR, acescg.r, uFilmLutSizes.r),
        applyChannel(uFilmLutG, acescg.g, uFilmLutSizes.g),
        applyChannel(uFilmLutB, acescg.b, uFilmLutSizes.b),
        1.0
    );
}
