# Tests

| Directory | Runner | Exists | Purpose |
|---|---|---|---|
| `tests/unit/` | Vitest | yes | Pure TypeScript. Colour maths, curve evaluation, state reducers. |
| `tests/probe/` | Playwright | yes | Capability probes. Assert the browser can do what the renderer assumes. |
| `tests/render/` | Playwright | yes | Numeric readback from the real render graph, compared against the TypeScript reference. Not image diffing. |
| `tests/golden/` | Playwright | **not yet** | Rendered output against committed reference images. Arrives at Milestone 3 with the first spatial effects. |

Vitest collects `tests/unit/**/*.test.ts`; Playwright collects `**/*.spec.ts`
anywhere under `tests/`. The two suffixes are how a file is routed to a runner,
so a `.spec.ts` placed under `tests/unit/` is silently ignored by Vitest and
picked up by Playwright instead.

## Strategy

**Colour maths is verified by numeric assertions against the pure TypeScript
reference in `src/core/colour/`, not by image diffing.** Known patch colours go
through the chain and the values that come out are compared numerically. Two
reasons. It is far less sensitive to rasteriser backend differences than a pixel
comparison, which matters because local and CI SwiftShader are different code
generators (see below). And when it fails it names the colour that is wrong,
where an image diff reports only that 0.3% of pixels differ.

**Golden images are reserved for spatial effects** — grain, halation, vignette,
bloom, distortion — where there is no small set of numbers that captures whether
the result is right. They arrive at Milestone 3, and CI is the source of truth
for the reference images.

**Prefer assertions on ground-truth properties over comparisons to expected
values sourced from documents.** A property that must hold given the definitions
cannot inherit a wrong expectation, and published reference values disagree with
each other more often than is comfortable. The worked example is in
`tests/unit/matrices.test.ts`: every row of the sRGB to ACEScg matrix must sum to
1, which is true exactly when white maps to white, which is true only if the
chromatic adaptation is present and correctly oriented. That assertion is
stronger than comparing against a published matrix, because published matrices
vary in how many digits they carry and in whether and how they adapt.

Comparisons against published values still earn their place, because a property
about white points passes unchanged if a primary chromaticity is typo'd. Keep
both, and when they disagree, **trust the property and investigate the published
value.** That is not hypothetical: `tests/unit/primaries.test.ts` records a real
6.6e-5 disagreement between two published sRGB matrices, caused by one deriving
D65 from its chromaticity and the other using the ASTM tabulated white.

**A parameter over an encoded domain must be checked against occupancy**, and a
fixture sample labelled shadow, midtone or highlight must be asserted to fall in
that region of a real image rather than merely being ordered correctly. A value
can be correctly derived and still be in the wrong place: the film curves were
defined over eight stops above display white that never contain a pixel, and the
sample called "highlight" was a midtone. Every agreement test passed throughout.

**An angle is meaningless without a magnitude assertion.** A hue test must assert
a chroma floor first, or `atan2(0, 0)` returns a confident number determined by
rounding — which reported 68 degrees of crossover from three identical curves.
The polar form of the cancellation-channel problem. `docs/SHADER_CONVENTIONS.md`
§5 carries both in full.

**A fixture constant with a semantic label must be derived, never transcribed** —
`srgbOetf(0.18)`, not `0.46136`. This is the one failure an agreement test
structurally cannot catch: it checks that two implementations match, not that a
value handed to both is what its label claims. A patch labelled "middle grey"
held the gamma-2.2 encoding instead of the sRGB one for two stages, 0.6% wrong,
with every test green. `docs/SHADER_CONVENTIONS.md` §5 carries the full account
and the one place transcription is unavoidable.

**Where two independent derivations of the same quantity are cheap, do both and
assert they agree.** `tests/unit/transfer.test.ts` derives the ACEScct slope
constant from the log segment rather than trusting the transcribed value;
`tests/unit/grade.test.ts` checks the contrast operator against a closed-form
power law obtained without going through the encode and decode functions at all.

**Prove a test can fail before trusting it.** Every assertion in this repository
that guards something subtle has been run against a deliberate mutation, and the
result recorded. Three that changed the design rather than confirming it:

- Swapping the curve module's monotone tangents for Catmull-Rom fails eight
  tests, five of them the flat-segment cases. Before that check, the flat cases
  asserted monotonicity, which a curve wobbling by 1e-9 across a run the user set
  flat would have passed; they now assert exact flatness.
- Transposing the CAT02 cone response matrix is caught **only** by the published
  reference comparison. The reverse-adaptation round trip, the white-point test
  and the identity test all still pass, because the construction collapses to the
  identity for any invertible cone matrix.
- Perturbing one coefficient of the sRGB-to-ACEScg matrix in the GLSL by 1%
  moves the rendered canvas by at most one 8-bit code value, and not at all on
  saturated patches, because the pipeline round-trips through the inverse matrix
  and the display clamp removes what is left. The canvas assertion passed the
  mutation. Reading the ACEScg intermediate instead catches 1% and 0.1% alike.
- Worse: transposing **both** GLSL matrices, which is the realistic defect since
  one generator emits both, leaves the round trip at exactly the identity —
  4.4e-16 deviation, zero code values of movement. Not a tolerance problem, an
  algebraic one. The agreement test is therefore split into two legs, each
  comparing against what was measured at the previous stage rather than against
  the original input. See `tests/render/agreement.spec.ts` and
  `docs/SHADER_CONVENTIONS.md` §4, which carries the full mutation table.
- Restricting that test to in-gamut midtones, which is the obvious way to stop
  the display clamp eating the signal, was measured to cost an order of
  magnitude of sensitivity: a 0.1% error became undetectable. Display-matrix
  errors are largest on saturated patches, where a channel sits near zero and the
  encoding curve is steepest.

The pattern is the same each time: an assertion that looks like it covers
something can be blind to it, and running the mutation is the only way to find
out which.

## Renderer baseline

`tests/probe/webgl2-capability.spec.ts` records what the test browser actually
supports. Measured on 2026-08-30, Playwright 1.56 / Chrome Headless Shell 151,
identical on macOS arm64 and `ubuntu-latest`:

| Capability | Value | Consequence |
|---|---|---|
| `EXT_color_buffer_float` | present | RGBA16F is colour renderable; no RGBA8 fallback needed for tests |
| `EXT_color_buffer_half_float` | present | Accept either extension — Chrome has historically exposed only the former |
| RGBA16F framebuffer | `FRAMEBUFFER_COMPLETE` | The half-float pipeline is testable headlessly |
| HDR round trip | `4.5, -0.25, 1.75` preserved | Genuine half float, not a clamped fallback |
| `IMPLEMENTATION_COLOR_READ_TYPE` on RGBA16F | `HALF_FLOAT` | **Tiled export must resolve through an RGBA8 target.** `readPixels` will not portably return `UNSIGNED_BYTE` from a half-float framebuffer |
| `MAX_TEXTURE_SIZE` | **8192** | A 60MP source (~9504×6336) exceeds this. Test images must stay under 8192 on the long edge, and the source-too-large guard is reachable in practice, not theoretical |

Re-run it with `npm run probe:webgl` after any Playwright upgrade. It prints the
full capability dump whether or not it passes.

## Deferred assertions

Tests that are specified but not yet written, because writing them now would pass
without measuring anything. A test that passes vacuously is worse than an absent
one: it reports coverage that does not exist, and nobody re-examines a green test.

Kept here rather than as comments in the files that would contain them. A comment
in one test file is invisible to anyone reading a different one, which is exactly
how a deferral survives — by being hard to see.

| Deferred | Why it would be vacuous | Lands in |
|---|---|---|

*(empty — both entries closed in Stage 4 Part D)*

The two that were here were the renderer-level purity check and two-resolution
agreement for exposure and contrast. Both needed passes that consume an
`EditState` value, and both now exist: `tests/render/grade.spec.ts` asserts that
two routes to one `EditState` produce byte-identical frames, and
`tests/render/loop.spec.ts` asserts the two proxy resolutions agree with both
passes engaged.

Every entry must name the part that closes it. An entry with no landing point is
not a deferral, it is a decision not to test something, and it belongs in the
prose above rather than in this table.

## Frame timing

`tests/probe/frame-timing.spec.ts` measures the interactive chain at several
resolutions on a 12MP source. Measured 2026-09-01, ingest + display only — no
scene, lens, film or grade passes exist yet.

| Resolution | Pixels | Apple M5 (Metal) | SwiftShader (LLVM) |
|---|---|---|---|
| 512x384 | 0.2 MP | 0.095 ms | 5.6 ms |
| 1024x768 | 0.79 MP | 0.068 ms | 16.5 ms |
| 2048x1536 | 3.15 MP | 0.244 ms | 49.0 ms |
| **4000x3000 (full source)** | **12 MP** | **0.97 ms** | **145 ms** |

The 60Hz budget is 16.7 ms.

**On this hardware the drag proxy currently buys nothing.** A full 12MP frame
costs under a millisecond, six per cent of the budget, so halving the resolution
saves about 0.7 ms of a frame that had 15.7 ms spare — and costs a visibly softer
image for the duration of every drag.

It is kept anyway, and the reasons are worth stating so the decision can be
revisited rather than merely inherited:

- **An M5 is not the target floor.** `CLAUDE.md`'s memory budget exists because
  integrated and mobile GPUs are a real target, and one an order of magnitude
  slower puts a full-resolution 12MP frame at 10 ms and a 24MP frame past
  budget. There is no measurement from such a device yet.
- **The chain is three passes and about to become a dozen**, and the ones
  arriving are the expensive kind: halation, grain, bloom and diffusion all have
  spatial kernels, which are many taps per pixel rather than one. These figures
  are a floor for a pipeline that does almost nothing.

### What this measurement does not constrain

**0.97 ms for 12MP through three per-pixel passes is a memory bandwidth figure,
not a measurement of this pipeline.** Three passes that read one texel, do a
handful of arithmetic operations and write one texel are bandwidth-bound: the
number describes how fast the hardware can move 12 megapixels through memory
four times, and it would be about the same for almost any trivial shader. It says
nothing about what the code costs, because the code costs almost nothing.

The chain that ships will not be bandwidth-bound. Halation, bloom and diffusion
are **multi-tap spatial kernels**, and their cost is per tap: a Gaussian at a
radius worth having is one to two orders of magnitude more arithmetic per pixel
than anything measured here. That chain is compute-bound, and **no scaling of a
bandwidth-bound number predicts a compute-bound one.** Multiplying 0.97 ms by the
pass count would be a guess dressed as an extrapolation.

**Revisit once the chain contains at least one multi-tap kernel at a realistic
radius** — halation, at Milestone 3 — and not before. At that point the figure
describes the pipeline rather than the memory bus.

Note that the **SwiftShader column is the more informative one** for this
purpose. A software rasteriser is compute-bound already, so it is the closer
model of what a real GPU will look like once the chain does real work per pixel.
Its 49 ms at the 2048px proxy budget is the number to watch.

If a full-resolution drag is still comfortably inside budget on the slowest
device worth supporting once that measurement exists, delete the proxy: it is
about thirty lines in `renderer.ts` and its tests.

### What the proxy costs, measured

Halving each axis loses **63% of high-frequency detail**. Measured 2026-09-01 on
a 3000x2000 source carrying fine texture, comparing mean absolute Laplacian at
the same display resolution — the proxy render upscaled the way the browser
composites it, so the comparison is like for like rather than counting a smaller
image's sharper per-pixel edges:

| | Buffer | Mean abs. Laplacian |
|---|---|---|
| Full | 1112x741 | 4.196 |
| Drag proxy, upscaled to display size | 556x371 | 1.554 |

So the present trade is: **lose roughly two thirds of the fine detail during
every drag, to save 0.7 ms of a frame that had 15.7 ms spare.** That is a poor
bargain on this hardware, and it is visible on textured subjects rather than
theoretical. It is the cost side of the decision above, and it is why the
revisit should happen promptly once halation makes the benefit side real.

### Measuring this correctly

**`gl.finish()` does not synchronise under ANGLE/SwiftShader**, and it fails
silently rather than erroring. Timed with `gl.finish()` as the barrier, 400
frames at 2048x1536 "completed" in 1.6 ms — four microseconds for three
full-screen passes over three megapixels. The same work terminated by a
one-pixel `readPixels`, which cannot be deferred because its result is returned
synchronously, took 305 ms per frame. Both numbers came from the same code on
the same machine minutes apart, and the first was entirely fictional.

Any future timing work should use a readback as the barrier. It costs about 3 ms
on its own, so the frame count is chosen to make each run roughly a second long.

Note also that **headless Chromium uses SwiftShader even on a machine with a
GPU.** Reaching the platform driver needs a headed browser and
`--use-angle=metal`; the renderer string in the probe's output says which was
actually used, and it should be read before trusting any figure.

## Display transform, measured against the Stage 4 baseline

Stage 4 ended with a hard clamp as the display path, and D5 recorded what it
destroyed. The same frames and settings, re-measured with the tone map and gamut
compression in place, on an Apple M5:

| Frame | Setting | Blown, clamp only | Blown, tone mapped | Crushed, both |
|---|---|---|---|---|
| Backlit | contrast 1.2 | 31.4% | **0%** | 3.2% |
| Backlit | contrast 1.4 | 42.5% | **0%** | 3.3% |
| Backlit | contrast 1.6 | 48.7% | **0%** | 3.7% |
| Backlit | +1 EV | 51.6% | **0%** | 0% |
| Backlit | +2 EV | 69.1% | **0%** | 0% |
| Backlit | contrast 2.0 | 58.2% | **0%** | 30.3% |
| Night scene | contrast 1.3 | 1.4% | **0%** | 39.2% |
| Night scene | contrast 2.0 | 7.7% | **0%** | 50.1% |

**Blown goes to zero everywhere, and that is partly trivial.** The shoulder is
asymptotic to 1 and never reaches it, so no pixel can land on code 255 by
construction. The figure that means something is how many distinct code values
the recovered highlights actually occupy, which is the sweep below.

**Crushed is unchanged, and that is correct.** Those pixels are already negative
before the display transform sees them: a contrast slope above 1 takes values
below the pivot through zero via the ACEScct toe. That is the tone map's problem
to solve only in the sense that it is not the tone map's problem at all — it is
the grade operating on scene-referred data with no floor, and the fix belongs in
the film stage's toe rather than in the display path.

### Choosing the knee

Measured on the backlit frame. The trade is how far an **unedited** image moves
against how much highlight detail is recovered, over the 568k pixels the clamp
blew at +1 EV:

| Knee | Unedited mean shift | Worst shift | Distinct highlight levels |
|---|---|---|---|
| 0.4 | 13.29 code values | 37 | 19 |
| 0.5 | 9.20 | 31 | 16 |
| 0.6 | 5.70 | 24 | 15 |
| 0.7 | 2.88 | 18 | 13 |
| 0.8 | 1.06 | 12 | 10 |

Dropping from 0.8 to 0.4 costs twelve code values of fidelity on every unedited
photograph to buy nine levels of highlight detail. That is a poor bargain here,
and the reason is worth stating: **an 8-bit source has no data above diffuse
white to recover.** A JPEG's highlights are already clipped in the file. The
roll-off is almost entirely working on values the *pipeline* created by pushing
exposure and contrast, not rescuing anything the camera captured.

**0.75 is the default**: the unedited shift is below the threshold of visibility
and most of the separation survives.

### What the photographs show

- **The sun disc is back**, as a soft luminous gradient rather than the flat
  white blob the clamp produced at contrast 1.4. Structure, not just a lower
  number.
- **Contrast 1.6 reads as a strong grade rather than damage.** The sky keeps its
  gradient from cyan through to the horizon.
- **It does not read as haze.** The roll-off is exactly the identity below the
  knee, so shadows and midtones are untouched — the failure where a tone map
  lifts the whole image to avoid clipping cannot occur with this operator shape.
- **No hue shift in saturated regions.** Gamut compression scales the whole
  chroma vector by one factor, so hue is preserved to floating point rather than
  approximately; saturated patches desaturate slightly without turning plastic.
- **Shadows are still crushed**, unchanged and for the reason above.

## Two parameter tables, not one with a discriminant

`EditState` now holds two kinds of parameter: scalars with sliders, and curves
with control point arrays. They live in **two separate tables**,
`EDIT_PARAMETERS` and `CURVE_PARAMETERS`, rather than one table with a `type`
field.

The reason is that a discriminated table pushes the branch into every consumer —
the interface, the validator, the preset merge, the equality check — where two
tables let each of those iterate only the kind it cares about. The coverage test
asserts that every field in `DEFAULT_EDIT_STATE` appears in the union of both, so
a third kind cannot be added without a table, which is where a field with no
interface and no validation would otherwise come from.

**If a third kind arrives and the tables start needing to be walked together
everywhere, that is the signal this should become a registry rather than a list.**
It should be changed then, not discriminated now.

That coverage test has already earned itself: when the tone curve's domain moved
to start at black in ACEScct, `DEFAULT_EDIT_STATE` kept its control points at
zero. The two disagreed, so the identity check never matched and the curve pass
ran on every unedited photograph — a full extra pass, and a slightly altered
image, from a two-element mismatch.

## Golden images and the SwiftShader backend

Golden tests run on SwiftShader, forced via `--use-gl=angle
--use-angle=swiftshader` in `playwright.config.ts`. SwiftShader output differs
from real GPU output, so references are generated **with SwiftShader**, not on a
GPU, and the tolerance is kept tight enough to catch real regressions.

There is a complication to be aware of before generating any reference image.
The two environments report different SwiftShader backends:

```
macOS arm64      SwiftShader Device (LLVM 10.0.0)
ubuntu-latest    SwiftShader Device (Subzero)
```

These are different code generators for the same rasteriser and are not
guaranteed to produce bit-identical floating point results. **Reference images
must therefore be generated in the same environment that CI verifies them in**,
or the goldens will pass locally and fail on CI for reasons unrelated to any
code change. Two workable options, to be settled when golden tests land:

1. Generate references in CI and commit them from that run.
2. Treat CI as authoritative and give local runs a looser tolerance via an
   environment flag, with CI running the strict one.

Do not paper over the difference by loosening the shared tolerance until it
passes in both places — that is precisely the "tolerance so loose that real
regressions pass" failure mode.

The Chromium version is part of the expected output. The CI cache key is pinned
to the resolved `@playwright/test` version so an upgrade invalidates it, and any
Playwright bump should be treated as requiring golden regeneration.

## The occupancy rule

**A parameter defined over an encoded domain, and a fixture labelled with a
tonal region, are both claims about where data is. Assert them.**

Neither kind of claim is checked by anything else in the suite, and both have
been wrong here three times, each time in source that read as entirely
reasonable:

| Claim | What it said | What was true |
|---|---|---|
| Film curve control points | evenly spread over ACEScct `[0.073, 1]` | the top half decodes above eight stops over display white, so half the curve shaped pixels that cannot exist |
| A fixture named `highlight` | linear `1.4` | encodes to `0.58`, the middle of the range — and the exact crossover point, so the measurement it fed read near zero for a real effect |
| `halationThreshold`'s range | `[-1, 4]`, commented as fully occupied | nothing in a display-referred image exceeds `+2.474`, so the top third of the slider did nothing at all |

All three were found by looking at a photograph and wondering why, which is not
a repeatable process. `tests/unit/occupancy.test.ts` asserts them instead, and
both mutations were watched to fail:

- default back to `+1.5` — 4 tests fail
- range back to `[-1, 4]` — 2 tests fail

### The fixture is a histogram, not a photograph

`tests/fixtures/luminance-histograms.ts` holds 240-bin luminance histograms of
two real photographs. Checking in the photographs is the obvious way and the
wrong one: this repository is intended to go public for Pages, a JPEG is
permanent once pushed, and these are personal photographs of identifiable
people. A histogram is not invertible.

Two properties of the fixture that took a correction to get right:

- **Bin the quantity the shader actually thresholds.** ACEScg luminance under
  AP1 weights, after the sRGB decode and the primaries matrix — the same value
  `halationThreshold.frag` computes. A first pass binned Rec.709 weights on
  sRGB-linear, which is close enough to eyeball and makes every assertion a
  statement about a domain no parameter controls.
- **Bin at native resolution.** The first pass binned 1000px thumbnails, and
  downsampling averages away isolated specular peaks — exactly the population a
  highlight threshold is about. It reported near-zero occupancy for a threshold
  whose rendered effect was plainly visible.

### Weigh over the shoulder, not at the point

The threshold shader is `smoothstep(t, t*sqrt(2), luminance)`, so the population
that contributes is the window `[t, t·√2]`, weighted. Counting pixels above `t`
is the wrong measurement: on the night frame, `0.003%` of pixels sit above the
default threshold while the rendered effect reaches **38 levels out of 255** on
the brightest folds of a shirt. A bar set on the count calls a visible effect
absent.

### Chroma floor before any angle

A hue angle is meaningless without a magnitude. `atan2(0, 0)` returns a
confident, rounding-determined number, and an early crossover measurement
reported 68° of separation from three identical curves on that basis. Every hue
assertion in the suite is now preceded by a chroma floor; `display.test.ts` had
two without one, found by sweeping for the pattern rather than by noticing.

## Halation

### Where the threshold has to sit, measured

Occupancy of the two fixture photographs, as fraction of frame inside the
scattering window (smoothstep-weighted) and strictly above threshold:

| Threshold (EV over grey) | night: mass / above | talk: mass / above |
|---|---|---|
| +1.5 | 0.38% / 2.27% | **14.6% / 31.7%** |
| +1.8 | 0.008% / 0.23% | 2.69% / 12.6% |
| **+2.0** | 0.001% / 0.003% | 0.58% / 3.07% |
| +2.2 | 0.0002% / 0.002% | 0.10% / 0.61% |

The shipped default was `+1.5`. At that setting **a third of a lit interior is
above threshold**, and it looks like it: the white brick wall behind the speaker
glows pink. A third of a picture is not a highlight. The default is now `+2.0`
and the range `[0, 3]` — `+2.474` is display white and the hard ceiling for any
unmodified image, with one stop of headroom because exposure genuinely raises
it.

**The two photographs disagree by a factor of ~500 at the default, and that is
correct rather than residual error.** Halation is a threshold phenomenon in
absolute exposure; film does not rebalance per frame. A night scene lit by one
flash should show almost none and a room full of lights should show some.
Normalising per image would even it out and would be content-derived
adaptivity — the thing ruled out for the drag proxy, for the same reason.

### What the photographs show, at the corrected default

Rendered differences from halation off, at strength 0.7 and radius 0.006:

| | night | talk |
|---|---|---|
| +1.5 | 1.6% of pixels, worst 71/255 | 34% of pixels, worst 153/255 |
| +2.0 | 0.03% of pixels, worst 38/255 | 3.3% of pixels, worst 57/255 |

- **It reads as light bleeding within the image, not as a glow on top** — but
  only above about `+1.8`. Below that it is unmistakably the second thing: at
  `+0` every light-toned surface in the night frame washes pink, shirts, shorts,
  boat and sand alike, which is exactly what a bloom filter over the top looks
  like.
- **It discriminates emissive from merely light-toned, at the corrected
  default.** The talk frame is the useful case because both are present: the LED
  panel's white book spines bleed warm into the blue around them while the white
  painted brick beside the screen stays neutral. At `+1.5` the wall glowed.
- **Flash-lit white cotton is the hard case and it passes.** In the night frame
  the brightest object is a shirt, not a light. At `+2.0` the diffuse cotton is
  untouched and only the few genuinely blown folds pick up warmth.
- **The characteristic curves do not flatten it — they concentrate it.** Through
  a stock the affected area shrinks and the peak rises: no curves 3.25% of
  pixels / worst 57; warm-portrait 2.89% / 66; punchy-reversal 1.24% / 70. The
  shoulder compresses the broad faint fringe toward white while the steeper
  midsection amplifies the core. Punchy-reversal has the harder shoulder and
  shows the effect most sharply. This is the argument for halation running
  *before* the curves: a curve applied to scattered light is the film responding
  to it, which is what physically happens.
- **It stops looking like film between 0.015 and 0.03 of the long edge.** Up to
  0.015 the glow hugs the contour of the bright object and reads as its light.
  By 0.03 it has detached into a soft blob sitting over the picture. At 0.06 it
  is a broad haze and the source no longer looks like its origin — and the
  bright object is *less* bright than at a small radius, because the scattered
  energy that lands back on the source at 0.004 is spread away from it at 0.06.
  `HALATION_FILMLIKE_MAX_RADIUS = 0.015` records the boundary; the slider goes
  to 0.04 because it is a judgement rather than a limit.

### Why the golden specs pin the threshold

`two-resolution.spec.ts` and `tile-overlap.spec.ts` both set
`halationThreshold` explicitly rather than inheriting the default. This is
deliberate and must stay: their tolerances are derived assuming there is a
blurred halo to compare, and a default raised above the synthetic source's peak
would drive the measured disagreement to zero and make **both tests pass
trivially**. A test that passes because the effect is off is worse than no test.

## The drag proxy: engaged only when frames are missed

The decision was deferred twice, to the first multi-tap kernel. Halation is it.
Frame time on a 12MP source with halation at a realistic radius:

| buffer | Apple M5 (Metal) | SwiftShader (LLVM) |
|---|---|---|
| 512×384 | 0.275 ms | 18.4 ms |
| 1024×768 | 0.400 ms | 67.1 ms |
| 2048×1536 | 1.585 ms | 263.3 ms |
| 4000×3000 | 6.092 ms | 1023.0 ms |

Against the Stage 4 bandwidth-bound floor (12MP was 0.97 ms on Metal) the chain
is now **6.3× more expensive**, so this is real work rather than memory
traffic. Against a 16.7 ms budget the two ends disagree completely:

- **On this hardware the proxy is pure loss.** At a typical canvas it saves
  0.13 ms of a frame with 16.3 ms spare, and even the full 12MP image at 6.09 ms
  is inside budget. It buys nothing and costs the 63% of high-frequency detail
  measured at Stage 4, on every drag.
- **An order of magnitude slower it is the difference between usable and not.**
  SwiftShader — the closest available model of a weak GPU now that the chain is
  compute-bound — is 16× over budget at the 2048px proxy, with the lens stage's
  bloom and diffusion still to come.

So it is neither deleted nor kept unconditionally. It engages after
a median of `DRAG_PROXY_WINDOW` frame intervals over
`DRAG_PROXY_FRAME_BUDGET_MS`, and stays engaged for the rest of the gesture. Letting it disengage mid-drag would
oscillate: dropping resolution makes frames fast, which is the condition for
going back to full resolution, which makes them slow.

Measured from wall-clock intervals between rendered frames, not from the GPU:
the only reliable barrier available is a readback, which stalls the pipeline it
would be measuring. `gl.finish()` does not synchronise under ANGLE.

**This is timing-derived, not content-derived.** The distinction is the one in
`renderer.ts`: the resolution varies, and the two-resolution invariant says
resolution does not change the image. Output stays a pure function of the
inputs; only how densely it is sampled moves.

`DragProxyMode` (`auto` / `always` / `never`) exists so tests can exercise the
mechanism without depending on how fast the machine running them happens to be.
A timing-dependent test of a timing-dependent feature would be flaky in both
directions.

## The degenerate-case rule

**A test that only exercises the degenerate case cannot detect an error that
vanishes there.** The fix is never more coverage of the degenerate case; it is
finding where the two formulations differ and testing *there*.

Three instances so far, and the pattern is much easier to recognise from the
examples than from the statement:

| Instance | The two formulations | Where they coincide | What breaks the degeneracy |
|---|---|---|---|
| **The Stage 3 transpose** | `M` and `Mᵀ` | a round trip, since `Mᵀ·(M⁻¹)ᵀ = I` | comparing against measured intermediates rather than chaining a round trip |
| **The halation radius** | against `uSourceRect` and against `uResolution` | a full-frame render, where `sourceLongEdge × (resolution.x / sourceRect.z)` reduces exactly to `resolution.x` | tiles, whose buffers do not cover the whole source |
| **The grain seed** | source coordinates and buffer coordinates | a full-frame render, where the two differ by a constant scale | tiles again — and specifically tiles with *different origins*, compared where they overlap |

The third one carries an extra lesson. A tile-against-tile check was written
first and passed while the code was wrong, because the two tiles being compared
shared a y extent and therefore shared a y-flip error. **Two cases that differ
along the wrong axis are still one case.** The tiles-against-whole comparison
caught it immediately, at 0.113.

Tiles are what break the degeneracy for anything spatial, so a spatial pass
without a tile test has not been tested.

## The soft-edge metric rule

**A metric for a soft-edged effect must integrate the soft edge**, or it measures
a different effect than the one rendered.

Counting pixels above `halationThreshold` reported a real, visible, localised
effect as absent: on the night frame, 0.003% of pixels sit above the default
while the render reaches **38 levels out of 255** on the brightest folds of a
shirt. The shader's shoulder spans `[t, t·√2]`, so the population that
contributes is a window and not a point, and the smoothstep-weighted version
reports it correctly.

The same rule applies to grain, where the metric had to change twice. Grain has
no hard edge at all, so a pointwise comparison against a TypeScript reference
is impossible — the value at a pixel comes from a hash, and transcribing the hash
into TypeScript would assert that two transcriptions match rather than that the
effect is right. What the modulation claims is about **amplitude**, so the
amplitude is what is measured: the spread across a band of constant exposure,
in ACEScct because that is the space the perturbation is applied in. Measuring
the spread of *linear* values would recover the exponential rather than the
modulation and report grain growing towards the highlights.

## Grain

### Where the modulation peaks, and why it is anchored

The peak is at **middle grey**, stated in stops, not at a midpoint of the
encoding. The rejected construction — normalise the encoded value over the range
the data occupies, peak at the midpoint — is the occupancy failure one level up:
that midpoint is a fact about where ACEScct's log/linear splice falls, and it
lands 1.75 stops under grey for reasons that have nothing to do with emulsion.

Share of a frame carrying grain, weighted by the modulation:

| Peak | night | talk | spread |
|---|---|---|---|
| **middle grey** | 50.5% | 47.9% | **2.6 points** |
| −1.75 stops (occupied-range midpoint) | 25.9% | 17.0% | 8.9 points |
| +1.51 stops (`[0, 1]` midpoint) | 39.9% | 74.8% | 34.9 points |

The anchored version is the only one that behaves the same on a low-key frame
and a high-key one, which is what a property of the emulsion should do.

### Independence is not measurable as a channel correlation

The obvious statistic, `corr(R, G)` of the rendered values, does not work. The
readback is in display primaries and the ACEScg→sRGB matrix has negative
off-diagonals, so a perturbation of ACEScg red alone pushes sRGB green the other
way. **Independent noise measures −0.27 to −0.56** across twenty regions of a
photograph, which is the same neighbourhood a shared-noise mutation lands in.

What works: one shared noise value moves the working-space triple along
`(1, 1, 1)`, which the matrix maps to a single fixed direction, so every residual
lies on a line and its covariance is rank one. The share of residual variance in
the leading eigenvector is 0.45 for independent noise and **1.000** for a shared
value. The bar sits in a gap rather than on a slope.

### What the photographs show

Grain residual — the difference the pass makes, pixel by pixel, which removes the
picture — across twenty regions of a 6000px photograph, sorted by level:

| mean (encoded) | grain | after tone map |
|---|---|---|
| 0.153 | 2.5e-3 | 2.5e-3 |
| 0.192 | **5.2e-2** | 1.4e-2 |
| 0.240 | 3.7e-2 | 1.4e-2 |
| 0.458 | 1.3e-2 | 1.3e-2 |
| 0.707 | 1.1e-2 | 1.1e-2 |
| 0.884 | 5.2e-3 | 5.2e-3 |

- **It sits in the image rather than on it**, and the density modulation is why:
  roughly twenty times more grain in the low midtones than in the darkest or
  brightest regions. A uniform overlay would give one number down the column.
- **Present in the midtones, gone in deep shadow and blown highlight**, as above.
- **The tone map's shoulder does eat some of it**, but only where it is
  compressing: the strongest midtone regions drop by about two thirds, from
  5.2e-2 to 1.4e-2, while regions the shoulder is not acting on are unchanged to
  three figures. That is the tone map doing its job rather than grain being
  fragile — the same compression applies to the picture around it.
- **It is colour grain.** Visible directly at full resolution as red and blue
  speckle rather than grey, and confirmed by the rank statistic above.

### The preview cannot show it, and that is the honest behaviour

At the default size on a 6000px source the proxy is **indistinguishable from
grain switched off**, while the full-resolution render is obviously grainy. Above
the representable limit — 0.004 of the long edge, 24 source pixels — the two
agree closely and the invariant test asserts it.

This is the deviation recorded in `docs/ARCHITECTURE.md` §4, and it is a real
gap for a user: **grain cannot be judged in the preview at the default size.**
The fix is a 1:1 inspector, which does not exist yet.

### Frame time

12MP source, full chain. Grain is per-pixel with no kernel, and costs what that
suggests:

| buffer | Metal, no grain | Metal, with grain | SwiftShader, with grain |
|---|---|---|---|
| 512×384 | 0.209 ms | 0.282 ms | 19.3 ms |
| 2048×1536 | 1.542 ms | 1.936 ms | 295.0 ms |
| 4000×3000 | 6.012 ms | 7.442 ms | 1046.6 ms |

**+1.43 ms at 12MP**, taking a full-resolution frame to 45% of the 60 Hz budget.
The drag proxy's trigger is unaffected: at the 2048px proxy Metal is 1.9 ms
against a 33 ms threshold and SwiftShader is 295 ms, so grain moves neither end
anywhere near the decision.

**Verify the renderer string before trusting any of these.** Headless Chromium
falls back to SwiftShader for WebGL unless `--use-angle=metal` and a headed
context are asked for explicitly, and it does so silently — a first run of this
measurement produced 19.9/282/1041 ms and would have been reported as Metal.
`frame-timing.spec.ts` prints the renderer for exactly this reason; do not filter
it out of the output.

### Do not assert that a machine is fast, or that it is slow

The drag proxy's engagement test was written to drive the real frame loop, which
was the right instinct — it is what found that `Viewport` re-opens the gesture on
every store change, and that a count of consecutive slow frames fires on a
healthy drag. But its first form depended on a large buffer with the full film
stage on the software rasteriser genuinely being hundreds of milliseconds a
frame. That held locally and **did not hold on CI**, where the test failed.

The mirror image is just as bad. A companion assertion that a *cheap* gesture
must not engage the proxy needs the machine running it to be fast, and it passed
and failed on consecutive local runs with nothing changing but load.

So the rule is split:

- **The decision, on given intervals**, is a pure function and is unit-tested in
  `tests/unit/drag-proxy.test.ts` — including the measured jitter of a real
  healthy drag (12–24 ms with spikes past 45), which is what the old rule tripped
  over.
- **The wiring** is tested in the browser, and every timing in it is made
  deterministic by stalling wall-clock time between frames rather than by hoping
  the renderer is expensive. The cause is synthetic; the elapsed time is real.

What remains in the browser test is only what is deterministic on any machine: a
stalled gesture engages, a stalled *non*-gesture does not, and `mode: 'never'`
refuses regardless.
