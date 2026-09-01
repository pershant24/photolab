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
comparing the shader against the TypeScript, never against itself. A test that
renders a shader and compares it to a previous render of the same shader
measures that the shader is deterministic, which was never in doubt.

That much is obvious. The rest of this section is not, and every claim in it was
measured rather than reasoned about.

### Compare leg by leg. A round trip cannot see the likeliest defect at all.

The pipeline applies `SRGB_TO_ACESCG` at ingest and `ACESCG_TO_SRGB` at display.
So an end-to-end assertion — render, read the canvas, compare against the
original input — is measuring a **round trip**, and a round trip has a blind spot
that is not a matter of tolerance.

Both GLSL matrix literals are produced by one generator from one convention.
GLSL's `mat3()` constructor fills columns while the TypeScript stores rows, so
the realistic mistake is getting that backwards **once**, which transposes both.
And then:

```
Mᵀ · (M⁻¹)ᵀ  =  (M⁻¹ · M)ᵀ  =  Iᵀ  =  I
```

Exactly the identity. Measured: 4.4e-16 deviation, and **zero** 8-bit code
values of movement on the canvas. Not approximately invisible — algebraically
invisible, at any tolerance, forever.

The fix is to split the chain and derive each leg's expectation from what was
**measured at the previous stage**, not from the original input:

| | Compares | Pins |
|---|---|---|
| **Leg 1** | measured ACEScg intermediate against `TS_ingest(encoded_in)` | `SRGB_TO_ACESCG` |
| **Leg 2** | measured display output against `TS_display(acescg_measured)` | `ACESCG_TO_SRGB` |

Passing the original input to leg 2 rather than the measured intermediate
reconstitutes the round trip and hands the cancellation straight back. This is
the single most important line in the harness.

`RenderGraph.render` provides the two hooks this needs: `onPassComplete`, which
fires while each pass's target is still bound, and `finalTarget`, which sends the
last pass into a buffer instead of the canvas.

Verified by mutation, in `tests/render/agreement.spec.ts`. Each leg fails when
its own matrix is wrong and only then, which is what makes a failure diagnostic
rather than merely alarming:

| Mutation | Leg 1 | Leg 2 | Canvas |
|---|---|---|---|
| Both matrices transposed *(the realistic generator defect)* | fails | fails | **passes** |
| Display matrix transposed | passes | fails | fails |
| Ingest matrix, one coefficient +0.1% | fails | passes | **passes** |
| Display matrix, one coefficient +0.1% | passes | fails | fails |

### Derive the tolerance

Never pick one. §5 is the construction, and it is the same construction for every
agreement test in the project.

### Read a half-float buffer, not the canvas

8-bit output quantises at 1/255 = 3.9e-3, and a 0.1% coefficient error falls
under that on most patches. Rendering the pass under test into an RGBA16F target
resolves 4.9e-4 instead, about eight times finer, which is what puts 0.1% inside
reach.

`IMPLEMENTATION_COLOR_READ_TYPE` on an RGBA16F framebuffer is `HALF_FLOAT`, so
read as half float and decode in JavaScript. Do **not** resolve through an RGBA8
target — that is what *tiled export* must do, and it would clamp exactly the
out-of-range values a colour test most wants to see.

### Do not restrict to in-gamut midtones

The obvious way to stop the display clamp eating the signal is to assert only on
patches that sit comfortably inside gamut. It is the wrong move, and it costs an
order of magnitude.

A display-matrix error shows up most strongly on **saturated** patches, where a
channel sits near zero and the encoding curve is at its steepest. Measured on
midtones alone, a 1% error moved the result by 2 code values and a 0.1% error by
**none at all**; across the full patch set the same errors moved it by 19 and 2.

Keep every patch and skip only the individual **channels** whose expected value
clamps. Whether a channel clamps is decidable from the measured intermediate, so
it is a principled exclusion rather than a tuned one. Assert that a useful number
of channels survived the filter, or a bug in the clamp detection leaves the test
green while comparing nothing.

### Report which patch failed and the per-channel delta

"0.3% of pixels differ" does not survive contact with a real debugging session.
Name the patch, the channel, the expected value, what was measured, and the
delta.

## 5. Deriving a tolerance

Every agreement test compares a shader against `src/core/colour/` and needs a
bound. **A tolerance arrived at by loosening until the test passes is not a
tolerance** — it is a record of how wrong the code was on the day it was written,
and it will never detect anything again. This section is the construction to use
instead. It is mechanical, it takes about ten minutes, and it is the same four
steps for every pass.

The principle: a tolerance is a *prediction* of how far the shader may
legitimately differ from the reference, made from the arithmetic before the test
is run. If the measured difference exceeds the prediction, either the shader is
wrong or the prediction was — and both are worth knowing.

### Step 1. Bound the error where the value is computed

Work out the largest difference the two implementations can legitimately have at
the point of measurement, from the operations and the storage format.

The usual dominant term is **quantisation of the format the value is stored in**.
An RGBA16F buffer has an 11-bit significand, so relative precision is `2^-11` =
4.9e-4; an RGBA8 buffer quantises at 1/255 = 3.9e-3. Multiply by the magnitude of
the value.

**For a dot product — which every matrix row is — scale by the sum of the
absolute contributions, not by the result.** That is the standard
error-propagation bound: each term carries its own quantisation error, and those
errors add regardless of whether the terms themselves do.

```
tolerance ∝ max( |result|, Σ |Mᵢⱼ · vⱼ| )
```

### Step 2. Handle cancellation channels, which are the reason step 1 is written that way

A **cancellation channel** is one where large terms sum to a small result — or to
exactly zero.

A bound proportional to the result is *zero* there, so every such channel fails,
and no absolute floor chosen without looking at the terms can be justified.
Worse, these are not a corner case: **every out-of-gamut colour produces one.** A
colour on the edge of a gamut is precisely one whose coordinates in the other
space cancel to zero in some channel, so they recur constantly once white
balance, saturated film curves, or any wide-gamut work is in the pipeline.

The measured instance in this project: an ACEScg patch chosen to lie outside
sRGB has a red channel that is the sum of terms of magnitude 0.25 coming to
exactly 0. The accumulated half-float error is 2.8e-4 against an expected value
of zero. The sum-of-contributions bound predicts 4.9e-4 and passes with margin;
a bound on the result predicts 0 and cannot pass at all.

### Step 3. Carry the bound across any nonlinearity by its local slope

A bound derived in linear light is not a bound on an encoded value. Multiply by
`|f'(x)|` at the point in question.

This matters more than it sounds. The sRGB OETF's slope is **12.92** on its
linear segment near black and about **0.44** near white — a factor of thirty
across the range — so a single constant cannot be right at both ends. A bound
that is correct near white is thirty times too tight near black, which is exactly
where shadow detail lives and where a genuine error is most likely to be reported
as noise.

The same applies to ACEScct, to any characteristic curve, and to a tone map when
one exists.

### Step 4. Prove the bound has margin, by mutation

A tolerance nobody has tested against a real error is a guess that happens to be
written down.

Perturb one coefficient — a tenth of a percent is a reasonable target — confirm
the test fails, and record the smallest error it catches. If it does not fail,
the test is not measuring what its name claims and the design is wrong, not the
tolerance. That is how the round-trip blindness in §4 was found: the mutation
passed.

Then add a headroom factor for the things not modelled — the rasteriser's `pow`
differing from JavaScript's, fp32 rounding order, SwiftShader's LLVM and Subzero
backends disagreeing in the last place. A factor of two over the derived bound
has been sufficient throughout; state it as headroom rather than folding it in
silently, so a later reader can tell the prediction from the padding.

### A fixture constant with a semantic label must be derived, never transcribed

Write `srgbOetf(0.18)`, not `0.46136`.

This is a separate failure from everything above, and neither the tolerance
method nor the two legs can catch it. An agreement test verifies that two
implementations of a transform match. It says nothing about whether a value fed
to both of them is what its label claims — and if the input is wrong, both
implementations agree perfectly on the wrong answer.

That happened here. A patch labelled "middle grey 0.18 linear" held
`0.18 ** (1/2.2)` = 0.45866, the pure gamma-2.2 encoding, rather than the sRGB
piecewise encoding 0.46136. It decoded to 0.1777. Every agreement test passed for
two stages, because the shader and the reference were handed the same wrong
number. It surfaced only when a test finally asserted a **property** of the value
— that middle grey does not move as contrast changes — rather than comparing two
implementations to each other.

The two encodings differ by 0.6%. Small enough to look right in a table of
numbers, large enough to matter. `src/core/colour/transfer.ts` warns about
exactly this confusion, at length, and it happened anyway. **That is the argument
for deriving rather than for warning harder.**

The surface grows from here. Fixtures accumulate labelled constants — middle
grey, an 18% card, white points, log encoding anchors, and later stock-specific
density references — and every one passes every agreement test while being
silently wrong.

**GLSL is the one place transcription is unavoidable**, because a `const`
initialiser must be a constant expression, so `log2(65504.0)` and
`encodeACEScct(0.18)` have to be written out. `tests/unit/glsl-constants.test.ts`
parses the shader source and compares every constant against the TypeScript it
came from, including the row-to-column transpose on the matrices. Guarded
directly, since it cannot be designed away.

### Worked instance

`tests/render/agreement.spec.ts` carries this as `rowTolerance` and
`encodeSlope`. Leg 1 bounds an RGBA16F intermediate directly. Leg 2 derives its
bound on the linear side of the display transform and carries it across the sRGB
OETF by `encodeSlope`, because the value it can actually measure is the encoded
one.

## 6. Context and precision

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
