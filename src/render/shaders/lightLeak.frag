// Light leaks: stray light fogging the emulsion, added before the film stage.
//
// # Position is read from the frame, not from the buffer
//
// `framePosition` folds in `uSourceRect.xy`, which is the whole point. A leak
// computed from `vTexCoord` alone would restart at every tile's own corner, so
// an export would carry one leak per tile — the vignette failure exactly, and
// the case the worked example in docs/SHADER_CONVENTIONS.md was written for.
// There is no kernel here and therefore no overlap to declare; the dependency is
// on absolute position, which is a different thing and is not fixed by margins.
//
// # Deterministic, like grain
//
// A pure function of frame position and two parameters. No time, no frame
// counter, no seed that varies per render, so the same EditState and the same
// source give the same leak in preview and in export.

precision highp float;

#include "./lib/lens.glsl"
#include "./lib/lightLeak.glsl"

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform vec2 uImageSize;
uniform vec4 uSourceRect;

uniform float uLightLeakStrength;
uniform float uLightLeakPosition;

in vec2 vTexCoord;
out vec4 fragColour;

void main() {
    vec3 colour = texture(uSource, vTexCoord).rgb;

    vec2 frame = framePosition(vTexCoord, uSourceRect, uImageSize);
    vec2 entry = lightLeakEntry(uLightLeakPosition);

    // Aspect-corrected, so a leak on a landscape frame is not stretched along
    // the long axis. The same correction the vignette uses, for the same reason.
    vec2 aspect = frameAspect(uImageSize);
    float distance = length((frame - entry) * aspect);

    // A second, much broader term along the entry edge. Without it the leak is a
    // perfect radial blob, which reads as a lens flare rather than as light
    // coming through a seam; a real leak is longer than it is deep because the
    // gap it came through is.
    float alongEdge = lightLeakFalloff(distance * 0.45);
    float intoFrame = lightLeakFalloff(distance);
    float amount = uLightLeakStrength * (0.75 * intoFrame + 0.25 * alongEdge);

    // Added, not mixed. It is light arriving at the emulsion on top of the light
    // the lens delivered, so it cannot remove anything that was already there.
    fragColour = vec4(colour + amount * LIGHT_LEAK_TINT, 1.0);
}
