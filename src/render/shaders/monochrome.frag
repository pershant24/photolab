// The channel mixer: panchromatic sensitivity, in the film stage.
//
// Before the characteristic curves, so the curves act on one value replicated
// across three channels — and AFTER halation, because scattered light reaches
// the emulsion through the same spectral sensitivity as everything else. A
// mixer running earlier would leave a warm halo on a black and white frame.
//
// Pointwise: no kernel, no position dependence, nothing to declare. It still
// takes the full uniform contract, per the rule that every pass does.
//
// src/core/colour/monochrome.ts carries the argument, including why the weights
// are normalised: it is what makes the mixer exactly neutral-preserving, so a
// grey card comes out the same grey and middle grey stays where the curves
// expect it.

precision highp float;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

/** Already normalised on the way in, so the shader does no division. */
uniform vec3 uMonochromeMix;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;
    float recorded = dot(acescg, uMonochromeMix);
    fragColour = vec4(vec3(recorded), 1.0);
}
