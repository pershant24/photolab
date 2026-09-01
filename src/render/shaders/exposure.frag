// Exposure: a multiplication in linear light, and nothing else.
//
// That is the definition rather than a simplification. Opening the aperture a
// stop doubles the photons reaching every part of the frame; it does not change
// the shape of the response. Anything that bends the curve belongs to the film
// stage or the grade.
//
// This is why exposure sits in the SCENE stage, before the lens. A vignette
// darkens an already-exposed frame, so exposure applied after it would scale the
// vignette along with the image, which no aperture does.

precision highp float;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

/** Stops. Zero is unchanged; the pass is skipped entirely at zero. */
uniform float uExposure;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(acescg * exp2(uExposure), 1.0);
}
