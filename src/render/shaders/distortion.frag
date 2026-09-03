// Radial distortion: barrel and pincushion. The first pass that moves pixels
// rather than recolouring them.
//
// Bilinear, by sampling the intermediate target with its own LINEAR filter rather
// than by fetching texels. Nearest would alias visibly here: the displacement
// varies continuously across the frame, so a nearest resample quantises a smooth
// warp into steps and puts a staircase along every edge near the corners, where
// the gradient of the displacement is largest.

precision highp float;

#include "./lib/lens.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

/** Positive is pincushion, negative is barrel. See src/core/colour/lens.ts. */
uniform float uDistortion;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec2 framePos = framePosition(vTexCoord, uSourceRect, uImageSize);
    float r = frameRadius(framePos, uImageSize);

    // An output pixel at radius r reads from r * (1 + k r^2). With k > 0 it reads
    // from further out, so edge content is pulled inward and straight lines bow
    // toward the centre, which is pincushion.
    vec2 sampled = scaleAboutCentre(framePos, 1.0 + uDistortion * r * r);
    fragColour = texture(uSource, frameToTexCoord(sampled, uSourceRect, uImageSize));
}
