// Ingest: encoded source data in, linear ACEScg out.
//
// This is pass 0 of the pipeline and the only place linearisation happens.
// Nothing downstream may assume anything other than linear ACEScg, and nothing
// upstream of it is in a known space at all.
//
// Order matters and is not interchangeable: linearise FIRST, then apply the
// primaries matrix. The transfer function is defined on encoded values, so a
// matrix applied before it is operating on numbers that do not represent light.
//
// EXIF orientation is not handled here. It is applied during decode by
// createImageBitmap's `imageOrientation: 'from-image'`, so everything from this
// point on already sees orientation-corrected pixels and dimensions.

precision highp float;

#include "./lib/colour.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 encoded = texture(uSource, vTexCoord).rgb;
    vec3 linearSrgb = srgbEotf(encoded);
    vec3 acescg = SRGB_TO_ACESCG * linearSrgb;
    fragColour = vec4(acescg, 1.0);
}
