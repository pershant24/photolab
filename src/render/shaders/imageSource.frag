// Samples the decoded proxy texture and hands on encoded sRGB, which is exactly
// what the test pattern produces. Ingest cannot tell the two apart, so the pass
// chain that the agreement tests verify is the same one a photograph travels.
//
// No colour maths happens here. The texture holds whatever the decoder produced,
// and interpreting it is ingest's job.

precision highp float;

uniform sampler2D uImage;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    // An ImageBitmap's origin is top-left; a GL texture's is bottom-left. The
    // flip happens here rather than at upload because WebGL2 does not apply
    // UNPACK_FLIP_Y_WEBGL to an ImageBitmap source — setting it was watched to
    // do nothing at all, with no GL error, and the image rendered inverted.
    //
    // EXIF orientation is already applied by the decoder, so this is the only
    // geometric correction in the pipeline.
    vec2 flipped = vec2(vTexCoord.x, 1.0 - vTexCoord.y);

    // The buffer covers uSourceRect of the image, not necessarily all of it. For
    // the interactive path the rect is the whole image and this is the identity;
    // for an export tile it is the tile's own region, and without this every
    // tile would render the entire photograph scaled down.
    //
    // This is also what makes the radius formula in halation.glsl distinguishable
    // from the wrong one. On a full-frame render the correct expression and the
    // one that reads uResolution reduce to the same thing, exactly as the two
    // uniforms did in Stage 3; only a tile separates them.
    vec2 uv = (uSourceRect.xy + flipped * uSourceRect.zw) / uImageSize;
    fragColour = vec4(texture(uImage, uv).rgb, 1.0);
}
