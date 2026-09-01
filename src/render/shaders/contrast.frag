// Contrast: a slope change about middle grey, in ACEScct, per channel.
//
// Not in linear light, where a slope change is a multiply and that is exposure,
// not contrast. Not in a display encoding either: the pipeline is not in one at
// this point, and round-tripping through one mid-chain would clip everything
// above display white. ACEScct is log-spaced, so equal distances are equal stops
// and the control behaves the same across the tonal range, and its linear toe
// means shadow values at or below zero survive it.
//
// This sits in the GRADE stage, not next to exposure. A grade is a human
// interpreting a developed negative, and it has nothing to act on until the film
// stage has produced one. The lens and film stages between the two are empty
// today and that is correct, not an accident of ordering.

precision highp float;

#include "./lib/colour.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

/** Slope about the pivot. 1 is unchanged; the pass is skipped entirely at 1. */
uniform float uContrast;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(applyContrast(acescg, uContrast), 1.0);
}
