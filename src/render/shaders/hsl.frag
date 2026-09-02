// Banded hue, saturation and luminance, in the grade stage after the wheels.

precision highp float;

#include "./lib/hsl.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uHslHue[6];
uniform float uHslSaturation[6];
uniform float uHslLuminance[6];

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;

    float hue = rgbHue(acescg);
    float dHue = bandedValue(hue, uHslHue);
    float dSat = bandedValue(hue, uHslSaturation);
    float dLum = bandedValue(hue, uHslLuminance);

    vec3 rotated = rotateHue(acescg, dHue);
    float luma = dot(rotated, HSL_AP1_LUMINANCE);

    // mix(), not luma + (rgb - luma) * s. The two agree in exact arithmetic and
    // not in floating point: at s = 1 the mix is x*0 + y*1 and returns y bit for
    // bit, where the other subtracts and re-adds luma and does not round-trip.
    // A pixel in an untouched band must come back exactly as it went in.
    vec3 saturated = mix(vec3(luma), rotated, 1.0 + dSat);

    fragColour = vec4(saturated * exp2(dLum), 1.0);
}
