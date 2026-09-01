// Shared halation geometry.
//
// The radius is a fraction of the SOURCE image's long edge, converted to buffer
// pixels through uSourceRect. That is the resolution-independence rule, and this
// is the first pass where getting it wrong is invisible in preview and appears
// only on export — which is exactly the failure the rule exists for. Expressed
// against uResolution instead, a halo would be one size on a 2048px proxy and
// another on a 6000px export from the same EditState.

// How many buffer pixels one source pixel occupies right now. 1.0 for a 1:1
// export tile; about 0.216 for a 2048px proxy of a 9500px source.
float bufferScale(vec2 resolution, vec4 sourceRect) {
    return resolution.x / sourceRect.z;
}

// The blur radius in pixels of the buffer being rendered.
float halationRadiusInBufferPixels(float radiusFraction, vec2 imageSize, vec2 resolution, vec4 sourceRect) {
    float sourceLongEdge = max(imageSize.x, imageSize.y);
    return radiusFraction * sourceLongEdge * bufferScale(resolution, sourceRect);
}
