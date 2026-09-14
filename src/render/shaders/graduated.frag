// The graduated filter: a linear gradient carrying exposure and a colour shift.
//
// # In the grade stage, and what that costs
//
// A physical graduated filter is glass in front of the lens, and the physical
// ordering would put it there — where its darkening would pass through the
// characteristic curves, as the vignette's does. This is the digital tool
// instead: the local exposure decision made on a developed image. So it does
// NOT vary by stock, which is the deliberate difference from the vignette.
// src/core/colour/graduated.ts carries the argument.
//
// # Position is read from the frame, not from the buffer
//
// `framePosition` folds in `uSourceRect.xy`. Without it every export tile would
// carry its own gradient, running 0 to 1 across the tile instead of across the
// picture — the vignette failure, for the fourth time in this repository.
// There is no kernel, so there is no overlap to declare; the dependency is on
// absolute position, which a margin does not fix.
//
// # Exposure is a multiply because this buffer is linear
//
// The grade passes each encode to ACEScct internally and decode on the way out,
// so what arrives here is linear ACEScg. A shift of s stops is therefore exp2(s)
// and is exact everywhere, including below ACEScct's log/linear break where an
// offset in that space would silently stop meaning stops.

precision highp float;

#include "./lib/lens.glsl"
#include "./lib/graduated.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uGraduatedAngle;
uniform float uGraduatedPosition;
uniform float uGraduatedWidth;
uniform float uGraduatedExposure;
uniform vec3 uGraduatedTint;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 rgb = texture(uSource, vTexCoord).rgb;

    vec2 framePos = framePosition(vTexCoord, uSourceRect, uImageSize);
    float mask = graduatedMask(
        framePos,
        frameAspect(uImageSize),
        uGraduatedAngle,
        uGraduatedPosition,
        uGraduatedWidth
    );

    // exp2(0) is exactly 1 and mix(vec3(1), tint, 0) is exactly 1, so a pixel
    // the mask does not reach comes out bit for bit as it went in. The vignette
    // makes the same guarantee by the same construction.
    float gain = exp2(uGraduatedExposure * mask);
    vec3 filtered = rgb * gain * mix(vec3(1.0), uGraduatedTint, mask);

    fragColour = vec4(filtered, 1.0);
}
