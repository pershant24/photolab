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

// Fixed tap count. The taps spread across whatever the radius works out to, so
// the kernel's shape is resolution independent; at very large radii the spacing
// exceeds a texel and the Gaussian is undersampled, which is tolerable here
// because the input is thresholded highlights and already smooth. A downsampled
// blur chain is the fix if that ever stops being true.
#define TAPS 10

void main() {
    float radius = halationRadiusInBufferPixels(uHalationRadius, uImageSize, uResolution, uSourceRect);
    vec2 step = uBlurDirection / uResolution;

    // Three sigma inside the radius, so the kernel has effectively fallen to
    // nothing by the time it reaches the edge of its own support.
    float sigma = max(radius / 3.0, 1e-4);
    float twoSigmaSquared = 2.0 * sigma * sigma;

    vec3 total = texture(uSource, vTexCoord).rgb;
    float weightTotal = 1.0;

    for (int i = 1; i <= TAPS; i++) {
        float offset = (radius * float(i)) / float(TAPS);
        float weight = exp(-(offset * offset) / twoSigmaSquared);
        total += weight * texture(uSource, vTexCoord + step * offset).rgb;
        total += weight * texture(uSource, vTexCoord - step * offset).rgb;
        weightTotal += 2.0 * weight;
    }

    fragColour = vec4(total / weightTotal, 1.0);
}
