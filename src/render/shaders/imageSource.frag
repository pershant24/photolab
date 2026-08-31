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
    vec2 uv = vec2(vTexCoord.x, 1.0 - vTexCoord.y);
    fragColour = vec4(texture(uImage, uv).rgb, 1.0);
}
