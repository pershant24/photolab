# photolab

A browser-based photo editor for colour grading and physically motivated film
stock emulation. Everything runs locally in WebGL2 — there is no backend, no
account, and no upload. Images never leave your machine.

## Fresh clone setup

```bash
fnm use            # or nvm use — reads .nvmrc (Node 22)
npm ci
git config core.hooksPath .githooks
npx playwright install chromium
```

**The `core.hooksPath` line is required.** `core.hooksPath` is local repository
configuration and is not carried in the repository itself, so a fresh clone has
no hooks active until you run it. Without it every guard in `.githooks/` is
silently inactive — `commit-msg`, `prepare-commit-msg`, and the `pre-push`
branch name check — and CI becomes the only thing standing between a bad commit
message and `main`.

Verify it took effect:

```bash
git config --get core.hooksPath   # -> .githooks
```

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test:unit` | Vitest — colour maths and pure logic |
| `npm run test:golden` | Playwright — rendered output against reference images |
| `npm run probe:webgl` | Report the WebGL2 capabilities of the test browser |

## How it works

The renderer is a pure function of `(sourceImage, EditState)`. Passes run in the
order the phenomena physically occur — scene, then lens, then film, then grade,
then display — in an ACEScg working space at RGBA16F precision.

- `docs/COLOUR_PIPELINE.md` — the pass order and why it is that order
- `docs/ARCHITECTURE.md` — module layout and the recipe for adding a pass *(lands with the render graph)*
- `docs/SHADER_CONVENTIONS.md` — uniform conventions and the resolution-independence rule *(lands with the first shader passes)*
- `CLAUDE.md` — project rules, including the commit attribution constraint

## Rendering notes

Interactive editing renders a proxy at roughly 2048px on the long edge, dropping
to a smaller proxy during an active slider drag. Export runs the identical pass
chain across the full-resolution image in overlapping tiles.

Requires WebGL2 with a colour-renderable half-float framebuffer
(`EXT_color_buffer_float` or `EXT_color_buffer_half_float`). The app reports a
clear message rather than degrading silently if that is unavailable.

## Deployment

Static hosting. `npm run build` emits `dist/` with relative asset paths, ready
for GitHub Pages.
