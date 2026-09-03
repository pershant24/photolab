// Halation, step 2: a separable Gaussian, run twice.
//
// Separable because a two-dimensional kernel is O(r^2) taps per pixel and two
// one-dimensional passes are O(r), for an identical result. At a radius worth
// having that is the difference between an effect and a slideshow.
//
// The direction comes from a uniform rather than a compile-time variant, so the
// horizontal and vertical passes share one program. They differ by one vec2.

precision highp float;

#include "./lib/halation.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uHalationRadius;
/** (1, 0) for the horizontal pass, (0, 1) for the vertical one. */
uniform vec2 uBlurDirection;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    float radius = halationRadiusInBufferPixels(uHalationRadius, uImageSize, uResolution, uSourceRect);
    fragColour = vec4(separableGaussian(uSource, vTexCoord, uResolution, uBlurDirection, radius), 1.0);
}
