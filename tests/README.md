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

### The axis extension: vary every axis the parameter depends on

Generalising that lesson: **a tile test must vary every axis the parameter
depends on.** For grain that is x and y. For anything reading `uSourceRect` it is
also **scale**, and a 2x2 arrangement at two scales is barely more work than two
tiles.

An audit against this found a real hole. Every tile test in the suite ran at 1:1:

| Test | x | y | scale |
|---|---|---|---|
| `tile-overlap.spec.ts` | yes (2x2) | yes (2x2) | **no** — `SCALE = 1` |
| `grain-determinism.spec.ts`, tiles vs whole | yes (2x2) | yes (2x2) | **no** |
| `grain-determinism.spec.ts`, tile vs tile | yes | yes | **no** |
| `grain-resolution.spec.ts` | **no** — origin 0 | **no** | yes |

So origin and scale were never varied together, and that gap admits a specific
shape of error: one that is an identity whenever the origin is zero *and* an
identity whenever the scale is one. Scaling the source origin by the buffer scale
is exactly that — a zero origin survives any factor, and a unit factor changes no
origin.

Watched, rather than argued. With that mutation applied, all five 1:1 tile
assertions pass, `grain-resolution` passes, `tile-overlap` passes and
`two-resolution` passes; the new scaled-tile test fails at **0.118** against a
4.9e-4 tolerance. It is the only test in the suite that can see it.

## The soft-edge metric rule

**A metric for a soft-edged effect must integrate the soft edge**, or it measures
a different effect than the one rendered.

Counting pixels above `halationThreshold` reported a real, visible, localised
effect as absent: on the night frame, 0.003% of pixels sit above the default
while the render reaches **38 levels out of 255** on the brightest folds of a
shirt. The shader's shoulder spans `[t, t·√2]`, so the population that
contributes is a window and not a point, and the smoothstep-weighted version
reports it correctly.

### A near-miss worth knowing about before you check the amplitude profile

The measured amplitude profile appeared to peak at **+1.28 stops** rather than at
middle grey, because the readback was display-encoded and was being read as
linear. A true middle grey read that way lands at **+1.32 stops**.

Those two numbers agree to within the resolution of the measurement, so the
artifact looked like a confirmation of itself: a peak had been found, close to
where an incorrect derivation said one should be, and there was every reason to
stop. What broke it was that the profile also collapsed to zero below −0.6 stops,
which no modulation with a four-stop toe can do.

The next person to check this will hit the same coincidence. `profile()` in
`tests/render/grain.spec.ts` linearises before reading anything as an exposure,
and the comment there says why; do not remove it because the numbers look
plausible without it.

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

| mean (encoded) | grain | after the display transform |
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
- **The display transform attenuates it in places — and the mechanism is not the
  one first reported.** This was originally written up as the tone map's shoulder
  compressing grain where it compresses everything, which was a causal claim
  resting on a correlational measurement. It is wrong.

  Splitting the two display stages settles it. `toneMap` alone keeps grain at
  **1.000 in every region measured**; `gamutCompress` alone accounts for the whole
  effect, matching the combined figure to three decimals:

  | mean | both | tone map only | gamut only |
  |---|---|---|---|
  | 0.192 | 0.262 | **1.000** | 0.262 |
  | 0.240 | 0.368 | **1.000** | 0.368 |
  | 0.565 | 0.385 | **1.000** | 0.385 |
  | 0.672 | 0.535 | **1.000** | 0.535 |
  | 0.884 | 1.000 | 1.000 | 1.000 |

  The affected regions are the **saturated** ones, not the bright ones — the
  original reading correlated the attenuation with level because the regions that
  showed it happened to be a blue banner and a magenta one. Per-channel
  independent noise creates chroma excursions, and in an already-saturated area
  those fall outside the display gamut and are pulled back.

  This is defensible behaviour rather than a defect: chroma the display cannot
  show is chroma the display cannot show. But it means grain visibly weakens on
  saturated colour, which emulsion does not do, and it is recorded here as a
  known consequence rather than as a decision anyone made.

  The corroborating check that broke the original claim: a non-grain signal of
  similar amplitude in the same regions is kept at 1.0 to 1.75 where grain is
  kept at 0.26 to 0.65. Grain was being attenuated far more than surrounding
  detail, which is exactly what "the tone map is doing its job" predicts should
  not happen.
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

## The 1:1 inspector

A canvas-sized region of the source rendered at one buffer pixel per source
pixel. It exists because grain was a parameter that could not be evaluated: at
the default size on a large source the proxy correctly fades it to nothing, so
the user set a number, saw no change, and found out on export.

Implemented as a change to `uSourceRect` and nothing else, which is what makes it
worth having twice over. As a feature it shows fine spatial structure; as a
fixture it puts every spatial parameter at a **non-zero source origin**, which is
the non-degenerate case.

Four assertions, and they are different questions:

| Assertion | What it pins | Mutation watched |
|---|---|---|
| The region is buffer-sized and tracks the centre | the rect derivation | centre ignored — fails |
| Its render equals a direct render of the rect it reports | `passContext()`, which no other test reaches | (covered by the unit test below) |
| Main view and inspector agree at different scales | origin **and** scale varied at once, the Part A gap | — |
| It is exempt from the drag proxy | the exemption | exemption removed — fails at 300 vs 600 |

`inspectorRect` is unit-tested separately, including that it clamps the *rect*
rather than the centre — clamping the centre leaves the region hanging off the
edge and the view shows a band of nothing. Removing the half-buffer offset fails
there and **not** in the browser tests, which is the right division: the browser
tests compare the render against the rect the renderer reports, so a consistently
wrong rect is consistent.

### What grain at the default size actually looks like

Never evaluated before this. Measured on the 6000px photograph, in a midtone.

**It is fine, coloured, and about right.** At strength 0.6 the residual is 2.2
levels out of 255 with a correlation length of 3 pixels, which reads as emulsion
rather than as noise. 0.3 is subtle, 1.0 is heavy but not obviously wrong.

Two things the inspector was needed to see:

- **Apparent strength falls sharply as size rises, though the amplitude does
  not.** Measured across the size slider: residual 2.25, 2.20, 2.23, 2.27 levels
  at periods of 3, 5.4, 9 and 18 source pixels, with correlation lengths of 2, 3,
  5 and 10 pixels. The amplitude is flat and only the spatial frequency moves —
  exactly as designed — but a fixed amplitude at low frequency is far less
  salient and reads as part of the picture. **Size and strength are not
  perceptually independent controls**, and the size slider behaves like a second
  strength slider in the wrong direction. Recorded, not fixed.
- **There is no lattice artifact, despite appearances.** At strength 1.0 the
  magnified strip looked to have a regular diagonal cross-hatch, which would have
  been the value-noise grid showing through. It does not exist: the
  autocorrelation is 0.918 along x against 0.919 along y, the diagonal matches
  the anti-diagonal, and there is no secondary peak at the 5.4-pixel lattice
  period or its multiples. The pattern was produced by **my own
  nearest-neighbour magnification** when building the comparison strip.

  Worth stating as a method note: magnifying a fine stochastic texture with
  nearest-neighbour interpolation invents structure that is not in the render.
  Measure the autocorrelation before believing a pattern seen in a zoomed
  screenshot.

## The grade stage

Five passes on the same data — tone curve, contrast, wheels, HSL, split toning —
and the interactions between them are what makes a set of grading tools feel
coherent or fussy.

### Contrast moved, because the ordering was incoherent

Contrast ran **last**, which put the two tonal controls on opposite sides of the
three colour controls. That is hard to defend on its own, and it had a measured
cost. Contrast is a slope about grey in ACEScct and the wheels add offsets in the
same space, so a later contrast scaled every wheel exactly in proportion:

| contrast | a lift set to 0.04 became | after the reorder |
|---|---|---|
| 0.60 | 0.024 — **60%** of what was set | 0.033 (82%) |
| 1.00 | 0.040 (100%) | 0.040 (100%) |
| 1.60 | 0.064 — **160%** of what was set | 0.040 (100%) |

A colourist who set a lift and then raised contrast found the lift stronger than
they left it. It also moved middle grey away from the pivot contrast was about to
use — a lift of 0.04 displaced grey by 0.0104.

Contrast now runs directly after the tone curve: tonal shaping first, colour trim
after, which is also the order people work in. The residual 82% at contrast 0.6
is a second-order effect — contrast moves the value into a different part of the
lift zone — rather than proportional scaling.

### What composes cleanly

**Wheels and split toning add exactly.** Both are ACEScct offsets, so a wheel
contributing 0.0262 and a split tone contributing 0.0300 give 0.0562 together —
the sum, to the last digit. They do not fight, and a user can reach the same look
by either route.

That predictability has a cost worth naming: **warmth stacks silently.** In the
combined look, a warm film stock, a warm gain wheel and a warm highlight tint all
push the same direction and compound, and nothing in the interface says the
warmth has been applied three times.

### What the photographs show

- **The wheels read as a grade rather than a cast.** A cool lift and warm gain
  give a clear teal-and-orange trim on the lit interior: the wall warms, the
  shadows in the audience cool, and the blues stay blue.
- **Lift dominates a low-key frame, exactly as measured.** On the night beach the
  sky goes visibly blue from the lift's blue offset — that vast near-black area
  is where lift owns 57% of the frame, which is what the occupancy integral said
  before any pixel was rendered.
- **Split toning and the wheels reach different places on the same picture.** On
  the night frame the split tone's handover at grey puts nearly everything on the
  shadow side, so it warms the sand and leaves the sky alone; the wheels' three
  zones split the same frame differently. They are not redundant controls.
- **HSL has little to do on a low-key frame** and a lot on a lit one, which
  follows from there being chroma to work with in one and not the other.

### The Stage 6 hue bound does not survive HSL

Re-run as the brief asks. It does not hold: worst compressed hue shift is 11.3
degrees at a tenth of the saturation range, 24.2 at a quarter and 32.6 at the
top, against a bound of 20. The breakpoint is where `mix(luma, rgb, 1 + s)` drives
channels negative — the colour is then outside AP1, not merely outside the
display gamut, and the compressor was never measured there.

Worse, and recorded rather than worked around: **compression is not uniformly
better than clipping** on the colours HSL can now produce, and it does not
correlate with how far outside the gamut the colour is.

| excursion | compressed | clipped | |
|---|---|---|---|
| 0.036 | 0.3° | 0.5° | compression wins |
| 0.201 | 2.1° | 12.2° | compression wins |
| 0.212 | 11.2° | 5.3° | **compression loses** |
| 0.355 | 32.6° | 15.7° | **compression loses** |

`display.test.ts` asserts compression is never worse than clipping, over seven
hand-picked strongly out-of-gamut colours. That test still passes and is not
weakened. The invariant simply does not generalise to this region, and the fix is
a decision about the compressor rather than about HSL.

## Presets

Nearly free, because `EditState` was built to make it so: flat, serialisable, and
merged through a loop over the parameter table rather than over the incoming
patch. Two of the four requirements were already satisfied before any code was
written, and were verified rather than built:

- **Unknown keys are dropped on merge.** This holds by the *direction* of the
  loop in `mergeEditState`, not by a filter, so it survives every new parameter
  kind. Already asserted in `edit-state.test.ts`.
- **Applying a preset is one undo step.** `applyPatch` calls `commit` once.
  Asserted end to end now: a preset touching seven parameters costs exactly one
  history entry and one undo restores every one of them.

### Sparse, not complete — and what that costs

A preset stores **only what differs from the default**. The alternative resets
exposure and white balance on every application, and those are decisions about
*this photograph* — how much light there was, what colour it was — rather than
about the look. Wiping them is the opposite of a starting point.

The cost is real and worth stating, since the choice is a trade rather than an
obvious win: **a sparse preset is not a complete description of a look.** Applied
to two different edits it gives two different pictures, so "the same preset" does
not mean "the same result". Exact reproduction has a route — reset, then apply —
and that route works *because* what is stored is a difference from a known state.
A complete-state preset would have made the common case wrong in order to make
the rare case automatic.

One consequence caught by a test rather than by thinking: a preset entry equal to
the default carries nothing and is dropped on the way in, so a shipped preset
listing one would disagree with what loading it produces. Three of the four
shipped presets had such an entry, and the assertion that a shipped preset needs
no clamping and loses no keys is what found them.

### Storage fails softly

Every `presetStore` operation resolves rather than throwing when IndexedDB is
unavailable — absent in a private window in some browsers, blocked by policy in
others. A photo editor that will not open because it cannot save a preset is
worse than one whose presets do not persist. The failure reaches the interface as
a message, and the preset still applies for the session.

Stored patches are re-validated on the way **out**, not only on the way in. A
stored preset is as untrusted as an imported one: it may have been written by an
older build, or a newer one through a shared origin, and the parameter table it
was written against is not necessarily this one.

An import drops a bad field rather than failing: one bad entry should cost that
entry, and the caller is told what went. Only an unrecognisable envelope is fatal.

## The gamut compressor, restated truthfully

The Stage 6 bound was documented as a general guarantee and was fitted to seven
colours reachable by white balance, which move roughly along the blue-yellow
axis. HSL saturation reaches any hue. **This is the occupancy failure one level
up — applied to a test's input space rather than to a parameter's domain.** The
same question had been asked three times about parameters and never once about
the colours a test feeds itself.

### The brief's diagnosis was wrong, and the measurement says which option to take

The failures were described as uncorrelated with excursion and therefore
unpredictable. They are not unpredictable: the shift is a smooth, strong function
of **hue angle**, measured at fixed chroma across a full turn —

| hue | 0 | 45 | 90 | 150 | 255 | 345 |
|---|---|---|---|---|---|---|
| worst compressed shift | 28.9° | 2.2° | 15.9° | 0.6° | 18.0° | 0.9° |

Peaking at red, near zero at cyan. That is hue-dependence, which is exactly why
the ACES compressor carries per-primary limits — so it appears to point at the
hue-aware option.

**It does not, and the measurement is decisive.** Sweeping the threshold at the
worst hue, which is what a per-hue limit varies:

| threshold | 0.7 | 0.8 | 0.9 | 0.95 | 0.99 |
|---|---|---|---|---|---|
| worst shift at red | 34.9° | 32.6° | 28.9° | 25.9° | 22.7° |

The entire range spans 34.9° to 22.7°, and **clipping itself is 22.3°**. A
hue-varying threshold is a continuous slide toward clipping and cannot get below
what clipping already costs. It could not make the bound true, so the choice is
to re-measure and restate.

### The documented claim was false in a second way

`display.ts` said the operator preserved hue "to floating point, not
approximately", citing a colour holding its CIELAB angle exactly. Measured, that
colour moves **17.1 degrees**.

Two different claims had been merged. The chroma vector's direction in *linear
sRGB* is preserved exactly — the cosine between before and after is
1.000000000000, and that is now asserted. CIELAB hue is a nonlinear function of
the same values, and a straight line toward the achromatic point in linear RGB is
not a constant-hue line in CIELAB. The deviation is the Abney effect and is real.

### The bound, measured over everything the pipeline can reach

A dense sweep of linear sRGB from −0.6 to 2.0 per channel, covering the negatives
wide-gamut conversion produces and the values above one that exposure and the
grade produce:

- worst compressed CIELAB hue shift **63.0°**
- worst clipped CIELAB hue shift **91.4°**
- compression at least as good as clipping on **79.8%** of samples

So compression has the better worst case and is better most of the time, and is
**not uniformly better**. That is what is now documented and asserted.

## Stage positions, for every pass

Contrast ran at the end of the grade stage for two stages while every pass
involved was individually correct. No agreement test could see it — each pass
matched its own reference. No identity test could see it — each was exactly the
identity at neutral. It was an **ordering defect between correct passes**, and
the only positions asserted anywhere were exposure and contrast from Stage 4.

`tests/unit/pass-positions.test.ts` now asserts a relative-order constraint per
pair, never an index: indices are shorter to write, break on every pass added,
get relaxed on every pass added, and assert nothing within two stages.

**The coverage rule is the part that keeps working.** Every registered pass must
appear in the constraint table or in an explicit exemption list with a reason, so
a pass added without a declared position fails rather than passing silently.
Registration was extracted to `src/render/passes/registry.ts` so the test asserts
the real list rather than a copy — a test that restates the array proves only
that someone typed the same thing twice.

Three mutations watched: contrast returned to the end of the grade stage (2
failures), grain moved before the film curves (1), and a new pass registered with
no declared position (caught by the coverage rule).

## Two method fixes, in one helper

`tests/support/readback.ts` exists because both mistakes are structural rather
than slips.

**Colour space.** Reading `displayMode: 'identity'` output as linear ACEScg has
happened twice, both times immediately after writing the comment explaining why
it is wrong. The mode names what the pass *does*, not what space its output is
in. A readback now carries `space` with it, `assertSpace` makes a caller say what
it expects, and there is deliberately no `'linear-acescg'` member — nothing can
produce one from a final-target render, and offering the name would invite the
assumption.

**Row orientation.** `readPixels` is bottom-up, and indexing rows directly
produced a comparison against zero samples that passed silently. The helper flips
once on the way out and exposes `at(x, y)` in image coordinates, never an index.

The audit of existing helpers found sixteen specs reading pixels back. Three
indexed rows without compensating; two of those compare frames element-wise or
derive the level from the measurement, so orientation cancels. The third,
`grain.spec.ts`, selected a "band near middle grey" by row index and landed
somewhere usable only because the ramp is symmetric about its middle — both bands
now select by measured level.

## The lens stage

Four passes between scene and film, in the order the glass does it: the image is
bent, split by wavelength, scattered, and falls off toward the corners.

### A tile test for a radial effect must put its seams where the radius is large

The first tiling used a 2x2 split through the middle of the frame, and the
declared overlap turned out not to matter at all — **identical disagreement at
every overlap from 55 pixels down to 2**.

Radial displacement goes as `r^3` for distortion, so a split through the centre
puts every interior seam exactly where the effect displaces least. The largest
displacement is at the corners, and the corners sit on the image boundary where
every tiling clamps the same way. So the one arrangement that looks like the
obvious tiling is the one that cannot see the failure.

Moved the split outward, to 400 of 480 and 300 of 360, and the overlap became
load-bearing:

| overlap | 55 (declared) | 20 | 8 | 2 | 0 |
|---|---|---|---|---|---|
| worst disagreement | 4.9e-4 | 4.9e-4 | 3.4e-2 | 5.1e-2 | 6.1e-2 |

The declared value is the corner bound and so is conservative for seams that are
not at a corner. That is the right direction to be wrong in: an under-declared
overlap is a seam in an export and an over-declared one is wasted margin.

This is the third refinement of the same rule. Vary the scale, vary every axis,
and now: **vary the position, to where the effect is actually largest.**

### Two mutations, each failing exactly what depends on it

| Mutation | Fails | Passes, and why |
|---|---|---|
| frame position read from the buffer alone | 6 of 7 | diffusion — it never asks where it is |
| source rect dropped from the inverse mapping | 5 of 7 | diffusion and vignette — neither resamples |

### The shape needed its own test

Identity and tiling would both accept a `cos^2` where a `cos^4` was meant: it is
exactly 1 at the centre either way, exactly the identity at zero either way, and
tiles identically either way. `vignette.spec.ts` compares the rendered falloff
against the reference across the whole frame and catches it at 2.0e-1, while
every tiling assertion passes. It also catches a radius normalised by the
half-width rather than by the corner, at 8.7e-2.

### What the photographs show

- **Distortion resamples cleanly.** No staircasing or aliasing on the hard black
  screen bezel even at ±0.15, where displacement at the frame edge is largest.
  Bilinear from the intermediate target's own `LINEAR` filter is enough; nearest
  would not have been, and the crops are where it would have shown.
- **Chromatic aberration is convincing while it is subtle.** At 0.001 it is a
  faint warm fringe on one side of a high-contrast edge and a cool one on the
  other, which is what a lens does. 0.003 is at the strong end of plausible. By
  0.008 it is magenta and green banding and obviously an effect. So the useful
  zone is the bottom third of the slider, which is what the range was chosen for.
- **Diffusion and halation are not redundant, and the difference is obvious.**
  Halation leaves the screen bezel black and the wall untouched and blooms only
  genuine highlights, warmly. Diffusion lifts *everything* — the bezel's black
  goes grey and the whole frame hazes — neutrally. They are a selective local
  effect and a global one. Both earn their place. Diffusion's useful range is
  also the bottom third: 0.3 already lifts blacks substantially.
- **The vignette reads as an aperture.** It follows the frame's shape rather than
  a circle, is flat near the centre and accelerates outward — the `cos^4`
  signature — and does not read as a darkened overlay laid on top.

### The vignette passes through the characteristic curves, measurably

It runs before the film stage, so its darkening is exposure the film then
develops. The same vignette at 0.7 under three stocks, as corner-to-centre ratio
in linear terms:

| stock | ratio |
|---|---|
| punchy-reversal | 0.516 |
| warm-portrait | 0.593 |
| muted-documentary | 0.663 |

A 15% spread, in the direction the physics predicts: the contrastiest stock
deepens the vignette most and the flattest one softens it. Correct, and confirmed
to look correct rather than merely being defensible.

### All four together

At plausible settings with a stock, halation and grain, it reads as a photograph
taken through a lens onto film rather than as a stack of effects. The barrel is
subtle enough to be felt rather than seen, the vignette follows the frame, and
the diffusion and halation combine into one glow rather than two.

## A corrected test requires checking what cited it

"Preserved to floating point" survived in prose after the measurement that
licensed it was found to support only half of a merged claim. The code was
corrected; the sentence citing it was not.

That is a pattern rather than an instance, and it has a specific shape: **a claim
outlives the test that justified it, because correcting a test changes a file
nobody greps for prose.** So when a test is found circular, rescoped or
overturned, the work is not finished until what cited it has been checked.

Swept for it. Three findings, one of them a real defect:

| Location | Claim | Status |
|---|---|---|
| `COLOUR_PIPELINE.md` display transform | "without it, out-of-gamut values clip per-channel, which shifts hue" — implying compression does not | **False by implication.** Compression shifts hue too, up to 63°, and loses to clipping on 20% of the space. Corrected with the measured table. |
| `ARCHITECTURE.md` build order | "**Lens** — vignette, chromatic aberration, diffusion, distortion" | **Backwards.** The execution order is the reverse, and the position test now asserts it. Corrected, with a note that prose cannot hold an ordering. |
| `ARCHITECTURE.md` §11 worked example | describes the vignette as hypothetical, with parameter and file names that are not the ones that shipped | **Stale.** Marked as the recipe, with a pointer to the real files and a note that where they disagree the code is right. |

The round-trip section in `SHADER_CONVENTIONS.md` was checked and is accurate: it
describes the leg-by-leg fix rather than the round trip it replaced, which is
what a corrected doc looks like.

## The seam-placement rule

The fourth refinement of the degeneracy rule, and the one that generalises
furthest: **a tiling must place its seams where the effect is strongest, not
where the image divides evenly.**

The natural tiling of an image is a split through the middle. For a radial
effect that is the worst possible choice, and not by a little:

- Radial displacement goes as `r^3` for distortion, so a centre split puts every
  interior seam exactly where the effect displaces least.
- The maximum displacement is at the corners, and the corners lie on the image
  boundary, where every tiling clamps identically and no seam can exist.

So the arrangement that looks like the obvious tiling is precisely the one blind
to the failure. Measured: identical disagreement at every overlap from 55 pixels
down to 2 with a centre split, and a clean progression from 4.9e-4 to 6.1e-2 once
the split moved to 400 of 480.

It applies to anything with radial falloff — the vignette, both lens geometric
passes, and any future optical effect — and it is why the export's own tiling
tests use off-centre splits rather than a grid.

The four refinements together:

1. Test where the two formulations differ, not where they coincide.
2. Vary every axis the parameter depends on, not just one.
3. Vary origin and scale together, since an error can vanish when either is trivial.
4. Place seams where the effect is strongest, not where the image divides evenly.

## Getting a tile onto the GPU when the source is larger than MAX_TEXTURE_SIZE

Deferred since Stage 3, blocking at export. Measured limits:

| backend | `MAX_TEXTURE_SIZE` |
|---|---|
| SwiftShader (LLVM) | 8192 |
| Apple M5, Metal | 16384 |

A 60MP source at 3:2 is about 9600×6400, so on the software rasteriser — and on a
meaningful share of real hardware — the full-resolution texture cannot be created
at all. The interactive path sidesteps this by decoding to proxy size. Export
cannot.

### The answer had to be pixels, not the absence of an error

A sub-rect upload that silently ignores its offsets produces a texture full of
the wrong part of the photograph and throws nothing. So the fixture encodes its
own coordinates — red is `x mod 256`, green `y mod 256`, blue names the
256-pixel block — and any single pixel identifies where it came from. "Did the
right region land" is then decidable rather than an impression.

### Both work, and one is an order of magnitude faster

20 tiles of 2048 from a 9600×6400 source. Correctness is identical on both
backends — **20 of 20 tiles land in the right place, both ways** — which was the
cross-check worth making: pixel-store parameters applied to a DOM source are
exactly the sort of thing that is specified and then implemented differently, and
a probe on one backend would not have settled it.

| | SwiftShader | Metal | full bitmap held |
|---|---|---|---|
| decode once | 86 ms | 68 ms | — |
| **pixel store**, per tile | **4.7 ms** | **9.1 ms** | yes, 246 MB |
| **crop rectangle**, per tile | 57 ms | 68 ms | no |

**The ratio depends on the file, and the first measurement overstated it.** An
earlier run against a differently-encoded PNG of the same image measured 250 ms
per tile for the crop path against 287 ms for a whole-image decode — a factor of
forty rather than twelve. The crop path's cost is a decode, so it tracks whatever
the codec and the file make a decode cost, and a single number for it would be a
number about that file.

What does not vary: the crop path re-decodes the whole file per tile rather than
decoding the region, so its cost is the whole-image decode multiplied by the tile
count, whatever that decode happens to be.

### The decision, and the memory it costs

**Option 1 is the export path; option 2 is the fallback.** The trigger is not a
memory heuristic but the honest condition: if `createImageBitmap` of the full
image throws, option 1 is impossible and option 2 is what is left. Memory
pressure is not observable but that failure is.

The 240MB peak deferred at Stage 3 is real and unavoidable on this path: the
bitmap is `9600 × 6400 × 4` = **245.76 MB**, held for the duration of the export.

The probe builds its own fixture in the page rather than reading one from disk.
The first version read a file that existed only on the machine that wrote it, so
it passed locally and failed in CI — a probe that needs a fixture nobody else has
is a probe that runs nowhere else.

That figure is arithmetic, not a measurement, and the distinction matters.
`performance.memory` reports 15 MB before and after the decode, because an
`ImageBitmap` does not live on the JS heap — so the JS heap reading is not
evidence of anything and quoting it as one would be worse than quoting nothing.
`performance.measureUserAgentSpecificMemory()` does see it and refuses to run:
the page is not cross-origin isolated, which needs COOP and COEP headers a static
site on Pages would have to be configured for. Recorded as a limit of the
measurement rather than papered over.

## Export

### What tiling being real found

Every spatial pass declared a tested overlap, and every one of those tests used a
fixture built to exercise that one pass. Export runs them all at once, and two
coupled defects fell out immediately.

**The intermediate buffers covered only the tile's own region.** The overlap
existed solely in the source texture, so only `imageSource` could use it; every
pass after it read a buffer that stopped at the tile edge and clamped. Tiles are
now rendered over their expanded region and the inner region is read back from
inside it.

**`requiredOverlap` returned the maximum**, with a comment arguing each pass
needs only its own kernel's worth of margin. That is wrong once buffers carry the
margin, because spatial passes chain: the first corrupts a band as wide as its
reach at the buffer edge, and the next reads that band and widens it. The sum is
what the chain consumes. With four spatial passes enabled the maximum was 218
source pixels and the sum is 311; the missing 93 showed as a **three-code-value
seam** along the boundary.

Summing gets separable blurs right for free — two passes each declaring the same
reach need it twice — which is why `tile-overlap.spec.ts` now asserts twice the
single reach.

### The parity test compares against 1:1, not against the proxy

The reference leg renders the whole frame at 1:1 from a full-resolution texture.
Comparing against the actual interactive proxy would fold in the documented
resize-at-decode deviation, fail for that reason, and say nothing about tiling.
Grain is pinned above the representable limit per the Stage 7 decision, and the
scope is stated in the test.

| comparison | worst | samples differing |
|---|---|---|
| tiled export vs whole-frame 1:1, everything enabled | **1 code value** | 0 of 667,000 |
| two tilings of a 48MP source that exceeds `MAX_TEXTURE_SIZE` | **1 code value** | 0 of 1,322,112 |

The second has no whole-frame reference available — the texture cannot be
created — so two exports at different tile sizes are compared instead: their
seams land in different places, so agreement is evidence neither has one. Grain
is the strictest part of it, being a hash of the source coordinate: a tiling that
shifted it by one pixel would disagree everywhere at once.

**It first ran everything at 61MP, took 1.7 minutes locally and timed out in CI**
— a test that runs nowhere rather than a thorough one. Its distinct contribution
is that the source does not fit on the GPU; whether each pass is individually
right under tiling is the first test's job, and that one is stronger for having a
real reference. So the effect set was trimmed to grain, distortion, aberration,
the vignette and one Gaussian kernel, the fixture's x-dependent terms are
computed once rather than 48 million times, and it now runs in 34 seconds.

### Two of the four seam mutations needed the fixture fixed, not the code

- **Halation** at a threshold nothing near the boundary exceeded produced no halo
  to lose, so starving its overlap changed nothing.
- **Lateral aberration** displaces only five pixels at the seam's radius, and the
  bar placed to catch it *straddled* the boundary — so the correct sample and the
  clamped one both landed inside it. The edge has to fall between them: for a
  pixel just past x=2048 the red channel should read x=2042.5 and, clamped, reads
  x=2048.

Both are the seam-placement rule again, once about a tonal threshold rather than
a radius. **An effect has to be present at the boundary for a boundary test to
mean anything**, and "present" means its output actually differs across the few
pixels the clamp affects.

### Cost, on a real 24MP photograph

6000×3999, 6 tiles, 409px overlap, via the pixel-store path:

| | size | time |
|---|---|---|
| JPEG, quality 0.92 | 2.4 MB | 965 ms |
| PNG | 31.4 MB | 1166 ms |

Peak memory, **arithmetic rather than measured** for the reasons recorded in the
probe section:

| | 24MP | 60MP |
|---|---|---|
| full `ImageBitmap` | 96 MB | 246 MB |
| output canvas | 96 MB | 246 MB |
| resolve target, RGBA8 | 33 MB | 33 MB |
| RGBA16F intermediates | ~131 MB | ~131 MB |
| **total** | **~360 MB** | **~660 MB** |

The **output canvas is a second full-resolution buffer**, which the Stage 3
estimate of 240MB did not account for — it doubles at 60MP rather than being the
whole of it.

### Looking at the exports

- **No seam, at any zoom.** Measured as the mean absolute difference between
  adjacent columns at the tile boundaries against neighbouring columns: 1.029 vs
  1.056 at x=2048, 0.776 vs 0.793 at x=4096, 0.731 vs 0.716 at y=2048. The
  boundaries are statistically indistinguishable from anywhere else.
- **The proxy-decode gamma deviation is measurable and not visible.** Isolated by
  box-averaging the same source in the encoded domain and in linear light:
  **mean 0.054 code values**, 99th percentile 1.29, worst 15.6. It is confined to
  detail exactly as documented — **1.47 code values across the busiest 1% of the
  frame and 0.001 across the flattest half** — and the encoded version is darker
  on 61.7% of pixels, which is the direction the deviation predicts.
- **The export's grain is what the inspector led me to expect.** Fine, coloured,
  a few pixels of correlation length, reading as emulsion rather than noise. The
  inspector was built because grain could not be judged in the preview; it turned
  out to be an accurate predictor of the file.

## Persistence

Presets already persisted. This is the rest of the session: the edit for each
image, so reopening the application and then reopening the photograph restores
where you were.

### What identifies an image, and what is stored

Name, byte length and modification time. **Not a content hash** — hashing 60MP on
every open costs more than the feature is worth, and the three together are
stable for the same file and different for a different one in every case that
matters. Two distinct files agreeing on all three is possible; the consequence is
that one photograph opens with another's edit, which is visible immediately and
undone by one press of reset.

The **patch**, not the whole state, for the same reason presets store one: a
record written by an older build should contribute what it knows and let this
build's defaults supply the rest rather than pinning fields it never heard of.

**Source images are not stored.** They are reopened from disk. Writing every
photograph you open into browser storage is not something the user asked for, and
at 60MP a time it is not a small thing to do quietly.

### Reopening without the source: the edit waits

The edit exists and has nothing to apply to. It **waits**, keyed to its file, and
reattaches when a file matching the key is opened.

The rejected alternative is to restore the most recent edit whatever is opened
next. That looks more helpful and is wrong on the second photograph: exposure and
white balance are decisions about the light in *that* scene, so carrying them to
a different file is not restoring work, it is corrupting a new photograph with an
old one's edit. Asserted directly — opening a different image after a reload
restores nothing.

### The boundary, five stages on

`EditState` is what the photograph is; `ViewState` is how you are looking at it.
The split was drawn at Stage 4 and has since taken parameters from five stages,
and it is exactly the sort of line that stays right while someone remembers why
and then quietly stops, because putting a parameter on the wrong side is one line
and nothing complains.

Asserted from the registry rather than a hand-maintained list:

- every parameter survives a JSON round trip, moved off its default first so the
  trip carries something, and at both ends of its range
- `EditState` and `ViewState` share no key
- a viewing setting offered in a preset or a stored record is **dropped**, not
  merged
- the roll-off knee is on the edit side and the gamut threshold is not — the
  asymmetry is the boundary being drawn rather than defaulted

Two mutations watched: a viewing setting added to `EditState` (caught by the set
difference and by the knee assertion), and `sanitisePatch` letting an unknown key
through (caught in four places across three files).

`ViewState` not persisting is asserted end to end as well: the inspector's
position and the debug display modes are set, the page reloaded, the same image
opened, and the edit comes back while the viewing settings do not.

## Timeout headroom

The 61MP export test ran 34 seconds locally, exceeded a 600 second timeout on CI,
and **failed on two consecutive pushes before anyone noticed**, because the local
suite was green and nothing was reading how long anything took.

That is the second check in this repository's history to pass by not running. The
first was `tsc --noEmit` at Stage 2. Both had the same shape: **the signal was
available and nothing was looking at it.**

`tests/support/headroom-reporter.ts` prints every test's duration as a fraction
of its own timeout, warns past a quarter and **fails the run past a half**.

### Why those fractions

Measured, not guessed. The same CI job on this repository has taken between
**6m13s and 19m50s** for equivalent content — a factor of three in runner speed
alone, before any change to the suite. A test comfortable at 30% on a fast runner
is at 90% on a slow one, which is the failure this exists to prevent. Half leaves
a 2x margin, already thinner than the observed variance; a quarter leaves 4x,
which is roughly where variance alone stops being survivable.

The slowest tests print whether or not anything crossed a line. The thresholds
catch drift that has gone too far; the listing is what lets someone notice a
stage earlier.

### It found three things on its first CI run, and corrected a number

Locally it flagged one test at 27% of the default 30 seconds. On CI it failed the
run with three past half:

| | CI | local | multiplier |
|---|---|---|---|
| frame-timing probe | **71%** — 127.1s of 180s | 12.8s | 9.9x |
| oversized export | **55%** — 330.7s of 600s | 34s | 9.7x |
| display transform | **53%** — 16.0s of 30s | 2.1s | 7.6x |

**The important number here is the multiplier, and this repository had it wrong.**
Job-level variance is a factor of three, which is what the thresholds were
originally reasoned from. Per test, CI is six to ten times slower. At a 30 second
default that puts ordinary rendering tests past half their timeout on CI while
looking comfortable locally — the exact shape of the failure the reporter exists
to catch, and one it caught in its own justification.

The response is the one the reporter's message prescribes: the default timeout is
raised once, globally, to 120 seconds, and the two genuinely long tests were
raised deliberately rather than trimmed further. Nothing is now above 14%.

Note what did *not* happen: the threshold was not loosened. A check that fires
and is then relaxed to stop firing is worse than no check, because it also
carries the appearance of one.

Watched fail: with a timeout tight enough to put a passing test at 66%, the run
exits non-zero and names the test; restored, it exits zero.

## Export off the main thread

A 60MP export renders tens of tiles through the full pass chain and encodes a
quarter of a gigabyte of pixels. On the main thread that is seconds of frozen
interface.

### What it took to share the pass chain

**One type widened.** `RenderContext.canvas` accepts an `OffscreenCanvas` as well
as an `HTMLCanvasElement`, and `createRenderContext` takes either.

That is the whole of it, because `RenderGraph` was built around `gl` rather than
around a canvas at Stage 3, so nothing between the graph and the passes has ever
known there is a DOM. Only `Renderer` reads the canvas — for `clientWidth` and
for the CSS size the drag proxy must not disturb — and it now keeps its own
`HTMLCanvasElement` reference rather than reading it back off the context. The
export path does not use `Renderer` at all.

The worker imports the graph, the passes, the shaders and `exportImage` from
where the interactive path gets them. **Asserted, not asserted-about**: the
worker's PNG is compared byte for byte against the main thread's, on a tiled
export, and they are identical. Two render paths that agree the day they are
written drift afterwards, and this is the only thing standing between "shares the
chain" and "has a copy of it".

One build change was needed: Vite gives workers their own plugin pipeline, and
the export worker is the first to import a shader. Without the GLSL plugin in
`worker.plugins` the build fails on the first line of GLSL it meets.

### The compile cost does not matter

A worker cannot share a GL context, so it has its own program cache and the first
export compiles every enabled pass. Measured over three consecutive exports of
the same 2400×1600 source: **1978 ms, 2150 ms, 2088 ms**. The first is the
*fastest* of the three — the compile is below the run-to-run noise of the export
itself, and it is paid once per worker rather than once per export.

### Cancellation needed a yield, and would not have worked without it

`shouldCancel` is checked between tiles, and the check could never have seen a
cancellation. On the pixel-store path the whole tile loop is synchronous, so a
worker running it never returns to its message queue: a `cancel` posted from the
main thread sits undelivered until the export has already finished. A microtask
would not help either — `postMessage` delivery is a task.

Watched: without a `setTimeout(0)` between tiles the cancellation test fails with
the export running to completion.

### Peak memory: measured by proxy, and why

Cross-origin isolation **is configured** — `public/_headers` for the deployed
copy, `server`/`preview` headers in `vite.config.ts` for local — and verified:
`crossOriginIsolated` is `true` in both the window and the worker.

`measureUserAgentSpecificMemory` still cannot be used, for two reasons, both
measured rather than assumed and both asserted so that the day either changes,
the test says so:

1. **It is not exposed in a worker at all.** Inside the export worker
   `crossOriginIsolated` is true and the property is absent; the only
   measure-shaped members of `performance` there are `measure` and
   `clearMeasures`.
2. **In the window it rejects** with `SecurityError: performance.measureUserAgentSpecificMemory
   is not available` — isolated, and also with
   `--enable-blink-features=PerformanceMeasureMemory` and `--site-per-process`.

So the peak is **not** reported as a number of bytes. This project has already
reported arithmetic as measurement once, and the honest alternative is a proxy
that answers the question the number was wanted for: how large a source can
actually be exported.

Measured on the **software rasteriser**, which is the worst case available:

| source | tiles | time | result |
|---|---|---|---|
| 12MP, 4243×2829 | 6 | 6.8 s | OK |
| 24MP, 6000×4000 | 6 | 9.8 s | OK |
| 40MP, 7746×5164 | 12 | 20.2 s | OK |
| **61MP, 9566×6377** | 20 | 38.9 s | **OK** |

61MP exports successfully on a software rasteriser, at roughly 0.64 s per
megapixel and linear in pixel count. **So the reduced-resolution export option
B3 offers as a mitigation is not needed**, and it is not built — the measurement
was taken to decide that rather than to justify it.

### Failing cleanly

An export whose output canvas cannot be allocated rejects with a message, leaves
the page responsive, and **leaves the worker usable** — a subsequent export of a
normal source succeeds. Tested by asking for a 200,000 × 200,000 output, which no
browser will allocate.

A worker whose context cannot support the pipeline fails loudly with
`ExportUnsupported`, per the standing rule, rather than quietly producing an
8-bit approximation of the picture.

## The gamut question, settled empirically

Stage 6 recorded that gamut compression is *not* uniformly better than clipping
and left the fix as "a decision about the compressor". That decision needed a
number nobody had: on real photographs at grades anyone would actually apply,
how much of a frame lands where compression loses, and by how much. This is that
measurement. **No fix is implemented here** — the brief asked for the number
first, and the number changed what the fix should be.

### How it was measured

Every pointwise pass composed in Node from `src/core/colour/`, run over real
photograph pixels, stopping at the input to the display transform — which is the
quantity the whole question is about. Full float precision throughout, which is
the reason it is not done in the browser: an out-of-gamut colour has negative
channels, and an `RGBA8` readback cannot carry one.

The three spatial passes — diffusion, halation, grain — are excluded, because
they have no pure-TypeScript form to compose. That exclusion biases the answer
**downward**: halation injects saturated warm light into exactly the highlights
that are already near the boundary. Everything reported here is therefore a
floor.

`tests/render/gamut-chain-agreement.spec.ts` is what makes that composition
trustworthy. The individual colour functions are already asserted against their
shaders; what is not otherwise checked anywhere is the *order* and which encode
each pass sits inside, and getting that wrong would produce a census of a
pipeline this project does not have. It renders the same frame both ways with
the spatial passes off on both sides:

| grade | passes exercised | worst | samples differing |
|---|---|---|---|
| teal-orange | film curves, contrast, lift/gain, HSL | **1 code value** | 5.7% |
| faded-document | film curves, contrast, lift, split tone, HSL | **1 code value** | 4.4% |
| wb, exposure, wheels, split | white balance, exposure, tone curve, all three wheels, split tone | **1 code value** | 7.7% |

Every pointwise pass appears in at least one row. Half-float on the GPU against
float64 in Node cannot agree exactly; one code value is the same bound the export
parity test carries.

It reads the photograph committed under `docs/images/` and decodes it in the
page, so it runs anywhere the suite runs. That is a correction: the first
version read its frame from a scratch directory named after a session, which
would have made it skip on every machine forever while this document cited it
in the present tense. **That would have been the third check in this repository
to pass by not running** — after `tsc --noEmit` at Stage 2 and the oversized
export test at Stage 10. Three is a pattern rather than three accidents: the
common cause each time was a check whose *inputs* were not part of the thing
being checked.

It also caught something on its first honest run, which is the argument for
having written it. The tone curve grade disagreed by **15 code values on 93% of
the frame**. The chain was right; the harness was wrong. Node built its state
through `mergeEditState`, which sanitises every value, while the browser got the
raw patch — so a curve endpoint written as a rounded literal was adjusted on one
side only and the two sides graded differently. Both now receive the sanitised
state. A test comparing two things that were never the same measures nothing,
and the failure was large enough to be obviously structural rather than
tolerance drift, which is the only reason it was not mistaken for one.

### The partition, which the first run forced

The first run measured one number — "pixels where compression is worse than
clipping" — and it was close to meaningless, because it averaged two populations
that want opposite conclusions.

**The clamp only bites where a channel is negative.** The tone map already brings
everything above 1 back inside, so on a colour with no negative channel the
clipped path *is* the untouched path. Clipping does nothing there.

**The compressor's `distance` is not out-of-gamutness, it is saturation.** A pure
display primary sits at `distance = 1`, comfortably past the 0.9 threshold and
entirely inside the gamut. `display.ts` says so in its own comment. So the
compressor acts on a large population that clipping would never have touched.

Those are different questions and are reported separately from here on.

### The correction that changed every out-of-gamut number

The neutral edit — sRGB in, sRGB out, the identity in exact arithmetic —
reported **0.34% to 2.01% of pixels as out of gamut**. That is impossible, and it
was the `ACESCG_TO_SRGB · SRGB_TO_ACESCG` round trip landing a channel at
-2.2e-16 instead of 0.

Measured rather than assumed: over a sweep of the 8-bit cube the worst negative
the round trip produces anywhere is **2.22e-16**, one ulp, and the count falls to
zero at any epsilon from 1e-12 upward. The census now requires a channel below
**-1e-9** — seven orders above that noise, six below the 1/255 that could change
an output code value.

This is the third time in this repository a measurement has been wrong because
something at the floating-point floor was read as a physical effect. It is worth
saying plainly: **a fraction-of-pixels metric with no epsilon measures the
arithmetic, not the picture.**

### The census

One photograph, 0.61MP, at the default threshold of 0.9.

The frame deserves a sentence, because what it is makes every number here more
conservative than it looks. It is not a camera original: it is
`docs/images/original.jpg`, an export of one through this pipeline at a neutral
edit — so the tone map, the clamp and *the compressor under study* have already
run once — then downscaled to 900px and JPEG encoded at 4:2:0, which carries
chroma at half resolution in both axes. Each of those pulls the saturation
distribution inward, and the subsampling and the downscale specifically average
away the small strongly-saturated features this is counting. Together with the
excluded spatial passes, everything below is a floor with three independent
reasons to be one. Percentages are of all
pixels in the frame. "Visible" is a hue shift of at least 1°.

| grade | out of gamut | compression worse | …visibly | worst | in-gamut compressed | …visibly | in-gamut p99 |
|---|---|---|---|---|---|---|---|
| neutral | **0%** | 0% | 0% | — | 1.65% | 0.23% | 3.4° |
| preset faded-document | 0% | 0% | 0% | — | 0.03% | 0% | 0.2° |
| preset soft-portrait | 0.05% | 0.02% | 0% | 0.8° | 2.37% | 0.08% | 2.6° |
| preset teal-orange | 5.18% | 1.85% | 0.71% | 61.4° | 14.28% | 2.55% | **38.8°** |
| preset night-push | 6.83% | 1.47% | 0.35% | 63.8° | 12.33% | 1.48% | 23.9° |
| soft-portrait +0.3 sat | 4.43% | 1.18% | 0.17% | 8.8° | 9.44% | 0.92% | 8.7° |
| teal-orange +0.3 sat | 27.82% | 6.48% | 2.79% | 61.4° | 17.36% | 3.14% | 39.7° |
| sat +0.3 only | 2.36% | 0.96% | 0.41% | 9.6° | 5.11% | 0.53% | 5.2° |
| sat +0.5 only | 5.98% | 1.87% | 0.69% | 13.7° | 10.29% | 0.68% | 4.5° |
| sat +1.0 only (max) | 27.65% | 5.84% | 1.38% | 19.4° | 15.78% | 0.85% | 4.3° |
| punchy +1.0 sat (max) | 41.63% | 8.05% | 3.00% | 27.6° | 12.87% | 1.53% | 22.4° |
| exposure +1.5 contrast 1.4 | 1.87% | 0.77% | 0.42% | **67.1°** | 6.46% | 1.97% | **57.9°** |

### What it says

**The Stage 6 finding is real on photographs, and it is not the biggest problem.**
Two shipping presets put 5–7% of a frame out of gamut, and compression ends
further from the true hue than clipping on a fifth to a third of those — but
visibly so on only 0.35–0.71% of the frame. The median loss where compression
does lose is **under half a degree**. The tail is what hurts: 61° and 64° worst,
and a p99 in the teens.

**The larger cost is on colours that were never out of gamut.** In every row the
in-gamut population is two to three times the out-of-gamut one, and there
clipping is the identity — so every degree is a pure loss with nothing on the
other side. teal-orange shifts **2.55% of the frame visibly, p99 38.8°**, against
0.71% visibly harmed out of gamut. A neutral edit with no grade at all still
moves 0.23% of the frame by a degree or more.

**Tone shaping alone reaches the region**, without touching saturation:
`exposure +1.5, contrast 1.4` produces the worst single shift measured, 67°, and
the worst in-gamut p99 at 57.9°. So this is not only an HSL problem, which is
what Stage 6's construction implied.

**The desaturating preset is untouched** — faded-document is 0% and 0.03%. The
harm scales with saturation, exactly as the mechanism predicts.

### Threshold sensitivity

`gamutThreshold` moves both harms the same way, monotonically. Fraction of the
frame shifted visibly:

| threshold | teal-orange oog worse | teal-orange in-gamut | night-push in-gamut | neutral in-gamut |
|---|---|---|---|---|
| 0.70 | 1.54% | 12.44% | 10.00% | 1.62% |
| 0.80 | 0.85% | 6.20% | 3.82% | 0.84% |
| 0.85 | 0.73% | 4.27% | 2.18% | 0.53% |
| **0.90** (default) | 0.71% | 2.55% | 1.48% | 0.23% |
| 0.95 | 0.62% | 1.00% | 0.72% | 0.02% |
| 0.99 | 0.45% | 0.19% | 0.10% | 0% |

Raising it helps both populations, and helps the in-gamut one far more — an
order of magnitude between 0.9 and 0.99, against a third on the out-of-gamut
side. The out-of-gamut population size never moves, because that is a fact about
the grade rather than about the operator.

There is a cost, and it is in the tail rather than the count: for night-push the
p99 loss where compression loses rises from 20.5° at 0.9 to **36.5° at 0.99**.
With less runway between the threshold and the colour's actual distance, the
compression that does happen is more abrupt. Raising the threshold trades a much
smaller number of harmed pixels for somewhat worse harm on the ones left.

### The recommendation, not implemented here

The threshold is the wrong control, and moving it is a palliative. The defect the
numbers point at is that **`distance` measures saturation and is used as though
it measured gamut excursion**. That is why the largest population of harmed
pixels is one that was never out of gamut: the operator cannot tell "saturated"
from "outside", so it treats the first as the second.

Two candidates, in the order I would try them:

1. **Gate compression on an actual excursion.** Leave a colour alone when no
   channel is negative, regardless of how saturated it is. On this evidence that
   removes the entire in-gamut column — the larger harm — and cannot make the
   out-of-gamut column worse, because it changes nothing there. It also restores
   the property `display.ts` currently has to disclaim, that an in-gamut colour
   is unchanged.
2. **Then** revisit the out-of-gamut operator on what remains, where the honest
   summary is still Stage 6's: better on average, worse in a tail that reaches
   60°, and not correlated with how far outside the colour is.

Doing (1) first is what the partition argues for, and it is the smaller change.

### What this does not measure

Hue only, on one photograph, with the three spatial passes excluded.

Clipping also destroys chroma and shifts lightness, and none of that is in these
numbers — so "compression loses" throughout means "loses on hue", which is
narrower than it sounds and is the axis most favourable to clipping. A wider
census wants more frames; the four-frame set this was first run on was lost to a
scratch-directory wipe, and the surviving frame is the one committed under
`docs/images/`.

Those four-frame runs predate the epsilon correction above, so their
out-of-gamut counts were inflated and their exact numbers are not quoted here.
What did carry across all four, and is worth having: the ordering of grades was
the same, the in-gamut population outweighed the out-of-gamut one on every frame
and grade, and faded-document reached neither region on any of them.

## The gamut gate

The census above said the compressor's defect was in its **trigger**, not its
operator: `distance` measures saturation and was being read as though it
measured excursion. This is that change, and the two things it turned up that
were not in the plan.

### The gate, and the assertion it earns

The trigger is now a negative channel after the display matrix. A colour inside
the display primaries is returned exactly.

That is written as an assertion rather than a measurement, which is the point of
doing it: **an in-gamut colour is unchanged, bit for bit**, at any threshold,
over a dense sweep of the cube and at every named boundary case. It is the same
standard white balance meets at neutral (the pass is skipped) and HSL meets at
neutral (bit-exact through the `mix` form). Until now the compressor was the only
pass in the pipeline that altered an unedited photograph.

`display.ts` used to carry an argument for why that guarantee was unreachable —
a pure display primary sits at distance 1.0, so any smooth curve must start below
1.0 and touch it. The argument is valid. Its premise, that the trigger had to be
that distance, was not.

**Watched fail.** Reverting to the distance trigger fails the new assertion on
`[1, 0, 0]`, which comes back `[1, 0.05, 0.05]` — the "0.05 of its own achromatic
value" the old comment disclosed as the accepted cost, now a test failure rather
than a footnote. The dense sweep also catches `[0, 0, 1e-7]`, where a nearly
black pixel had its red channel lifted off zero.

### The gate broke the operator, and the algebra says it had to

The gate alone was not shippable, and the census-agreement spec is what caught
it: the composed chain and the renderer went from agreeing within 1 code value to
disagreeing by **108**.

Diagnosed rather than guessed. Dumping every disagreement over 2 code values and
bucketing by how close the smallest channel was to zero:

| \|min channel\| | pixels | worst |
|---|---|---|
| < 1e-4 | 226 | 104 |
| 1e-4 .. 1e-3 | 14 | 108 |
| 1e-3 .. 1e-2 | 1 | 3 |
| ≥ 1e-2 | **0** | — |

240 of 241 sat within 1e-3 of the boundary. Half float carries about three
decimal digits, so the GPU and Node disagree about the *sign* of a channel that
close to zero — one compresses and the other does not.

The sign disagreement is inherent to gating on a sign. What made it cost 108 code
values was the shoulder. With a knee at `k` the operator steps by `(1 - k) / 2`
the instant a channel crosses zero, **however small the crossing**: at `k = 0.9`
that is 0.05 of the achromatic value, so a pixel 0.00006 outside the gamut with an
achromatic value of 2.75 moved 104 code values. Measured directly: a change of
**1e-12** in the input produced a **63 code value** jump in the output.

The step vanishes only at `k = 1`, and at `k = 1` the shoulder degenerates to the
constant 1 — which is `scale = 1 / distance`. So with a gate, a soft shoulder and
continuity are mutually exclusive, and the operator is forced:

    scale = 1 / distance          desaturate to the boundary, no further

The property that matters is not continuity for its own sake but the bound it
implies:

    |change| <= |excursion|

A colour a hair outside the gamut moves a hair, so disagreement about a near-zero
sign costs a near-zero difference. It also moves colours *less* than the shoulder
did: the shoulder overshot to strictly inside the boundary, this lands on it.

Re-measured after the change: disagreements over 20 code values went **20 to 0**,
worst **108 to 3**, pixels differing by more than 2 went **241 to 4**. The
agreement tolerance is set at 5 from that distribution, with the reason recorded
in the spec — two precisions cannot agree on a sign test, and pretending
otherwise by driving the number to 1 would be fitting the test to a wish.

One consequence worth stating: the census needs an epsilon on "is this out of
gamut" and **the operator does not**. The census counts pixels, so a round-trip
error of 2.2e-16 counted as a whole pixel; the operator's effect is bounded by
the excursion, so acting on 2.2e-16 changes the colour by 2.2e-16. The epsilon
was only ever needed because the operator was ill-conditioned.

### A correction to the published census

The gate exposed an error in the previous section's method, and the numbers there
are superseded by the table below.

The in-gamut column was computed as the compressed path's hue shift against the
unclamped colour, justified by "clipping does nothing here". The clamp does
nothing on an in-gamut colour — **but the tone map does**. It is per channel, so
it bleaches a bright saturated colour toward white and moves its hue. With the
compressor gated off in gamut the old metric still reported a shift, which is how
the mistake surfaced: it had been measuring the tone map and attributing it to
compression.

The compressor's contribution is now isolated against the same pipeline with
compression switched off, so the tone map appears on both sides and cancels.

### Before and after, same frame, one binary

`tests/support/gamutCensus.ts` carries both operators and runs them over the same
photograph in one pass, so this is a comparison rather than two logs. Percentages
are of all pixels in the frame; the degree columns are fixed cut-offs so the two
rows share a denominator.

| grade | worse | ≥5° | ≥15° | in-gamut touched | in-gamut visible |
|---|---|---|---|---|---|
| neutral | 0 → 0 | 0 → 0 | 0 → 0 | 1.65% → 0.15% | **0.197% → 0** |
| soft-portrait | 0.022% → 0.001% | 0 → 0 | 0 → 0 | 2.37% → **0** | 0.021% → 0 |
| teal-orange | 1.85% → 0.86% | 0.270% → 0.122% | 0.026% → 0.018% | 14.28% → **0** | **0.961% → 0** |
| faded-document | 0 → 0 | 0 → 0 | 0 → 0 | 0.03% → **0** | 0 → 0 |
| night-push | 1.47% → 0.34% | 0.139% → 0.071% | 0.022% → 0.022% | 12.33% → **0** | **0.687% → 0** |
| teal-orange +0.3 sat | 6.48% → 3.82% | 1.149% → 0.709% | 0.226% → 0.130% | 17.36% → **0** | 1.396% → 0 |
| soft-portrait +0.3 sat | 1.18% → 0.33% | 0.040% → **0** | 0 → 0 | 9.44% → **0** | 0.603% → 0 |
| sat +0.3 only | 0.96% → 0.32% | 0.156% → **0** | 0 → 0 | 5.11% → **0** | 0.420% → 0 |
| sat +0.5 only | 1.87% → 0.56% | 0.226% → 0.033% | 0 → 0 | 10.29% → **0** | 0.468% → 0 |
| sat +1.0 only | 5.84% → 1.92% | 0.343% → 0.113% | 0.011% → 0.003% | 15.78% → **0** | 0.490% → 0 |
| punchy +1.0 sat | 8.05% → 4.73% | 1.040% → 0.683% | 0.092% → 0.031% | 12.87% → **0** | 0.654% → 0 |
| exposure +1.5, contrast 1.4 | 0.77% → 0.50% | 0.201% → 0.099% | 0.045% → 0.015% | 6.46% → **0** | 0.907% → 0 |

**In-gamut harm is gone, exactly.** Every grade, zero pixels visibly shifted,
maximum attributable shift 0.00°. That is the invariant holding on a photograph
rather than on chosen colours.

The one non-zero cell is `neutral`, at 0.15% touched and 0.00° shifted. Those are
the matrix round-trip pixels sitting at -2.2e-16: below the census's 1e-9 epsilon
so it files them as in gamut, genuinely negative so the operator acts. It changes
them by 2.2e-16. This is the bound doing its job, and it is why the operator
needs no epsilon of its own.

**Out-of-gamut harm roughly halved as well**, which was not the aim. Minimal
desaturation moves colours less than the overshooting shoulder did, so it wins on
the contested population too — at every fixed severity, on every grade.

### Does the operator still need work? Partly, and less than before

The p99 columns rise in two rows — night-push from 20.5° to 41.9° — and that is a
composition effect, not new harm. The p99 is taken over the pixels that are
worse, and that set shrank to roughly its own tail. The fixed cut-offs are
immune to this and they fall or hold everywhere, and the **maxima are unchanged**
at 61.4°, 63.8° and 67.1° — no colour is harmed more than it was.

So, to the question the brief asked:

- **The gate settles the in-gamut half completely.** Not "within a bound":
  exactly, and asserted.
- **It does not fix the tail** on colours that genuinely need compression. The
  worst single shift is unchanged, and the Stage 9 conclusion about hue-varying
  thresholds was measured on a population that included in-gamut colours, so it
  should be treated as unverified rather than as still standing.
- **The residual is small and now well-localised.** On the shipping presets,
  0.018–0.022% of the frame is harmed by 15° or more — about one pixel in five
  thousand. On the most aggressive grade the control offers, 0.13%.

My recommendation is that further operator work is **not** justified on this
evidence. The remaining harm is two orders of magnitude below what the gate
removed, and a constant-hue-path compressor is a root-find per pixel in a shader
— a large complexity increase for a residual this size. The case to revisit it is
if a wider frame set shows those pixels *clustered* rather than scattered, since
a hundred adjacent wrong pixels read as an artefact where a thousand scattered
ones do not. That is a measurement, and it belongs with the frame-set widening
rather than here.

### What the goldens did not catch

Every golden test passed unchanged, including the two-resolution invariant and
tile overlap, both before and after this change — including while the operator
had a 63-code-value cliff in it.

That is worth recording as a limitation of the fixtures rather than as
reassurance. The golden frames are synthetic gradients and patches; they do not
put pixels within 1e-3 of the gamut boundary, which is where all of this lives.
The defect was found by a census on a photograph and by an agreement test between
two precisions, and neither of those is a golden image.
