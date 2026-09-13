#ifndef DATE_STAMP_GLSL
#define DATE_STAMP_GLSL

// Seven-segment glyph geometry. Mirrors src/core/colour/dateStamp.ts, and
// tests/unit/date-stamp.test.ts parses this file and compares every constant
// below against it — a mirrored constant with nothing checking it is a
// divergence waiting to happen, and this project has already paid for one.
//
// What is NOT here is the layout. Where the digits sit, how wide the run is and
// where the tick goes all arrive as uniforms, computed once in TypeScript where
// they can be unit tested. This file knows how to draw a digit and nothing about
// how six of them are arranged.

const float DATE_STAMP_HEIGHT = 0.028;
const float DATE_STAMP_SLANT = 0.09;

const vec2 TICK_CENTRE = vec2(0.06, 0.88);
const vec2 TICK_HALF = vec2(0.05, 0.1);

// [centreX, centreY, halfWidth, halfHeight], in cap heights, bottom-left origin.
// Order is a, b, c, d, e, f, g — the same order DIGIT_SEGMENTS indexes bits in.
const vec4 SEGMENT_BOXES[7] = vec4[7](
    vec4(0.3, 0.925, 0.201, 0.051),
    vec4(0.525, 0.7125, 0.051, 0.1135),
    vec4(0.525, 0.2875, 0.051, 0.1135),
    vec4(0.3, 0.075, 0.201, 0.051),
    vec4(0.075, 0.2875, 0.051, 0.1135),
    vec4(0.075, 0.7125, 0.051, 0.1135),
    vec4(0.3, 0.5, 0.201, 0.051)
);

const int DIGIT_SEGMENTS[10] = int[10](
    63,  // 0
    6,   // 1
    91,  // 2
    79,  // 3
    102, // 4
    109, // 5
    125, // 6
    7,   // 7
    127, // 8
    111  // 9
);

/** Signed distance to an axis-aligned box, negative inside. */
float sdBox(vec2 p, vec2 halfExtent) {
    vec2 d = abs(p) - halfExtent;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

/**
 * Signed distance to a digit, drawn in the cell whose bottom-left corner is the
 * origin of `p`.
 *
 * A union of the lit segments, which for boxes is exactly `min` of their
 * distances. Unlit segments are not drawn at all rather than drawn dim: these
 * are LEDs, and an unlit LED emits nothing.
 */
float digitDistance(vec2 p, int digit) {
    int mask = DIGIT_SEGMENTS[clamp(digit, 0, 9)];
    float d = 1e9;
    for (int i = 0; i < 7; i++) {
        if ((mask & (1 << i)) != 0) {
            vec4 box = SEGMENT_BOXES[i];
            d = min(d, sdBox(p - box.xy, box.zw));
        }
    }
    return d;
}

#endif
