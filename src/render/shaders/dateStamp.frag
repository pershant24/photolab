// The date stamp: LEDs in the camera back, exposing the emulsion.
//
// # Additive, and before the film stage
//
// It adds light. It cannot remove any, because a light source in front of the
// film does not subtract from what the lens delivered. Running before halation
// and the characteristic curves is what makes the stamp bleed and roll off like
// anything else bright in the frame, and that is the whole design — see
// src/core/colour/dateStamp.ts.
//
// # Position is read from the frame, not from the buffer
//
// `framePosition` folds in `uSourceRect.xy`. Without it the stamp would restart
// at every export tile's own corner and the export would carry one stamp per
// tile — the vignette failure, and the light leak's, for the third time. There
// is no kernel here so there is no overlap to declare; the dependency is on
// absolute position, which margins do not fix.
//
// # Antialiasing through fwidth, which is what makes it scale-correct
//
// The edge is softened over one buffer pixel, obtained from the derivative of
// the distance field rather than from a constant in frame units. A constant
// would be right at one resolution and wrong at every other — the exact class of
// error the two-resolution invariant exists for — where `fwidth` is one buffer
// pixel by construction at any scale.

precision highp float;

#include "./lib/lens.glsl"
#include "./lib/dateStamp.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

/** Six digits, most significant first: 'YY MM DD. Computed in TypeScript. */
uniform int uDateDigits[6];
/** Cell origins and total advance, in cap heights. Also computed in TypeScript. */
uniform float uDigitOrigins[6];
uniform float uTickOrigin;
uniform float uStampWidth;

uniform vec2 uDateStampPosition;
uniform vec3 uDateStampTint;
uniform float uDateStampStrength;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 colour = texture(uSource, vTexCoord).rgb;

    // Aspect-corrected frame space, so a digit is the same shape on a frame that
    // is not square. The same correction the vignette and the leak use.
    vec2 aspect = frameAspect(uImageSize);
    vec2 p = framePosition(vTexCoord, uSourceRect, uImageSize) * aspect;
    vec2 anchor = uDateStampPosition * aspect;

    // Into cap heights, with y up. Frame y runs downward, hence the subtraction
    // in that order.
    vec2 local = vec2(p.x - anchor.x, anchor.y - p.y) / DATE_STAMP_HEIGHT;

    // The anchor is the run's RIGHT end, at the vertical centre of the cap
    // height. Right, because a date back prints into a corner and the run grows
    // away from it; anchoring the left end would push the stamp off the frame
    // for exactly the positions anybody would choose.
    local.x += uStampWidth;
    local.y += 0.5;

    // Italic, applied to the run rather than to each cell.
    local.x -= (local.y - 0.5) * DATE_STAMP_SLANT;

    float d = sdBox(local - TICK_CENTRE - vec2(uTickOrigin, 0.0), TICK_HALF);
    for (int i = 0; i < 6; i++) {
        d = min(d, digitDistance(local - vec2(uDigitOrigins[i], 0.0), uDateDigits[i]));
    }

    // fwidth is evaluated at uniform control flow — outside the loop, on the
    // finished distance — which is what makes it defined. The guard is for the
    // degenerate case of a derivative of exactly zero, which a 1x1 buffer gives.
    float w = max(fwidth(d), 1e-6);
    float coverage = 1.0 - smoothstep(-w, w, d);

    fragColour = vec4(colour + coverage * uDateStampStrength * uDateStampTint, 1.0);
}
