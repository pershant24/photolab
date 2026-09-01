// Halation, step 3: tint the scattered light red and add it back.
//
// Red because of where the light goes. It passes through all three emulsion
// layers, reflects off the back of the film base and re-exposes them from
// behind — and the red-sensitive layer sits closest to the base, so it receives
// the most of the returning light. That is why halation is red rather than
// white, and why tinting it is physics rather than taste.
//
// Added rather than blended: scattered light is light that reached the emulsion
// in addition to what formed the image, so it sums. Mixing toward the halo would
// darken the source wherever the halo is bright, which is the opposite of what
// scattering does.
//
// This runs BEFORE the characteristic curves. Halation is an exposure effect —
// it adds light to the emulsion — so it happens before the curves convert
// exposure to density, not after.

precision highp float;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

/** The image as it was before the highlights were isolated and blurred. */
uniform sampler2D uOriginal;

uniform float uHalationStrength;
uniform vec3 uHalationTint;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 original = texture(uOriginal, vTexCoord).rgb;
    vec3 scattered = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(original + scattered * uHalationTint * uHalationStrength, 1.0);
}
