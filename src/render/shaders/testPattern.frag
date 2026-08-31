// Generated test pattern, standing in for a decoded image until ingest can load
// one. Output is ENCODED sRGB, exactly what a decoded 8-bit JPEG supplies, so
// the passes downstream of it are the real ones rather than stand-ins.
//
// Layout: a 4x4 grid of patches over the upper three quarters, and a horizontal
// ramp along the bottom. Patch values come from src/render/testPattern.ts as a
// uniform array — one definition, shared with the test that reads them back.

precision highp float;

#define PATCH_COUNT 16
#define PATCH_GRID 4.0
#define RAMP_HEIGHT 0.25

uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform vec3 uPatches[PATCH_COUNT];

// A runtime parameter, present to prove the recompile boundary: it changes every
// frame of a drag and must never cause a shader to be built. It slides the ramp
// so that a stuck frame is visible by eye.
uniform float uPatternPhase;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    if (vTexCoord.y < RAMP_HEIGHT) {
        float t = fract(vTexCoord.x + uPatternPhase);
        fragColour = vec4(vec3(t), 1.0);
        return;
    }

    // Grid coordinates, with row 0 at the top of the frame.
    float gridV = (1.0 - vTexCoord.y) / (1.0 - RAMP_HEIGHT);
    int column = int(floor(vTexCoord.x * PATCH_GRID));
    int row = int(floor(gridV * PATCH_GRID));
    int index = clamp(row * int(PATCH_GRID) + column, 0, PATCH_COUNT - 1);

    fragColour = vec4(uPatches[index], 1.0);
}
