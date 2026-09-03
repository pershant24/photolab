// Diffusion: the blur half. Separable, the same kernel machinery halation uses.
//
// Unlike halation this is NOT thresholded. Halation is a film-base effect —
// light passing through the emulsion, reflecting off the backing and re-exposing
// from behind — so it only happens where there was enough light to make the round
// trip, which is why it has a threshold and why it is red. Diffusion is
// scattering in glass in front of the lens: it acts on everything, and it is
// neutral. Keeping the threshold out is what makes the two distinguishable
// rather than two spellings of the same slider.

precision highp float;

#include "./lib/blur.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uDiffusionRadius;
uniform vec2 uBlurDirection;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    float radius = blurRadiusInBufferPixels(uDiffusionRadius, uImageSize, uResolution, uSourceRect);
    fragColour = vec4(separableGaussian(uSource, vTexCoord, uResolution, uBlurDirection, radius), 1.0);
}
