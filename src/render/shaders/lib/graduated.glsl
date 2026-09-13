#ifndef GRADUATED_GLSL
#define GRADUATED_GLSL

// The graduated filter's geometry. Mirrors src/core/colour/graduated.ts, and
// tests/unit/glsl-constants.test.ts checks the constant against it.
//
// The maths is duplicated rather than the values being passed in as uniforms,
// unlike the date stamp's layout — because this one is a function of position
// and so has to be evaluated per pixel. tests/golden/graduated.spec.ts therefore
// compares the two implementations across a ramp rather than trusting them to
// agree, which is step 5 of the add-a-pass recipe.

const float GRADUATED_MIN_WIDTH = 0.01;

/** Unit vector along the gradient. Zero degrees points at the top of the frame. */
vec2 graduatedDirection(float angleDegrees) {
    float radians = radians(angleDegrees);
    // Frame y runs downward, so "up" is negative y.
    return vec2(sin(radians), -cos(radians));
}

/**
 * Half the frame's extent along the direction: the rectangle's support
 * function, not its diagonal. This is what makes `position` mean the same
 * fraction of the frame at every angle.
 */
float graduatedHalfExtent(vec2 aspect, vec2 direction) {
    return 0.5 * dot(aspect, abs(direction));
}

/** Where a frame position sits along the gradient, 0 to 1. */
float graduatedCoordinate(vec2 framePos, vec2 aspect, float angleDegrees) {
    vec2 direction = graduatedDirection(angleDegrees);
    // Not named `half`: that is a reserved word in GLSL ES and the compile
    // failure it causes names the line rather than the reason.
    float extent = graduatedHalfExtent(aspect, direction);
    vec2 centred = framePos * aspect - 0.5 * aspect;
    return 0.5 + dot(centred, direction) / (2.0 * extent);
}

/** How strongly the filter acts. Exactly 0 and exactly 1 outside the band. */
float graduatedMask(vec2 framePos, vec2 aspect, float angleDegrees, float position, float width) {
    float u = graduatedCoordinate(framePos, aspect, angleDegrees);
    float halfWidth = max(width, GRADUATED_MIN_WIDTH) * 0.5;
    return smoothstep(position - halfWidth, position + halfWidth, u);
}

#endif
