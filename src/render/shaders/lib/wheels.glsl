// Lift, gamma and gain zone weights. Reference: src/core/colour/wheels.ts, which
// tests/unit/wheels.test.ts checks this against across a ramp.

#ifndef WHEELS_GLSL
#define WHEELS_GLSL

#include "./colour.glsl"

const float WHEEL_MIDDLE_GREY_ACESCCT = 0.4135884025;
const float WHEEL_STOP_IN_ACESCCT = 0.0570776256;

// Chosen by integrating against real photographs rather than by symmetry; see
// the TypeScript for the measurements that rejected the obvious alternatives.
const float ZONE_A_LOW = -3.0;
const float ZONE_A_HIGH = 1.5;
const float ZONE_B_LOW = -0.5;
const float ZONE_B_HIGH = 2.4739311883;

/**
 * The three zone weights at an ACEScct value.
 *
 * A partition of unity: lift + gamma + gain is exactly 1 everywhere, so a wheel
 * that is not moved contributes nothing and the three cannot together brighten
 * or darken the picture by accident.
 */
vec3 zoneWeights(float encoded) {
    float stops = (encoded - WHEEL_MIDDLE_GREY_ACESCCT) / WHEEL_STOP_IN_ACESCCT;
    float a = smoothstep(ZONE_A_LOW, ZONE_A_HIGH, stops);
    float b = smoothstep(ZONE_B_LOW, ZONE_B_HIGH, stops);
    return vec3(1.0 - a, a - b, b);
}

#endif
