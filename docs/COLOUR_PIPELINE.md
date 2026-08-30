# Colour pipeline

## Working space

**ACEScg** — AP1 primaries, linear, scene-referred. Chosen because the film
emulation is a simulation of a physical process, and physical processes are
linear in radiometric quantities. Halation is light scattering back through a
substrate; grain is silver density; exposure is a change in the amount of light
reaching the film. All of these are multiplications and convolutions in linear
light, and all of them are wrong when applied to gamma-encoded values.

AP1 rather than sRGB primaries because the gamut is wide enough to hold
saturated results produced mid-chain without clipping them into a smaller
container before the display transform gets a chance to compress them
deliberately.

Intermediate render targets are **RGBA16F**, not RGBA32F. Half float has 10 bits
of mantissa and an exponent, which is more than sufficient for scene-referred
values that never exceed a few hundred, and it halves both bandwidth and memory
against 32F. A 60MP image at RGBA16F is already 480MB per buffer; at 32F a
ping-pong pair would be two gigabytes.

The context requests `EXT_color_buffer_float` **or**
`EXT_color_buffer_half_float` and accepts either — both make RGBA16F colour
renderable in WebGL2, and Chrome has historically exposed only the former. If
neither is present the application fails loudly with a user-facing message
rather than silently falling back to 8-bit, which would destroy the pipeline's
premise without visibly breaking anything.

## Pass order

Passes run in the order the phenomena occur physically:

```
0. Ingest    decode -> EXIF orientation -> linearise -> matrix to ACEScg
1. Scene     white balance (CAT02) -> exposure (linear multiply)
2. Lens      distortion -> chromatic aberration -> diffusion/bloom -> vignette (cos^4)
3. Film      halation -> per-channel characteristic curves -> density-dependent grain
4. Grade     creative curves -> HSL -> colour wheels (lift/gamma/gain) -> split tone
5. Display   ACEScg -> display primaries -> tone map + gamut compression -> encode
```

### Why this order

Light leaves the scene, passes through a lens, lands on film, and the developed
result is then interpreted by a colourist and shown on a display. Each stage can
only act on what the previous stage produced.

**0 → 1.** Nothing can be computed until values are linear and in a known space.
Linearisation before the primaries matrix, not after: the transfer function is
defined on encoded values.

**1 before 2.** White balance and exposure describe the light arriving at the
lens. A vignette darkens the corners of an already-exposed frame, so applying
exposure after vignetting would mean the vignette scaled with exposure, which is
not how an aperture works.

**2 before 3.** The lens forms the image that the film records. Halation is
light passing *through* the emulsion, reflecting off the backing, and re-exposing
it from behind — it acts on the image the lens delivered. Bloom, by contrast, is
scattering in the glass, so it belongs to the lens. They look similar and are
physically distinct; keeping them in separate stages keeps that distinction
honest.

**Inside 3.** Halation is an exposure effect: it adds light to the emulsion, so
it happens *before* the characteristic curves convert exposure to density. Grain
comes last inside the film stage because grain magnitude depends on the
developed density, which does not exist until the curves have been applied.

**3 before 4.** The grade is a human interpreting a developed negative. It has
nothing to act on until the film stage has produced one.

**5 last.** The display transform is the only stage that knows what the output
device is. Everything before it is device-independent scene-referred data.

## White balance

White balance is a **chromatic adaptation in a cone response space**, using
CAT02: transform ACEScg into LMS cone responses, scale each cone response by the
ratio between the source and destination white points, transform back.

It is not a per-channel scale in RGB. Scaling R, G, B independently to shift
temperature also changes saturation and hue as a side effect, because RGB
primaries are not the axes the human visual system adapts along. CAT02 models
adaptation in the space where it actually happens, so a temperature change
reads as a temperature change and nothing else.

Note that CAT02 here is a *creative* white balance control. The fixed D65→D60
adaptation baked into the sRGB↔ACEScg primaries matrices uses Bradford, which
is what the ACES specification prescribes. These are two different adaptations
serving two different purposes and they are intentionally not the same
transform.

## Film stage

### Characteristic curves

Three **independent** curves, one per channel, each with its own toe, shoulder,
and gamma. A single shared RGB curve is not acceptable.

The reason is that per-channel difference *is* the effect. A film stock's
identity comes largely from its channels having different contrast and different
toe and shoulder placement, which produces colour crossover: shadows drift one
way, highlights drift another, and the drift changes with exposure. A shared
curve produces a contrast adjustment, not a film stock.

### Grain

Grain is **density-dependent and per-channel**. Magnitude peaks in the midtones
and falls off in both the toe and the shoulder.

Physically, grain is the statistical variation in how many silver halide
crystals were developed. Where almost none developed (deep shadow) or almost all
did (blown highlight), there is little room for variation and the image is
smooth. Maximum variance sits in the middle. Per-channel because the three
emulsion layers have different crystal sizes and develop independently.

A uniform noise overlay has none of these properties and reads as digital noise.

## Display transform

ACEScg → display primaries → tone map and gamut compression → encode with the
display transfer function.

Tone mapping is a deliberate, named stage rather than an implicit clip. Values
above display white exist throughout the pipeline and must be brought down by a
curve that preserves their ordering. Gamut compression handles the colours that
AP1 can represent and the display cannot: without it, out-of-gamut values clip
per-channel, which shifts hue.

A `none` mode is available and used by the round-trip test, where sRGB in must
equal sRGB out through an otherwise identity pipeline. That test would be
impossible to write against a tone-mapped output, and it is the check that
catches sign and transpose errors in the primaries matrices.
