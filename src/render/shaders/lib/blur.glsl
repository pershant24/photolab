// The separable Gaussian, shared by halation and diffusion.
//
// Extracted when diffusion arrived rather than copied. The two effects differ in
// what they blur and what they do with the result — halation thresholds and
// tints, diffusion does neither — and not at all in how they blur, so a second
// copy of this would have been a second place for the resolution-independence
// arithmetic to drift.

#ifndef BLUR_GLSL
#define BLUR_GLSL

/**
 * Buffer pixels per source pixel.
 *
 * NOT recoverable from resolution and image size: a crop and a downscale can give
 * identical values for both with different scales. This is the whole reason
 * uSourceRect is in the uniform contract, and expressing a radius against
 * uResolution instead reduces to the same thing on a full-frame render and is
 * wrong on every export tile.
 */
float bufferScale(vec2 resolution, vec4 sourceRect) {
    return resolution.x / sourceRect.z;
}

/** A radius given as a fraction of the source long edge, in buffer pixels. */
float blurRadiusInBufferPixels(float radiusFraction, vec2 imageSize, vec2 resolution, vec4 sourceRect) {
    float sourceLongEdge = max(imageSize.x, imageSize.y);
    return radiusFraction * sourceLongEdge * bufferScale(resolution, sourceRect);
}

// Fixed tap count. The taps spread across whatever the radius works out to, so
// the kernel's shape is resolution independent; at very large radii the spacing
// exceeds a texel and the Gaussian is undersampled. A downsampled blur chain is
// the fix if that ever stops being acceptable.
#define BLUR_TAPS 10

/** One direction of a separable Gaussian, normalised so it preserves energy. */
vec3 separableGaussian(sampler2D source, vec2 texCoord, vec2 resolution, vec2 direction, float radius) {
    vec2 step = direction / resolution;

    // Three sigma inside the radius, so the kernel has effectively fallen to
    // nothing by the time it reaches the edge of its own support.
    float sigma = max(radius / 3.0, 1e-4);
    float twoSigmaSquared = 2.0 * sigma * sigma;

    vec3 total = texture(source, texCoord).rgb;
    float weightTotal = 1.0;

    for (int i = 1; i <= BLUR_TAPS; i++) {
        float offset = (radius * float(i)) / float(BLUR_TAPS);
        float weight = exp(-(offset * offset) / twoSigmaSquared);
        total += weight * texture(source, texCoord + step * offset).rgb;
        total += weight * texture(source, texCoord - step * offset).rgb;
        weightTotal += 2.0 * weight;
    }
    return total / weightTotal;
}

#endif
