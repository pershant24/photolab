// Grain: hash noise, density modulation, and the band limit.
//
// The TypeScript in src/core/colour/grain.ts is the reference for everything
// here that is not the hash itself, and tests/unit/grain.test.ts asserts the two
// agree across a ramp. The hash has no TypeScript counterpart on purpose — it is
// an arbitrary mixing function rather than a definition of anything, so a
// TypeScript copy of it would only assert that two transcriptions match.

#ifndef GRAIN_GLSL
#define GRAIN_GLSL

#include "./colour.glsl"

// Middle grey and the width of one stop, in ACEScct. Duplicated from
// src/core/colour/filmStock.ts, where the same two values anchor the film
// stocks; the agreement test covers the drift.
const float GRAIN_MIDDLE_GREY_ACESCCT = 0.4135884025;
const float GRAIN_STOP_IN_ACESCCT = 0.0570776256;

const float GRAIN_TOE_STOPS = 4.0;
const float GRAIN_SHOULDER_STOPS = 2.4739311883;
const float GRAIN_PEAK_STOPS_FROM_GREY = 0.0;

const float GRAIN_MAX_DENSITY_SWING = 0.012;

const float GRAIN_FULL_AMPLITUDE_PERIOD = 2.0;
const float GRAIN_VANISHED_PERIOD = 1.0;

/**
 * Hash of a lattice point to [0, 1).
 *
 * Deterministic and stateless, which is the requirement: a random texture
 * uploaded at startup, or anything seeded on time or frame count, would make the
 * renderer stop being a pure function of its inputs and would break undo,
 * export-matches-preview, and every golden test at once.
 */
float grainHash(vec2 lattice, float seed) {
    vec3 p = fract(vec3(lattice.xyx) * 0.1031);
    p += dot(p, p.yzx + 33.33 + seed);
    return fract((p.x + p.y) * p.z);
}

/**
 * Value noise in [-1, 1], with a cell size of one unit.
 *
 * Value noise rather than per-pixel white noise because grain has a SIZE. White
 * noise is grain exactly one buffer pixel across, which is a different size on a
 * proxy than on an export — the resolution-independence failure, arrived at by
 * choosing the wrong primitive rather than by getting the arithmetic wrong.
 */
float grainNoise(vec2 position, float seed) {
    vec2 cell = floor(position);
    vec2 f = position - cell;
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = grainHash(cell, seed);
    float b = grainHash(cell + vec2(1.0, 0.0), seed);
    float c = grainHash(cell + vec2(0.0, 1.0), seed);
    float d = grainHash(cell + vec2(1.0, 1.0), seed);

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

/** Grain visibility, from a value already encoded as ACEScct. */
float grainDensityModulation(float encoded) {
    float stops = (encoded - GRAIN_MIDDLE_GREY_ACESCCT) / GRAIN_STOP_IN_ACESCCT;
    float offset = stops - GRAIN_PEAK_STOPS_FROM_GREY;
    float reach = offset < 0.0 ? GRAIN_TOE_STOPS : GRAIN_SHOULDER_STOPS;
    return 1.0 - smoothstep(0.0, 1.0, min(1.0, abs(offset) / reach));
}

/**
 * Amplitude scale for a grain period measured in buffer pixels.
 *
 * Below about two buffer pixels the period is past the sampling rate and a hash
 * does not politely vanish — it returns uncorrelated values at whatever rate it
 * is sampled, which is full-amplitude noise one buffer pixel across, i.e. grain
 * of the wrong size. Fading the amplitude means the preview shows less grain
 * than the export rather than wrong grain. See src/core/colour/grain.ts.
 */
float grainAmplitudeScale(float periodInBufferPixels) {
    return smoothstep(GRAIN_VANISHED_PERIOD, GRAIN_FULL_AMPLITUDE_PERIOD, periodInBufferPixels);
}

/**
 * The source-image pixel a buffer texel covers.
 *
 * Through uSourceRect, and that is the whole point of the pass. Grain seeded on
 * buffer coordinates gives a tile a different pattern from the full frame at the
 * same place, so every tile boundary in an export becomes a visible
 * discontinuity that reads as a compression artifact rather than as a bug.
 *
 * **The y flip is not optional and is not cosmetic.** It is the same expression
 * imageSource.frag uses, and it has to be, because grain must be attached to the
 * IMAGE CONTENT at a source pixel rather than to an abstract coordinate that
 * happens to share the pass's units. WebGL textures run bottom-up while a source
 * rect is written top-down, so without the flip a tile whose vertical extent
 * differs from the full frame's puts the same grain on a different part of the
 * picture. Written without it first, and the tiles-against-whole test caught it
 * at 0.113 — while a tile-against-tile check did not, because the two tiles
 * being compared happened to share a y extent and so shared the error.
 */
vec2 grainSourcePixel(vec2 texCoord, vec4 sourceRect) {
    vec2 flipped = vec2(texCoord.x, 1.0 - texCoord.y);
    return sourceRect.xy + flipped * sourceRect.zw;
}

/** Buffer pixels per source pixel. Not recoverable from resolution and image size. */
float grainBufferScale(vec2 resolution, vec4 sourceRect) {
    return resolution.x / sourceRect.z;
}

#endif
