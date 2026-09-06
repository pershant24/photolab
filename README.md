# photolab

A browser-based colour grading and film emulation editor that simulates the
physical path light takes — through a lens, onto film, into a print — rather than
applying a lookup table and calling it a stock. It runs entirely on your machine
in raw WebGL2: no backend, no account, no upload.

![A 1:1 crop, ungraded on the left and through the punchy reversal stock on the right](docs/images/detail.jpg)

## What it looks like

One photograph through the three film stocks that ship. Each stock is three
independent characteristic curves — one per channel, with its own toe, shoulder
and gamma — and each look here sets the rest of the chain differently around it:
warm portrait is the stock with halation and grain and no grade at all, punchy
reversal adds contrast and a lift/gain split, muted documentary drops halation
entirely and works through split toning and desaturation.

| | |
|---|---|
| **Original** | **Warm portrait** |
| ![](docs/images/original.jpg) | ![](docs/images/warm-portrait.jpg) |
| **Punchy reversal** | **Muted documentary** |
| ![](docs/images/punchy-reversal.jpg) | ![](docs/images/muted-documentary.jpg) |

What separates them is **colour crossover** — shadows drifting one way and
highlights the other, with the drift changing across the exposure range.
Crossover *is* the difference between the channels, so a single shared RGB curve
cannot produce it at all; it can only adjust contrast. That is why so many film
emulations get the tonality and none of the character.

## Running it

Node 22 (`.nvmrc` pins it; `package.json` requires it).

```sh
npm install
npm run dev
```

Open a photograph, move the sliders, press **Export** for a full-resolution file.
Nothing leaves your machine — there is no server to send it to.

There is no hosted copy yet. The app wants `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers, which GitHub Pages cannot set;
`public/_headers` is written for Cloudflare Pages or Netlify, either of which
serves it as-is.

## What is interesting about it

**The renderer is a pure function.** `render(sourceImage, EditState) → pixels`,
with no hidden state and nothing read from anywhere but one flat serialisable
object. Undo is an array of snapshots, a preset is a partial one, and preview and
export are the same code — which is what makes it possible to *assert* that a
tiled export matches a whole-frame render, and that two tilings of a 48MP source
too large to hold as a texture agree with each other, rather than hoping.

**Passes run in the order the physics happens** — scene, lens, film, grade,
display. A vignette darkens the frame the lens formed, so its darkening passes
*through* the film's characteristic curves rather than being painted on
afterwards, and the same vignette therefore looks different under different
stocks. Measured, at a vignette of 0.7: a corner-to-centre ratio of 0.52 through
the contrastiest stock, 0.59 and 0.66 through the two flatter ones — a 15% spread
from a control that never touched them.

**Everything spatial is measured against the source, not the buffer.** A blur
radius in pixels is a different size on a 2048px preview than on a 6000px export,
so the preview would lie about the result. Getting this wrong is invisible at
full frame and appears only on export — a whole category of bug that only tiles
can see.

**The tests are the interesting part.** Almost every number here was measured
rather than chosen, and most design decisions came from a measurement
contradicting an assumption: a hue bound that held for the colours it was fitted
to and not for ones a later stage could reach; a tile overlap rule that took the
maximum across passes when spatial passes chain and it needed the sum, which
showed as a three-code-value seam; a grain metric measured in the wrong space,
which would have reported the modulation running the opposite way.
[`tests/README.md`](tests/README.md) is a log of what was watched to fail and
what each failure changed.

**No dependency does the hard part.** Raw WebGL2 — no three.js, regl or glfx.
Colour maths is written in TypeScript first, unit tested against known values,
then asserted to agree with the shader across a value ramp, because a test
comparing a shader only to itself measures nothing.

## Working on it

```sh
npm ci
git config core.hooksPath .githooks     # required, see below
npx playwright install chromium
```

**The `core.hooksPath` line is not optional.** It is local repository
configuration and is not carried in the repository itself, so a fresh clone has
no hooks active until you run it — every guard in `.githooks/` is silently
inactive and CI becomes the only thing between a bad commit message and `main`.
Check it took: `git config --get core.hooksPath` should print `.githooks`.

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test:unit` | Vitest — colour maths and pure logic |
| `npm run test:golden` | Playwright — rendered output against references |
| `npm run probe:webgl` | Report the test browser's WebGL2 capabilities |

Interactive editing renders a proxy at roughly 2048px on the long edge. Export
runs the identical pass chain over the full image in overlapping tiles, in a
worker. WebGL2 with a colour-renderable half-float framebuffer is required, and
the app says so clearly rather than degrading silently without it.

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Structure, invariants, build order, and how to add a pass |
| [`docs/COLOUR_PIPELINE.md`](docs/COLOUR_PIPELINE.md) | Working space and why each stage sits where it does |
| [`docs/SHADER_CONVENTIONS.md`](docs/SHADER_CONVENTIONS.md) | The uniform contract and how tolerances are derived |
| [`tests/README.md`](tests/README.md) | Testing strategy, and the measurements behind the decisions |
| [`CLAUDE.md`](CLAUDE.md) | Project rules, including the commit attribution constraint |

Stock and preset names are descriptive rather than borrowed. Real film stock
names are trademarks, and a look tuned by eye against a domain the datasheet was
never written for has no business wearing one.

## Licence

[MIT](LICENSE).
