// Density-dependent, per-channel grain. The last pass of the film stage.
//
// Runs after the characteristic curves because its magnitude depends on the
// developed density, which does not exist until they have produced it. Applied
// as a perturbation of the log value rather than of linear light, because
// density is a logarithmic quantity: a fixed swing in density is a fixed swing
// in stops. Perturbing linear light would put almost no grain in the shadows and
// an enormous amount in the highlights, which is backwards.

precision highp float;

#include "./lib/colour.glsl"
#include "./lib/grain.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uGrainStrength;
/** Grain period as a fraction of the source long edge. */
uniform float uGrainSize;
/** Per-channel period multipliers: the three layers differ in crystal size. */
uniform vec3 uGrainChannelSizes;

in vec2 vTexCoord;
out vec4 fragColour;

/**
 * One channel's grain.
 *
 * `seed` differs per channel so the three are INDEPENDENT. Sharing one noise
 * value across all three would move R, G and B together, which is luminance
 * noise — what a digital sensor produces. Film's three layers develop
 * separately, and their independence is what makes film grain coloured.
 */
float grainChannel(float linear, vec2 sourcePixel, float basePeriod, float sizeMultiplier,
                   float bufferScale, float seed) {
    float period = basePeriod * sizeMultiplier;
    float amplitude = grainAmplitudeScale(period * bufferScale);

    float encoded = encodeACEScct(linear);
    float modulation = grainDensityModulation(encoded);

    // Nothing to compute once either factor is zero, and it is zero over most of
    // a typical frame — the shadows and the blown highlights both.
    if (amplitude * modulation <= 0.0) return linear;

    float noise = grainNoise(sourcePixel / period, seed);
    float swing = noise * modulation * amplitude * uGrainStrength * GRAIN_MAX_DENSITY_SWING;
    return decodeACEScct(encoded + swing);
}

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;

    vec2 sourcePixel = grainSourcePixel(vTexCoord, uSourceRect);
    float bufferScale = grainBufferScale(uResolution, uSourceRect);
    float basePeriod = uGrainSize * max(uImageSize.x, uImageSize.y);

    fragColour = vec4(
        grainChannel(acescg.r, sourcePixel, basePeriod, uGrainChannelSizes.r, bufferScale, 0.0),
        grainChannel(acescg.g, sourcePixel, basePeriod, uGrainChannelSizes.g, bufferScale, 17.0),
        grainChannel(acescg.b, sourcePixel, basePeriod, uGrainChannelSizes.b, bufferScale, 41.0),
        1.0
    );
}
