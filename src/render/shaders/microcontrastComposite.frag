// Microcontrast: the composite half. Unsharp masking.
//
//     out = original + amount * (original - blurred)
//
// # The halo, which is where this usually goes wrong
//
// The difference term is signed, so an edge gains a bright fringe on its light
// side and a dark one on its dark side. At a small radius those fringes are
// sub-pixel and read as a sharper edge; at a large one they separate and read as
// an outline. Nothing in the maths distinguishes the two -- the radius does, and
// the radius is normalised against the *source* so that preview and export make
// the same choice. A radius against the buffer would be small on a proxy and
// enormous on an export tile, which is the halo appearing only in the file.
//
// # Why this is not clamped
//
// The result can exceed the input's range, and that is correct: the working
// space is scene-referred and unbounded above, the tone map is what decides how
// a highlight is shown, and clamping here would be a second, hidden tone map
// with no knee. Negatives are possible on the dark side of a hard edge and are
// resolved by the gamut gate and the display clamp, which is where every other
// pass leaves that decision too.

precision highp float;

uniform sampler2D uSource;
uniform sampler2D uOriginal;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uMicrocontrast;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 original = texture(uOriginal, vTexCoord).rgb;
    vec3 blurred = texture(uSource, vTexCoord).rgb;
    fragColour = vec4(original + uMicrocontrast * (original - blurred), 1.0);
}
