// Halation, step 1: isolate what is bright enough to scatter.
//
// Light passes through the emulsion, scatters off the back of the film base and
// re-exposes the layers from behind. Only genuinely bright areas carry enough
// light to do it visibly, so everything below a threshold contributes nothing.
//
// The threshold is a user parameter in STOPS FROM MIDDLE GREY, converted to a
// linear value here. Stops are the unit the data is described in: "one and a
// half stops above grey" is a place in a photograph, where "0.51 linear" is a
// number that has to be checked against a histogram to mean anything. That is
// the occupancy rule applied to a parameter rather than to a fixture.
//
// The falloff above the threshold is smooth rather than a hard cut. A hard one
// produces a visible contour around every bright region at the exact threshold
// value, which reads as a compositing error rather than as light.

precision highp float;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

/** Linear working-space value at which scattering begins. */
uniform float uHalationThreshold;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 acescg = texture(uSource, vTexCoord).rgb;

    // Weighted toward the channels the eye reads as brightness, so a saturated
    // red does not halate as though it were as bright as white.
    float luminance = dot(acescg, vec3(0.2722, 0.6741, 0.0537));

    // Smooth over half a stop above the threshold.
    float upper = uHalationThreshold * 1.4142;
    float excess = smoothstep(uHalationThreshold, upper, luminance);

    fragColour = vec4(acescg * excess, 1.0);
}
