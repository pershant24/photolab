# Shader conventions

The contract every pass in `src/render/passes/` obeys. Its purpose is to make
the resolution-independence invariant hold *by default* rather than by
discipline: if every pass receives the same uniforms whether or not it currently
needs them, the correct way to express a spatial parameter is always available
and the incorrect way always looks wrong.

This document grows as the render graph does. What is written here now is the
uniform contract, the resolution rule, and the include convention.

---

## 1. The uniform contract

**Every pass receives these, unconditionally, whether or not it uses them.**

| Uniform | Type | Meaning |
|---|---|---|
| `uSource` | `sampler2D` | The output of the previous pass. |
| `uResolution` | `vec2` | Dimensions of the buffer **currently being rendered**. |
| `uImageSize` | `vec2` | Dimensions of the **full source image**. |

Binding them unconditionally is deliberate. A pass that declares only what it
needs today forces whoever adds a spatial parameter tomorrow to also change the
binding code, and the version that compiles without `uImageSize` is the version
that hardcodes pixels. Cheap uniforms are a small price for removing that
opportunity.

### `uResolution` is not `uImageSize`

This is the whole point of having both, and confusing them is the defect the
rule exists to prevent.

- `uResolution` changes constantly: about 2048px on the long edge for the
  interactive proxy, smaller during an active pointer drag, tile-sized during
  export.
- `uImageSize` is fixed for a given source, and is what the user's parameters
  are defined against.

A parameter expressed against `uResolution` silently means something different
in preview, during a drag, and on export — three different results from one
`EditState`, which breaks the purity invariant in
[`ARCHITECTURE.md`](ARCHITECTURE.md) §4.

### Both are in orientation-corrected space

EXIF orientation is applied as a texture-coordinate transform at ingest, so for
90° and 270° rotations `uImageSize`, proxy sizing and export tile grids all use
the **swapped** dimensions. Nothing downstream of ingest ever sees the
unrotated shape.

---

## 2. The resolution-independence rule

> **Every effect parameter expressed in spatial units must be normalised against
> image dimensions.**

Grain size, blur radius, chromatic aberration offset, vignette falloff, halation
spread. Anything measured in distance.

The reason is preview honesty. A blur of "8 pixels" on a 2048px proxy covers
0.4% of the frame; the same 8 pixels on a 6000px export covers 0.13%. The export
would be visibly sharper than the preview that was used to choose the value, so
preview would be lying about the result — and there would be no way to tell
except by exporting.

### Worked example: a blur radius

Take a user-facing radius defined as a fraction of the source image's long edge.

**Wrong — reads as pixels of the buffer being rendered:**

```glsl
// uBlurRadius is in pixels. Do not do this.
vec2 texelStep = vec2(uBlurRadius) / uResolution;
```

On the 2048px proxy this steps `uBlurRadius / 2048` of the frame. On a 6000px
export tile it steps a different fraction of a different thing. Same
`EditState`, three different images.

**Wrong in a subtler way — normalised, but against the wrong dimension:**

```glsl
// Correct units, wrong reference. Still resolution-dependent.
float longEdge = max(uResolution.x, uResolution.y);
vec2 texelStep = vec2(uBlurRadius * longEdge) / uResolution;
```

This is stable in *fraction of the current buffer*, which is not what the user
set. During a drag the proxy shrinks and the blur silently changes strength.

**Right — a fraction of the source image, converted into texels of the buffer
actually being rendered:**

```glsl
// uBlurRadius is a fraction of the source image's long edge.
float sourceLongEdge = max(uImageSize.x, uImageSize.y);
float radiusInSourcePixels = uBlurRadius * sourceLongEdge;

// How many buffer pixels one source pixel occupies right now.
float bufferScale = max(uResolution.x, uResolution.y) / sourceLongEdge;

float radiusInBufferPixels = radiusInSourcePixels * bufferScale;
vec2 texelStep = vec2(radiusInBufferPixels) / uResolution;
```

The parameter is defined once, in units of the source, and both `uImageSize` and
`uResolution` are needed to convert it — which is why both are always bound.

### The test that enforces it

The invariant is: **rendering the same `EditState` at two different buffer
resolutions and comparing the results, scaled to match, must agree within
tolerance.** A parameter normalised against the wrong thing fails it; a
parameter in raw pixels fails it badly.

This test does not exist yet. It arrives with the first spatial effect, as
`tests/golden/two-resolution.spec.ts`. Until then the rule is enforced by review
and by the uniform contract making the correct form the convenient one.

---

## 3. `#include` and the shared colour library

`vite-plugin-glsl` provides `#include`. **Shared colour functions are included,
never copied**, so that a fix to a transfer function reaches every pass rather
than the ones somebody remembered.

`removeDuplicatedImports` is enabled in `vite.config.ts` and is required rather
than preferred: a chunk reached through two different include paths in one
shader would otherwise be emitted twice and fail to compile on duplicate
function definitions.

Minification is off, so shader source stays readable in devtools and
byte-stable for golden comparisons.

---

## 4. Any colour function in both TypeScript and GLSL must have an agreement test

`src/core/colour/` is the reference implementation. When a function is
transliterated into GLSL, a test must assert the two agree across a value ramp —
comparing the shader against the TypeScript, never against itself.

The reason is stated in [`ARCHITECTURE.md`](ARCHITECTURE.md) §7 and is worth
repeating: a test that renders a shader and compares it to a previous render of
the same shader measures that the shader is deterministic, which was never in
doubt. Only an independent implementation can disagree usefully.

Practical requirements, from the measured browser baseline:

- **Read back through an RGBA8 target.** `IMPLEMENTATION_COLOR_READ_TYPE` on an
  RGBA16F framebuffer is `HALF_FLOAT`, so `readPixels` will not portably return
  `UNSIGNED_BYTE` from one.
- **Derive the tolerance from 8-bit quantisation**, rather than tuning it upward
  until the test passes. A tolerance arrived at by loosening is a tolerance that
  no longer detects anything.
- **Report which patch failed and the per-channel delta.** "0.3% of pixels
  differ" does not survive contact with a real debugging session.

---

## 5. Context and precision

- Working space is **ACEScg**, linear, AP1 primaries. Intermediates are
  **RGBA16F**, never RGBA32F.
- The **source texture is uploaded as RGBA8** and linearised in the ingest
  shader. Uploading an 8-bit JPEG or PNG as RGBA16F doubles VRAM for no
  precision gain.
- The context requires a colour-renderable half-float framebuffer. If neither
  `EXT_color_buffer_float` nor `EXT_color_buffer_half_float` is available the
  application **fails loudly with a user-facing message** rather than falling
  back to 8-bit. A silent precision downgrade in a colour pipeline destroys the
  premise without visibly breaking anything, which is the worst available
  outcome.
