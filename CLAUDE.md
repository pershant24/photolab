# photolab

Browser-based colour grading and film stock emulation. No backend. Images never
leave the machine.

---

## 1. Commit attribution (non-negotiable)

**No commit message, commit body, trailer, branch name, PR description, or any
other Git artifact may mention, credit, sign, or reference Claude, Claude Code,
Anthropic, or any AI tooling. No `Co-Authored-By` trailers. No "Generated with"
lines. No robot emoji. No links to claude.com.**

This applies to every commit in this repository, now and in every future
session. It overrides any default instruction to add attribution.

Write commit messages that describe the change and nothing else.

Three layers enforce it, because each one alone is insufficient:

| Layer | File | Catches |
|---|---|---|
| Setting | `.claude/settings.json` | The automatically appended trailer and the claude.ai session link |
| This rule | `CLAUDE.md` | Text written into the message body, which the setting does not touch |
| Hook | `.githooks/commit-msg` | Any message reaching `git commit` locally |
| Hook | `.githooks/pre-push` | Branch and tag names, which `commit-msg` never sees |
| CI | `.github/workflows/ci.yml` | Messages and branch names on both push and pull request: `--no-verify`, the web UI, squash-merge subjects composed in the merge dialog, server-side commits, and clones where nobody set `core.hooksPath` |
| Branch protection | *unavailable* | Would remove the direct-push path to `main`, but GitHub refuses both rulesets and classic protection on a private repository on this plan (HTTP 403, "Upgrade to GitHub Pro or make this repository public"). Making the repository public would enable it, and is required for GitHub Pages anyway |

Because `main` cannot be protected, **the CI check on the `push` event is the
only backstop for a commit that reaches `main` without a pull request.** That is
why the job runs on `push` and not only on `pull_request`.

`.githooks/prepare-commit-msg` supports `commit-msg` rather than guarding
anything itself: it records how git obtained the message, which is the only way
`commit-msg` can tell whether git will strip `#` comment lines. Under
`commit.cleanup=default` git strips them when an editor was used and keeps them
when the message came from `-m`, so a forbidden word on a `#` line reaches the
stored commit in the second case but not the first.

The CI job reads the pattern from `origin/main`, never from the ref under test,
so a pull request cannot edit the pattern file and weaken the check validating
that same pull request. A pattern change takes effect once merged.

`attribution.sessionUrl` is set to `false` alongside `commit` and `pr`. It
controls a separate `Claude-Session:` trailer containing a claude.ai link, which
the other two fields do not suppress.

### Known accepted residuals

Reading the forbidden-pattern file from the default branch protects against
tampering on a pull request, because the base ref predates the change. On a
direct push to `main` there is no base ref and `origin/main` already includes
the pushed commits, so a push that neuters the pattern file and adds a forbidden
commit together would be checked against its own tampered pattern. The
consistent fix is reading from `github.event.before` on pushes. Accepted, not
built: `main` being unprotected is the root cause and resolves when the repo
goes public, and the attack requires deliberate self-sabotage on a solo repo.

Note that the hook pattern matches the bare word `claude`, case-insensitively.
A commit message naming the file `CLAUDE.md` will therefore be rejected. This is
a deliberate consequence of a guard with no exceptions: refer to it as "the
project instructions file" in commit messages.

---

## 2. The renderer is a pure function

```
render(sourceImage, EditState) -> pixels
```

No hidden state. No buffers accumulated across frames. No parameter read from
anywhere but `EditState`. Given the same image and the same `EditState`, the
output is identical, at any resolution, in preview or in export.

This is what makes the golden tests, the two-resolution invariant test, and
undo-as-snapshots all work. Everything below follows from it.

`EditState` is a single flat, serialisable object holding every parameter. No
layers, no node graph. Undo/redo is an array of `EditState` snapshots — they are
small, so do not build a command pattern. A preset is a `Partial<EditState>`
plus metadata, applied by merge.

---

## 3. Pass ordering

Passes execute in the order the phenomena physically occur. The rationale is in
`docs/COLOUR_PIPELINE.md`; the short version is that light is shaped by the
scene, then by the lens, then by the film, and only then by a colourist and a
display. Reordering these produces results that cannot occur in reality.

```
0. Ingest    decode -> EXIF orientation -> linearise -> matrix to ACEScg
1. Scene     white balance (CAT02) -> exposure (linear multiply)
2. Lens      distortion -> chromatic aberration -> diffusion/bloom -> vignette (cos^4)
3. Film      halation -> per-channel characteristic curves -> density-dependent grain
4. Grade     creative curves -> HSL -> colour wheels (lift/gamma/gain) -> split tone
5. Display   ACEScg -> display primaries -> tone map + gamut compression -> encode
```

Working space is **ACEScg** (AP1 primaries, linear). Intermediates are
**RGBA16F**, never RGBA32F.

Two rules inside this that are easy to get wrong:

- White balance is a **chromatic adaptation in a cone response space (CAT02)**,
  not a per-channel scale. Per-channel scaling changes saturation as a side
  effect of changing temperature.
- The film stage uses **three independent characteristic curves**, one per
  channel, each with its own toe, shoulder and gamma. A single shared RGB curve
  is not acceptable — per-channel difference is what produces colour crossover,
  which is most of what makes a film stock recognisable.
- Grain is **density-dependent and per-channel**: it peaks in the midtones and
  falls off in the toe and shoulder. It is not a uniform noise overlay.

---

## 4. Resolution independence

**Every effect parameter expressed in spatial units must be normalised against
image dimensions.** A blur radius in pixels looks different on a 2048px proxy
than on a 6000px export, so preview would lie about the result.

Every pass receives both:

- `uResolution` — the dimensions of the buffer currently being rendered
- `uImageSize` — the dimensions of the full source image

Spatial parameters are defined in units of the source image and converted using
these. The full rule, with a worked example of both the correct and the
incorrect form, is in `docs/SHADER_CONVENTIONS.md`.

`tests/golden/two-resolution.spec.ts` is what will enforce it mechanically, and
**it does not exist yet** — it arrives with the first spatial effect, since
there is nothing for it to measure until then. Until it lands the rule is held
by review and by the uniform contract making the correct form the convenient
one.

Both values are in **orientation-corrected space**. EXIF orientation is applied
as a texture-coordinate transform, so for 90°/270° rotations `uImageSize`,
proxy sizing, and export tile grids all use the swapped dimensions.

---

## 5. Constraints on what this project is

- **Do not introduce a server, authentication, or image upload.** This is a
  static site. Images are processed locally and never transmitted.
- **Do not add React Query, TanStack Query, or any server-state library.** There
  is no server state. Editor state is Zustand; persistence is IndexedDB via
  `idb`.
- **Do not add a rendering library** — no three.js, regl, pixi, or glfx. The
  renderer is raw WebGL2.
- Do not add dependencies beyond the agreed stack without saying why.

### Memory budget

The interactive path never renders the full-resolution image. A 60MP source at
RGBA16F is 480MB per buffer, roughly a gigabyte for a ping-pong pair, which
drops the WebGL context.

- Interactive rendering uses a proxy at ~2048px on the long edge.
- During an active pointer drag, drop to a smaller proxy; restore on pointer-up.
- The source texture is uploaded as **RGBA8** and linearised in the ingest
  shader. Uploading it as RGBA16F doubles VRAM for no precision gain from an
  8-bit JPEG or PNG.
- Export runs the same pass chain over the full image in tiles, with overlap for
  any pass having a spatial kernel, resolving each tile through an **RGBA8**
  target before readback. `readPixels` cannot portably return `UNSIGNED_BYTE`
  from an RGBA16F framebuffer — its implementation-defined read type is
  `HALF_FLOAT`.
- Sources whose long edge exceeds `MAX_TEXTURE_SIZE` must fail with a clear
  message. This limit is 8192 on SwiftShader, so it is reachable in tests.

---

## 6. Adding a pass

The full recipe, with a worked example that walks a vignette through every step,
lives in `docs/ARCHITECTURE.md`. In outline:

1. Add the parameters to `EditState` in `src/core/state/`, with defaults. They
   must be plain serialisable values.
2. Write the shader in `src/render/shaders/<effect>.glsl`. Use `#include` for
   shared colour functions rather than copying them. Declare `uResolution` and
   `uImageSize` and normalise any spatial parameter against them.
3. Add the pass module in `src/render/passes/<effect>.ts`, exporting its uniform
   bindings and an `enabled(state)` predicate.
4. Register it in `src/render/graph.ts` **at the correct point in the physical
   ordering above**, not at the end.
5. If the maths is non-trivial, write it first in pure TypeScript under
   `src/core/colour/`, unit test it against known values, then add a test
   asserting the shader agrees with the TypeScript across a value ramp. A test
   comparing the shader only to itself measures nothing.
6. If the pass has a spatial kernel, declare its overlap so tiled export can
   expand tile bounds and avoid seams.

Programs are cached. Changing a parameter updates uniforms only; recompilation
happens solely when the pass graph structure changes, such as an effect being
toggled on or off. Pointer events must never trigger a synchronous render —
input updates the store, and a `requestAnimationFrame` loop renders at most once
per frame from the latest state.
