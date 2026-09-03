// Lateral chromatic aberration: per-channel radial scaling.
//
// Red pulled in, blue pushed out, green fixed. Green is the reference because it
// carries most of the luminance, so a CA setting does not shift the picture's
// apparent geometry.
//
// Lateral only. Longitudinal aberration is a focus effect and would need a
// per-channel blur varying with depth, which does not exist here.

precision highp float;

#include "./lib/lens.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uAberration;

in vec2 vTexCoord;
out vec4 fragColour;

float channelAt(vec2 framePos, float scale, int channel) {
    vec2 uv = frameToTexCoord(scaleAboutCentre(framePos, scale), uSourceRect, uImageSize);
    vec3 rgb = texture(uSource, uv).rgb;
    return channel == 0 ? rgb.r : (channel == 1 ? rgb.g : rgb.b);
}

void main() {
    vec2 framePos = framePosition(vTexCoord, uSourceRect, uImageSize);
    fragColour = vec4(
        channelAt(framePos, 1.0 - uAberration, 0),
        channelAt(framePos, 1.0, 1),
        channelAt(framePos, 1.0 + uAberration, 2),
        1.0
    );
}
