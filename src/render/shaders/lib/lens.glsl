// The lens stage's shared geometry. Reference: src/core/colour/lens.ts.
//
// Everything here is measured from the centre of the FULL FRAME, through
// uSourceRect.xy. A pass that read only its own buffer would give every export
// tile its own lens — its own centre, its own corners, its own vignette.

#ifndef LENS_GLSL
#define LENS_GLSL

/**
 * Where this buffer texel sits in the full frame, in 0..1.
 *
 * The same y flip imageSource.frag applies, for the same reason: WebGL textures
 * run bottom-up while a source rect is written top-down. All four lens effects
 * are radially symmetric so none of them can currently see the difference — but
 * a lens effect that is not, a tilt or a squeezed anamorphic, would, and having
 * one convention costs nothing.
 */
vec2 framePosition(vec2 texCoord, vec4 sourceRect, vec2 imageSize) {
    vec2 flipped = vec2(texCoord.x, 1.0 - texCoord.y);
    return (sourceRect.xy + flipped * sourceRect.zw) / imageSize;
}

/** Aspect-corrected axes, so a circle stays a circle on a frame that is not square. */
vec2 frameAspect(vec2 imageSize) {
    return imageSize / max(imageSize.x, imageSize.y);
}

/**
 * Radius with 1.0 at the corner, whatever the frame's shape.
 *
 * Dividing by the corner's own length is what puts the corner at exactly 1.
 * Without it the normaliser would be the half-width, and a portrait frame would
 * have a different lens from a landscape one.
 */
float frameRadius(vec2 framePos, vec2 imageSize) {
    vec2 aspect = frameAspect(imageSize);
    vec2 centred = (framePos * 2.0 - 1.0) * aspect;
    return length(centred) / length(aspect);
}

/**
 * Turn a frame position back into a texture coordinate for this buffer.
 *
 * The inverse of framePosition, and the reason a geometric pass can express its
 * displacement in frame terms and still read from its own tile.
 */
vec2 frameToTexCoord(vec2 framePos, vec4 sourceRect, vec2 imageSize) {
    vec2 local = (framePos * imageSize - sourceRect.xy) / sourceRect.zw;
    return vec2(local.x, 1.0 - local.y);
}

/** Scale a frame position radially about the centre. */
vec2 scaleAboutCentre(vec2 framePos, float scale) {
    return (framePos - 0.5) * scale + 0.5;
}

#endif
