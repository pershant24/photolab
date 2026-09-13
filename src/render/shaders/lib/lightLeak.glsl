#ifndef LIGHT_LEAK_GLSL
#define LIGHT_LEAK_GLSL

// Mirrors src/core/colour/lightLeak.ts. See there for why the leak is exposure
// rather than an overlay, and why it enters at an edge.

const vec3 LIGHT_LEAK_TINT = vec3(1.0, 0.42, 0.22);
const float LIGHT_LEAK_REACH = 0.38;

float lightLeakFalloff(float distanceFromEdge) {
    float t = max(0.0, distanceFromEdge) / LIGHT_LEAK_REACH;
    return exp(-3.0 * t);
}

/** Where along the perimeter the leak enters. 0 to 1, from the left edge, clockwise. */
vec2 lightLeakEntry(float position) {
    float p = fract(position);
    float side = floor(p * 4.0);
    float along = p * 4.0 - side;
    if (side < 0.5) return vec2(0.0, along);
    if (side < 1.5) return vec2(along, 1.0);
    if (side < 2.5) return vec2(1.0, 1.0 - along);
    return vec2(1.0 - along, 0.0);
}

#endif
