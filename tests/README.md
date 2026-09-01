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

**Revisit at Milestone 3**, once the film and lens stages are real and the
numbers describe the pipeline that will ship. If a full-resolution drag is still
comfortably inside budget on the slowest device worth supporting, delete the
proxy: it is about thirty lines in `renderer.ts` and its tests, and it degrades
the image on every drag for hardware that does not need it.

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
