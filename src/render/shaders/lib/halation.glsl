// Shared halation geometry.
//
// The radius is a fraction of the SOURCE image's long edge, converted to buffer
// pixels through uSourceRect. That is the resolution-independence rule, and this
// is the first pass where getting it wrong is invisible in preview and appears
// only on export — which is exactly the failure the rule exists for. Expressed
// against uResolution instead, a halo would be one size on a 2048px proxy and
// another on a 6000px export from the same EditState.

#ifndef HALATION_GLSL
#define HALATION_GLSL

// bufferScale and the radius conversion moved to blur.glsl when diffusion
// arrived and needed exactly the same arithmetic. Shared rather than copied: a
// second transcription of the resolution-independence conversion is a second
// place for it to drift, and this one is invisible in preview when it is wrong.
#include "./blur.glsl"

// The blur radius in pixels of the buffer being rendered. Kept as a name of its
// own so the halation shaders and their tests do not have to know where it went.
float halationRadiusInBufferPixels(float radiusFraction, vec2 imageSize, vec2 resolution, vec4 sourceRect) {
    return blurRadiusInBufferPixels(radiusFraction, imageSize, resolution, sourceRect);
}

#endif
