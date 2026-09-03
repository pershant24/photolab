// Vignette: cos^4 falloff from the centre of the FULL FRAME.
//
// The physical shape rather than a radial gradient multiply. Off-axis
// illumination falls as the fourth power of the cosine of the angle from the
// optical axis: one factor from the inverse-square distance to the corner, one
// from the tilt of the film plane, and two from the foreshortening of the
// aperture seen off-axis.
//
// Zero kernel overlap and yet not position independent, which is the distinction
// the worked example in ARCHITECTURE.md section 11 exists to make. It reads no
// neighbouring pixel, so a tile needs no margin; it does need to know where the
// tile sits in the frame, or every export tile gets its own vignette.

precision highp float;

#include "./lib/lens.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uVignetteAmount;
uniform float uVignetteReach;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 rgb = texture(uSource, vTexCoord).rgb;

    vec2 framePos = framePosition(vTexCoord, uSourceRect, uImageSize);
    float r = frameRadius(framePos, uImageSize);

    float c = cos(atan(r * uVignetteReach));
    float falloff = c * c * c * c;

    // mix(1, falloff, 0) is 1 * 1 + falloff * 0, which is exactly 1, so an
    // unedited photograph is untouched bit for bit.
    fragColour = vec4(rgb * mix(1.0, falloff, uVignetteAmount), 1.0);
}
