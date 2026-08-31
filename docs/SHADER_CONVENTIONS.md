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
| `uSourceRect` | `vec4` | `(x, y, width, height)` — the region of the source image this buffer covers, in source-image pixels. |

`uSourceRect` is `(0, 0, uImageSize.x, uImageSize.y)` for the interactive proxy,
and the tile's own rect during export. It is not redundant with the other two,
and §2 shows the arithmetic that proves it: **the buffer-to-source scale factor
cannot be recovered from `uResolution` and `uImageSize` alone**, because a crop
and a downscale can produce identical values for both with entirely different
scales. It also gives a pass its *position* in the frame, which anything
radially symmetric needs — a vignette without it centres itself on every export
tile.

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

EXIF orientation is applied during decode, by `createImageBitmap`'s
`imageOrientation: 'from-image'`, so for 90° and 270° rotations `uImageSize`,
`uSourceRect`, proxy sizing and export tile grids all use the **swapped**
dimensions. Nothing downstream of the decode ever sees the unrotated shape, and
no pass applies an orientation transform of its own.

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

**Also wrong, and this is the one that looks right** — normalised, but with the
scale factor reconstructed from the wrong pair of uniforms:

```glsl
// Plausible. Reduces to the version above. Do not do this either.
float sourceLongEdge = max(uImageSize.x, uImageSize.y);
float radiusInSourcePixels = uBlurRadius * sourceLongEdge;
float bufferScale = max(uResolution.x, uResolution.y) / sourceLongEdge;
float radiusInBufferPixels = radiusInSourcePixels * bufferScale;
```

Substitute it through and `sourceLongEdge` cancels:

```
radiusInBufferPixels = uBlurRadius * sourceLongEdge * max(uResolution) / sourceLongEdge
                     = uBlurRadius * max(uResolution)
```

`uImageSize` does not appear in the result. The version that mentions it and the
version that does not are the same expression. It survives review because on the
interactive path it happens to be right: the proxy is a *uniform downscale* of
the whole source, so a fraction of the source long edge and a fraction of the
buffer long edge are the same number, and the error is invisible.

It is not invisible on an export tile. A 1024px tile of a 9500px source sits at
1:1 with the source, so the correct scale factor is 1.0 and a 1% radius is 95
pixels. This form computes `1024 / 9500 = 0.108` and produces **10.24 pixels** —
a blur nine times too small, in the one code path nobody looks at while dragging
a slider.

**Right — the rect the buffer actually covers supplies the scale:**

```glsl
// uBlurRadius is a fraction of the source image's long edge.
float sourceLongEdge = max(uImageSize.x, uImageSize.y);
float radiusInSourcePixels = uBlurRadius * sourceLongEdge;

// How many buffer pixels one source pixel occupies right now. uSourceRect.z is
// the width of the source region this buffer covers, so this is 1.0 for a 1:1
// export tile and about 0.216 for a 2048px proxy of a 9500px source.
float bufferScale = uResolution.x / uSourceRect.z;

float radiusInBufferPixels = radiusInSourcePixels * bufferScale;
vec2 texelStep = vec2(radiusInBufferPixels) / uResolution;
```

| | proxy 2048×1366 | drag proxy 1024×683 | export tile 1024² at 1:1 |
|---|---|---|---|
| Correct radius, in buffer pixels | 20.48 | 10.24 | **95.00** |
| Two-uniform form above | 20.48 | 10.24 | **10.24** |

**Do not simplify this back to `uResolution` and `uImageSize`.** The scale factor
is not a function of those two. A crop and a downscale can yield identical
`uResolution` and identical `uImageSize` with completely different scales, and
only the rect distinguishes them. The cancellation above is what that
impossibility looks like when you try anyway.

Two further points on `uSourceRect`:

- **For export tiles rendered with overlap, the rect is the rect *including* the
  overlap**, because that is the region the buffer covers. Passing the un-expanded
  tile rect reintroduces a scale error precisely at the seams the overlap exists
  to remove.
- **`uSourceRect.xy` is the pass's position in the frame**, which anything
  radially symmetric needs. A vignette has no spatial kernel and therefore
  declares zero overlap, but zero overlap does not mean position-independent:
  without the offset, every export tile gets its own vignette centred on itself.

The graph binds all four uniforms for every pass and asserts, CPU-side, that
`uResolution.x / uSourceRect.z` and `uResolution.y / uSourceRect.w` agree. The
single-axis form above is only valid while scaling is isotropic; that holds for
proxies and tiles today, and the assertion is there so a future crop feature
cannot quietly violate it.

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

### Assert on an intermediate buffer, not on the canvas

The obvious form of this test — render to the canvas, check the pixels — is far
weaker than it looks, and this was measured rather than reasoned about.

The chain applies `SRGB_TO_ACESCG` at ingest and `ACESCG_TO_SRGB` at display, so
end to end it is a **round trip**, and an error in either matrix very largely
cancels in the result. Perturbing one forward coefficient by 1% moved the canvas
by at most **one 8-bit code value**, and by nothing at all on every saturated
patch, because the display clamp removes the residual exactly where it is
largest. A canvas-only test passed that mutation.

The same 1% error moves the ACEScg intermediate by 0.0093, about nineteen times
the half-float noise floor. Reading the ingest pass's output directly catches it,
and catches a 0.1% error too. `RenderGraph.render` takes an `onPassComplete`
hook for exactly this: it fires while each pass's target is still bound, which is
the only moment its contents can be read.

Keep the canvas assertion as well. It is the only thing covering the display
matrix, the clamp and the encode, which the intermediate never reaches. Neither
subsumes the other.

### Practical requirements

- **Read an RGBA16F intermediate as `HALF_FLOAT`** and decode in JavaScript.
  `IMPLEMENTATION_COLOR_READ_TYPE` on such a framebuffer is `HALF_FLOAT`, so
  `readPixels` will not portably return `UNSIGNED_BYTE` from one. Resolving
  through an RGBA8 target instead — which is what *tiled export* must do — would
  clamp precisely the out-of-range values a colour test most wants to see.
- **Derive the tolerance**, rather than raising it until the test passes. For a
  half-float intermediate that is the 2^-11 relative precision of the format
  plus an absolute floor for channels that cancel to near zero; for an 8-bit
  canvas it is the code-value rounding. A tolerance arrived at by loosening is a
  tolerance that no longer detects anything.
- **Prove the tolerance has margin** by perturbing a coefficient and confirming
  the test fails. A tolerance nobody has tested against a real error is a guess.
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
