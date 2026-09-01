# Architecture

The design reasoning for photolab, in one place. Where another document already
owns a subject this one states the decision compactly and links out rather than
restating it, because four copies of a rule drift and `CLAUDE.md` — which is
loaded automatically every session — wins any conflict.

| Subject | Owner |
|---|---|
| Pass ordering, and the physics behind it | [`COLOUR_PIPELINE.md`](COLOUR_PIPELINE.md) |
| Project rules, memory budget, add-a-pass outline | [`../CLAUDE.md`](../CLAUDE.md) |
| Uniform contract, resolution-independence rule | [`SHADER_CONVENTIONS.md`](SHADER_CONVENTIONS.md) |
| Testing strategy, measured browser baseline | [`../tests/README.md`](../tests/README.md) |

---

## 1. What this is, and the constraint that shapes everything

A browser-based photo editor for colour grading and physically motivated film
stock emulation. A personal tool first and a portfolio piece second.

**It runs entirely client-side. No backend, no authentication, no image upload.
Images never leave the machine.** This is a decision, not an unfinished state,
and it is worth stating why so that nobody later reads it as a gap to fill.
Sending a 60MP file to a server to apply a tone curve is worse on every axis
that matters here: worse latency, because the round trip dwarfs the render;
worse cost, because GPU time is the expensive kind; and worse privacy, for
obvious reasons. It would also move the interesting part of the project — the
colour pipeline — behind a CRUD application, which is the part nobody needs
another of.

The consequences bind the rest of this document. Static hosting. All state is
local. Every constraint below about memory and texture limits exists because the
work happens on the viewer's GPU rather than one that was chosen for the task.

### Input

JPEG and PNG, up to 60MP. **No RAW.** The realistic distribution is most images
at 12MP or under, some around 48MP, and a few at 60MP — which matters because it
means the large cases are real but not the common path, so they must work
without being what the interactive path is tuned for.

---

## 2. Stack, and what is deliberately excluded

Vite 7, React 19, TypeScript 5.9 strict with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, Tailwind 4, Zustand, `idb`, `vite-plugin-glsl`,
Vitest 3, Playwright, ESLint 10, Node 22.

The exclusions carry more information than the inclusions, because each one is a
choice somebody will otherwise re-open:

| Excluded | Why |
|---|---|
| React Query, TanStack Query, any server-state library | There is no server, so there is no server state. The thing they manage does not exist here. |
| three.js | A 3D scene graph. Using it for full-screen quads means fighting an abstraction built for a different problem, not being helped by one. |
| regl, pixi, glfx | regl means learning regl *on top of* WebGL2 rather than instead of it. The renderer is raw WebGL2. |
| WebGPU | Chosen against deliberately, not overlooked. GLSL has vastly more learning material than WGSL, and Shadertoy is a GLSL sandbox — which makes prototyping an effect a browser tab rather than a build. For a project whose value is the colour pipeline, that is worth more than WebGPU's API ergonomics. |

Do not add dependencies beyond this without saying why.

---

## 3. Pass ordering

Passes run in the order the phenomena physically occur. Light leaves the scene,
passes through a lens, lands on film, and the developed result is interpreted by
a colourist and shown on a display. Each stage can only act on what the previous
one produced, and reordering them produces results that cannot occur in reality.

```
0. Ingest    decode -> EXIF orientation -> linearise -> matrix to ACEScg
1. Scene     white balance (CAT02) -> exposure (linear multiply)
2. Lens      distortion -> chromatic aberration -> diffusion/bloom -> vignette (cos^4)
3. Film      halation -> per-channel characteristic curves -> density-dependent grain
4. Grade     creative curves -> HSL -> colour wheels (lift/gamma/gain) -> split tone
5. Display   ACEScg -> display primaries -> tone map + gamut compression -> encode
```

Working space is **ACEScg** (AP1 primaries, linear); intermediates are
**RGBA16F**, never 32F. The per-stage rationale — why lens precedes film, why
halation sits before the characteristic curves, why grain sits after them — is
in [`COLOUR_PIPELINE.md`](COLOUR_PIPELINE.md) and is not repeated here.

`src/render/graph.ts` encodes this order structurally, with insertion points for
every stage present from the start even while most are empty. Registering a new
pass means placing it at its physical position, never appending it — the graph
sorts by `STAGES` rather than by registration order, so appending is not
something a pass can do by accident.

---

## 4. Invariants

Four rules that the rest of the system is built on. Each is stated in full in
[`CLAUDE.md`](../CLAUDE.md); the point of gathering them here is that they are
load-bearing together rather than separately.

**The renderer is a pure function of `(sourceImage, EditState)`.** No hidden
state, no buffers accumulated across frames, no parameter read from anywhere but
`EditState`. This is what makes export identical to preview by construction,
rather than by two code paths being kept in step by hand. It is also what makes
the golden tests and undo-as-snapshots possible at all.

**Interactive rendering never touches the full-resolution image.** A 60MP source
at RGBA16F is 480MB per buffer and roughly a gigabyte for a ping-pong pair,
which drops the WebGL context. The interactive path renders a proxy at about
2048px on the long edge, drops to a smaller one during an active pointer drag,
and restores on pointer-up. Export runs the identical pass chain over the full
image in overlapping tiles.

The proxy is produced by `createImageBitmap`'s `resizeWidth` / `resizeHeight`
during decode, which also means the full-resolution texture is never created —
so a 9500px source is fine on a device whose `MAX_TEXTURE_SIZE` is 8192, which is
most integrated and mobile GPUs.

**A recorded deviation from preview-export parity.** `resizeQuality: 'high'`
downsamples the **encoded** 8-bit data, not linear light. Averaging
gamma-encoded values is not averaging the light they represent: it under-weights
the brighter samples, so fine high-frequency detail comes out slightly darker
than a linear-light downscale would give. **Preview and export will therefore not
be bit-identical in fine detail.**

This is accepted rather than fixed. It is what essentially every decoder and
browser does, the error is confined to detail near the resolution limit, and the
alternative is worse: decoding at full resolution and downscaling on the GPU in
linear light would be correct, and would reintroduce exactly the
`MAX_TEXTURE_SIZE` problem the proxy decode exists to avoid. It is written down
here so that it is a decision rather than a surprise when export lands at
Stage 5.

**A second, smaller assumption in the same call.** Decoding uses
`colorSpaceConversion: 'none'`, which hands over the file's own values rather than
letting the browser convert an embedded profile to sRGB. That is right — the
conversion would be an uncontrolled colour transform in the middle of a pipeline
whose whole point is controlling them — but it means ingest interprets everything
as sRGB, so a **Display P3**-tagged photograph is read undersaturated.

The mitigation is known and cheap, and is scoped rather than open: read the ICC
profile from the file, and select a different ingest matrix. `primaries.ts`
already derives its matrices from chromaticities, so adding P3 is a set of
chromaticities and a second `const mat3` in the shader, chosen by the same
compile-time variant mechanism the display transform already uses. No
architectural change, no new stage, no change to the uniform contract. It is not
done yet because nothing in the pipeline needs it before the film stage, not
because it is unresolved.

**Every spatial parameter is normalised against image dimensions.** Grain size,
blur radius, aberration offset, vignette falloff. A radius expressed in pixels
looks different on a 2048px proxy than on a 6000px export, so preview would lie
about the result. Every pass receives `uResolution`, `uImageSize` and
`uSourceRect` — three, not two: the buffer-to-source scale factor is not
recoverable from the first two alone, and the form that appears to recover it
cancels down to using neither. The rule and the arithmetic are in
[`SHADER_CONVENTIONS.md`](SHADER_CONVENTIONS.md).

**`EditState` is a single flat serialisable object.** No layers, no node graph.
Undo/redo is an array of snapshots, because the states are small enough that a
command pattern would be complexity bought with nothing. A preset is a
`Partial<EditState>` plus metadata, applied by merge.

---

## 5. Render loop and program caching

**Pointer events never trigger a synchronous render.** Input updates the store;
a `requestAnimationFrame` loop renders at most once per frame from the latest
state. A drag that rendered per event would render several times per frame and
show the oldest result last.

**Programs are cached, keyed by pass identity plus any compile-time variant.**
Changing a parameter updates uniforms only. Recompilation happens *solely* when
the pass graph structure changes — an effect toggled on or off, a variant
switched. A shader compile mid-drag is a visible hitch, and the failure mode is
easy to introduce accidentally, so it is asserted in a test rather than left to
review: change a parameter, confirm the compile count does not increase.

---

## 6. Curves are baked to a LUT. The shader never evaluates a spline.

An architectural constraint, not a note about one file.

Tone curves and film characteristic curves use monotone (PCHIP) interpolation,
because Catmull-Rom and natural cubic splines overshoot between control points —
which on a tone curve is a region that gets *darker* as the curve above it is
raised. That is a real artifact with entirely reasonable control points, not a
theoretical concern.

PCHIP cannot be transliterated into GLSL: its tangents depend on the whole
control point set, so a fragment shader would need a variable-length loop per
pixel. **The resolution is that `src/core/colour/curve.ts` bakes the curve into a
1D lookup texture on the CPU whenever the control points change, and the shader
samples that texture.**

This is the single sanctioned exception to the rule that colour code must be
shader-translatable, and it is earned rather than asserted. A rebake happens once
per control-point change — a slider drag at most — so the variable-length loop
and the module's throwing bounds-check accessor sit off the hot path *by
construction* rather than by anyone remembering to keep them there. If a future
effect needs a curve evaluated per pixel, it gets a LUT too; it does not get a
port of the spline.

The LUT's texture coordinate spans the **control point range**, not `[0, 1]`. For
an ordinary tone curve those coincide; for a film characteristic curve over a log
exposure axis they do not, and the input must be remapped before sampling.

---

## 7. Colour module conventions

`src/core/colour/` is pure TypeScript with no WebGL and no DOM, and it is the
reference implementation that shader output is asserted against. A shader test
that compares a shader only to itself measures nothing.

Two conventions bind anything added there, both because they fail silently:

**White points are derived from chromaticities, never from tabulated XYZ
triples.** Two D65s are in circulation — (0.95045593, 1, 1.08905775) from the
chromaticity sRGB and Rec.709 actually state, and (0.95047, 1, 1.08883) from the
ASTM tables — and they differ by 6.6e-5 in the resulting matrices. Any imported
matrix must be checked for which one it assumes before use. Adding Display P3 or
importing a published IDT is exactly when this bites.

**Any colour function existing in both TypeScript and GLSL must have a test
asserting they agree**, across a value ramp, comparing the shader to the
TypeScript rather than to itself — and reading the intermediate buffer rather
than the canvas, for the reason measured in `SHADER_CONVENTIONS.md` §4.

---

## 8. Measured browser baseline

From `tests/probe/webgl2-capability.spec.ts` — measured, not assumed. Full table
in [`../tests/README.md`](../tests/README.md); the architectural consequences:

- **RGBA16F is colour-renderable and survives a float round trip** under headless
  SwiftShader. The half-float pipeline is testable in CI with no RGBA8 fallback.
- **`IMPLEMENTATION_COLOR_READ_TYPE` on a 16F target is `HALF_FLOAT`.** So tiled
  export must resolve each tile through an RGBA8 target before readback, and so
  must any test that reads pixels back.
- **`MAX_TEXTURE_SIZE` is 8192.** A 60MP image at 3:2 is roughly 9500×6300, so
  its long edge exceeds that. 8192 is common on integrated and mobile GPUs, which
  makes this a *production* constraint rather than a test artifact. The
  interactive path sidesteps it by decoding directly to proxy size, so the
  full-resolution texture is never created; full-resolution handling is an export
  concern and is unresolved until Stage 5.
- **Local and CI SwiftShader use different backends** (LLVM on macOS arm64,
  Subzero on `ubuntu-latest`) and are not guaranteed bit-identical. Reference
  images generated locally may fail in CI for reasons unrelated to any change.

---

## 9. Testing strategy

In full in [`../tests/README.md`](../tests/README.md). The shape of it:

- **Colour maths is verified numerically against the TypeScript reference**, not
  by image diffing. Less sensitive to rasteriser differences, and it names the
  colour that is wrong instead of reporting that 0.3% of pixels differ.
- **Golden images are reserved for spatial effects**, where no small set of
  numbers captures correctness. They arrive at Milestone 3.
- **Prefer ground-truth properties over expected values from documents.** A
  property that must hold given the definitions cannot inherit a wrong
  expectation. When a property and a published value disagree, trust the
  property and investigate the value.
- **Where two independent derivations are cheap, do both and assert they agree.**

---

## 10. Build order

1. **Plumbing, linear pipeline, exposure, contrast.** Visually unimpressive;
   decides whether the project works at all.
2. **Tonal and colour** — curves, HSL, wheels, white balance.
3. **Film response** — characteristic curves, halation, grain.
4. **Lens** — vignette, chromatic aberration, diffusion, distortion.

Lens effects are last *because* they are the cheapest and most fun, which is
exactly why they would otherwise displace the hard part. The ordering is a guard
against the author, not a dependency graph.

---

## 11. Adding a pass

The recipe, and what `src/render/graph.ts` is built to enforce. The vignette
below is an **illustration**, not a description of existing code: it walks a pass
that has not been written through every step, and the files it names do not exist
yet. Lens effects arrive last, per the build order above.

1. **Add the parameters to `EditState`** in `src/core/state/`, with defaults.
   Plain serialisable values only — they have to survive a snapshot for undo and
   a JSON round trip for presets.
2. **Write the maths in pure TypeScript first**, under `src/core/colour/`, if it
   is non-trivial. Unit test it against known values or a derivable property.
   This is the reference the shader is later checked against.
3. **Write the shader** in `src/render/shaders/<effect>.glsl`. Use `#include` for
   shared colour functions rather than copying them. Declare `uResolution`,
   `uImageSize` and `uSourceRect`, and normalise every spatial parameter against
   `uSourceRect` rather than against the buffer.
4. **Add the pass module** in `src/render/passes/<effect>.ts`, exporting its
   uniform bindings and an `enabled(state)` predicate.
5. **Register it in `src/render/graph.ts` at its correct point in the physical
   ordering**, not at the end.
6. **Add an agreement test** asserting the shader matches the TypeScript across a
   value ramp — reading the pass's **own output buffer**, not the canvas. A
   canvas assertion is measuring the whole chain, and the chain round-trips
   through the display transform, which cancels most of what you are trying to
   detect. `SHADER_CONVENTIONS.md` §4 has the measurement.
7. **If the pass has a spatial kernel, declare its overlap**, so tiled export can
   expand tile bounds and avoid seams.

### Worked example: vignette

A `cos^4` vignette darkening toward the frame edges, with a radius and a
falloff.

**Step 1.** `vignetteAmount: number` (0 = off) and `vignetteRadius: number`
join `EditState` with defaults `0` and `0.7`. Both plain numbers.

**Step 2.** The falloff is `cos^4` of the angle from the optical axis, which is
simple enough that a TypeScript reference earns its keep only as the thing the
shader test compares against — so it is written as
`vignetteFalloff(normalisedRadius, radius): number` and unit tested to be 1 at
the centre, monotonically decreasing, and never negative.

**Step 3.** `src/render/shaders/vignette.glsl`. The radius is a *spatial*
parameter, so it is expressed in units of the source image and converted with
`uSourceRect`, never in pixels of `uResolution`. The centre comes from
`uSourceRect.xy` too — without it every export tile is vignetted about its own
middle. See
[`SHADER_CONVENTIONS.md`](SHADER_CONVENTIONS.md) for the exact form; getting
this wrong is invisible in preview and appears only on export.

**Step 4.** `src/render/passes/vignette.ts` exports the uniform bindings and
`enabled: (s) => s.vignetteAmount !== 0`. The predicate is what keeps a
disabled effect from costing a pass, and it is also what changes the graph
structure and therefore triggers the one legitimate recompile.

**Step 5.** Registered in the **lens** stage, after diffusion. Not at the end of
the chain — a vignette darkens the frame the lens formed, so it must precede the
film stage. Appending it would put it after the grade, where it would darken an
already-graded image and behave like a post effect rather than an aperture.

**Step 6.** An agreement test renders a radial ramp through the pass, reads it
back through RGBA8, and compares against `vignetteFalloff` per patch.

**Step 7.** A vignette is a per-pixel function of position with no kernel, so its
declared overlap is zero. A bloom in the same stage would not be, and getting
that wrong produces visible seams in exported tiles.
