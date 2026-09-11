// Microcontrast: the blur half, one axis per pass.
//
// The same separable Gaussian the other two blurs use, at a much smaller radius.
// Its output is the *low* frequencies; the composite takes the difference
// between this and the original, which is the high frequencies, and adds a
// fraction of them back. That is what an unsharp mask is, and the name is a
// historical accident of darkroom practice rather than a description.

precision highp float;

#include "./lib/blur.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uMicrocontrastRadius;
uniform vec2 uBlurDirection;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    // Against uSourceRect, not uResolution. The two agree on a full-frame render
    // and disagree on every export tile, and this is the third radius in the
    // pipeline to depend on getting that right. tests/README.md records that
    // only the two-resolution invariant can see the difference, which is why
    // this parameter is in its case list.
    float radius = blurRadiusInBufferPixels(uMicrocontrastRadius, uImageSize, uResolution, uSourceRect);
    fragColour = vec4(separableGaussian(uSource, vTexCoord, uResolution, uBlurDirection, radius), 1.0);
}
