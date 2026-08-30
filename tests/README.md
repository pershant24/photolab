# Tests

| Directory | Runner | Purpose |
|---|---|---|
| `tests/unit/` | Vitest | Pure TypeScript. Colour maths, curve evaluation, state reducers. |
| `tests/probe/` | Playwright | Capability probes. Assert the browser can do what the renderer assumes. |
| `tests/golden/` | Playwright | Rendered output against committed reference images. |

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
