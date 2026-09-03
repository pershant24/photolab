// Diffusion: the composite half. The blurred image added over the original.
//
// Neutral, and added rather than mixed: a lens diffuser scatters light into
// neighbouring parts of the frame without removing it from where it was, so the
// bright areas stay bright and the dark ones near them lift. Mixing toward the
// blur would lower contrast everywhere instead, which is a soft-focus filter and
// a different thing.

precision highp float;

uniform sampler2D uSource;
uniform sampler2D uOriginal;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uDiffusionStrength;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 original = texture(uOriginal, vTexCoord).rgb;
    vec3 scattered = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(original + scattered * uDiffusionStrength, 1.0);
}
