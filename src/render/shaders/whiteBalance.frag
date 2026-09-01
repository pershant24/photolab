// White balance, in the scene stage, before exposure.
//
// Scene, because temperature describes the light arriving at the lens; before
// exposure, because the adaptation is about the colour of that light and the
// exposure about its quantity, and doing them the other way round would make the
// adaptation depend on how bright the frame was set.
//
// The whole transform is one mat3 built on the CPU: a chromatic adaptation in
// CAT02 cone space, wrapped in the two matrices that step out of and back into
// the working space's primaries. Nothing per-pixel but a matrix multiply.
//
// It is NOT a per-channel scale. Scaling R, G and B independently to shift
// temperature also changes saturation and hue, because the RGB primaries are not
// the axes the visual system adapts along. See docs/COLOUR_PIPELINE.md.

precision highp float;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform mat3 uWhiteBalance;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(uWhiteBalance * acescg, 1.0);
}
