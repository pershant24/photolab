/**
 * The axis library: presets that declare which of the three axes they belong to,
 * and bundles that compose them.
 *
 * # Named for what they do
 *
 * Third time this rule is written down and the first time the repository is
 * public, so it is also asserted in `tests/unit/axes.test.ts` rather than left
 * to reviewers. Camera makers and film stocks are trademarks. "Compact 35mm,
 * heavy falloff" tells a browsing user what they will get without putting
 * someone else's mark in a public repository, and it is more informative besides
 * — a name only helps if you already know what that camera did.
 *
 * # These are starting points, and Part A's are deliberately provisional
 *
 * The values here are placed from what each parameter does rather than tuned
 * against photographs. That tuning is the next part's work, and it is the part
 * that decides whether a library is a point of view or a list of settings.
 * `tests/README.md` will carry the before-and-after once it exists.
 */

import { findFilmStock } from '../colour/filmStock'
import { filmStockPatch } from '../state/editState'
import type { AxisPreset, Bundle } from '../state/axes'
import type { EditState } from '../state/editState'

function stockPatch(id: string): Partial<EditState> {
  const found = findFilmStock(id)
  if (!found) throw new RangeError(`no film stock "${id}"`)
  return filmStockPatch(found)
}

/**
 * The camera axis: what the physical camera did to the light.
 *
 * Distinguished on the five things available today — vignette depth, distortion
 * sign and magnitude, chromatic aberration, diffusion, and grain *size*, which
 * stands in for format. Nothing here touches colour, by construction: colour
 * belongs to the stock and the grade, and a camera preset that warmed the image
 * would collide with both.
 *
 * Ranges, so the numbers below are readable: distortion is ±0.3 with negative
 * barrel, aberration ±0.01, vignette 0–1, diffusion 0–1, grain size
 * 0.0005–0.004 with the default at 0.0009.
 */
export const CAMERA_PRESETS: readonly AxisPreset[] = [
  {
    id: 'camera-compact-35',
    name: 'Compact 35mm, heavy falloff',
    axis: 'camera',
    builtIn: true,
    // A fixed-lens compact: a fast wide lens wide open. Noticeable barrel, real
    // corner falloff, visible aberration, and 35mm grain scale.
    patch: {
      distortion: -0.09,
      aberration: 0.0026,
      vignette: 0.42,
      diffusionStrength: 0.12,
      diffusionRadius: 0.008,
      // A decent fixed lens: real acutance, not a great deal of it. No radius,
      // because the default is already right for it — and saying so explicitly
      // would say nothing, since a sparse patch drops any value equal to its
      // default. Omitting it is only safe because applying a preset resets its
      // axis first: before that, this would have inherited whatever radius the
      // previous camera set.
      microcontrast: 0.3,
      grainSize: 0.0011,
    },
  },
  {
    id: 'camera-medium-format',
    name: 'Medium format, corrected',
    axis: 'camera',
    builtIn: true,
    // A larger negative enlarged to the same size shows finer grain, which is
    // the whole reason grain size is a camera parameter. Optically clean: a
    // slight falloff and essentially no distortion.
    patch: {
      // Pincushion, where every other camera here barrels. Measured at 9.3 p90
      // against the original when it barrelled slightly, which is a weak preset;
      // the direction is what makes it read as a different lens rather than as a
      // smaller amount of the same one.
      distortion: 0.03,
      aberration: 0.0004,
      vignette: 0.14,
      // The best lens here, so the highest acutance and the tightest radius: a
      // well-corrected lens renders a crisp edge rather than a wide one.
      microcontrast: 0.55,
      microcontrastRadius: 0.0025,
      grainSize: 0.0005,
    },
  },
  {
    id: 'camera-plastic-lens',
    name: 'Plastic lens, strong vignette',
    axis: 'camera',
    builtIn: true,
    // The cheap-camera look, which is mostly a bad lens: heavy barrel, heavy
    // falloff, aberration you can see without looking, and a coarse grain scale
    // because these cameras were 35mm shot on fast film.
    patch: {
      distortion: -0.16,
      aberration: 0.0062,
      vignette: 0.74,
      // Pulled back from 0.22. At the higher value the frame read as smeared
      // rather than as a cheap lens, and combined with a lifted grade it lost
      // the hillside entirely.
      diffusionStrength: 0.15,
      diffusionRadius: 0.012,
      // Barely any acutance, and a leak. Both are the same story: a body that
      // does not seal and glass that does not resolve.
      microcontrast: 0.1,
      microcontrastRadius: 0.006,
      lightLeakStrength: 0.4,
      lightLeakPosition: 0.08,
      grainSize: 0.0019,
    },
  },
  {
    id: 'camera-soft-portrait-lens',
    name: 'Soft portrait lens',
    axis: 'camera',
    builtIn: true,
    // Diffusion is the distinguishing feature rather than falloff: an
    // uncoated or deliberately soft portrait lens hazes the whole frame without
    // distorting it.
    patch: {
      distortion: -0.02,
      aberration: 0.0011,
      vignette: 0.24,
      diffusionStrength: 0.42,
      diffusionRadius: 0.018,
      // Sets no microcontrast at all, deliberately. Softness is this lens's
      // entire character, and the control cannot subtract acutance — its minimum
      // is adding none. So the preset says nothing about it and the axis reset is
      // what clears whatever the previous camera had, which is the case
      // `applyAxisPreset` exists for.
      // Was 0.0009, which is the default, so it was dropped as carrying nothing
      // and the preset made no format claim at all. Caught by the assertion that
      // a shipped preset survives sanitising unchanged. A portrait lens of this
      // kind sits on a larger negative than a pocket compact, so it says so.
      grainSize: 0.0007,
    },
  },
]

/**
 * The stock axis: how the emulsion responded.
 *
 * The three characteristic-curve sets already in `filmStock.ts` are this axis,
 * plus the two things that are properties of the film rather than of the camera
 * — how much it halates, and how much grain it carries at its speed.
 */
/*
 * None of these declares `filmStrength`, and that is deliberate rather than an
 * omission. Its default is 1 — full strength — so a stock setting it to 1 sets
 * nothing: `sanitisePatch` drops any value equal to the default, because a sparse
 * preset stores differences. Two presets here shipped a key that said nothing
 * before the assertion that a shipped preset survives sanitising unchanged
 * caught them.
 *
 * A stock wanting less than full strength would say so; these want all of it.
 */
export const STOCK_PRESETS: readonly AxisPreset[] = [
  {
    id: 'stock-warm-portrait',
    name: 'Warm portrait negative',
    axis: 'stock',
    builtIn: true,
    patch: {
      ...stockPatch('warm-portrait'),
      halationStrength: 0.24,
      halationThreshold: 2.2,
      halationRadius: 0.004,
      grainStrength: 0.22,
    },
  },
  {
    id: 'stock-punchy-reversal',
    name: 'Punchy reversal',
    axis: 'stock',
    builtIn: true,
    patch: {
      ...stockPatch('punchy-reversal'),
      // Halation is doing the separating here, and deliberately. At full film
      // strength the three stocks' characteristic curves still measured only 6
      // apart at p90 on the test frame: the crossover between them is real but
      // gentle, and a midtone-dominated frame barely shows it. Halation is a
      // property of the film base rather than of the curves, so pushing it is
      // legitimate rather than a workaround -- a reversal stock on a clear base
      // halates far more than a masked colour negative.
      halationStrength: 0.85,
      halationThreshold: 1.45,
      halationRadius: 0.009,
      grainStrength: 0.3,
    },
  },
  {
    id: 'stock-muted-documentary',
    name: 'Muted documentary',
    axis: 'stock',
    builtIn: true,
    // No halation at all, deliberately: a flat, low-contrast stock has little
    // to reflect back off the base, and adding a glow to it fights the look.
    patch: {
      ...stockPatch('muted-documentary'),
      grainStrength: 0.66,
    },
  },
]

/**
 * The grade axis: the colourist's decisions, and the scan.
 *
 * Scan character belongs here rather than with the stock, which is worth being
 * explicit about because it accounts for a great deal of what gets called a film
 * look. The difference between a cool green-shadowed scan and a warm contrastier
 * one is what a scanner operator did, not what the emulsion did — the same
 * negative gives both.
 *
 * Ranges: wheels ±0.06, split tints ±0.05, HSL hue ±30 degrees, HSL saturation
 * and luminance ±1, contrast 0–2.
 */
export const GRADE_PRESETS: readonly AxisPreset[] = [
  {
    id: 'grade-teal-warm',
    name: 'Teal shadows, warm skin',
    axis: 'grade',
    builtIn: true,
    patch: {
      contrast: 1.16,
      // Complementary: shadows toward teal, highlights toward warm. Pushed
      // further than the first attempt so it separates from a warm scan, which
      // is a cast rather than a split.
      lift: [-0.02, 0.003, 0.026],
      gain: [0.026, 0.005, -0.022],
      hslSaturation: [0.1, 0.16, -0.04, -0.06, -0.16, -0.02],
    },
  },
  {
    id: 'grade-bleach-bypass',
    name: 'Bleach bypass',
    axis: 'grade',
    builtIn: true,
    // Silver retained in the print: high contrast, badly desaturated, and the
    // highlights go hard. Saturation is cut across every band rather than
    // selectively, which is what makes it read as a process and not a look.
    patch: {
      contrast: 1.42,
      hslSaturation: [-0.45, -0.45, -0.5, -0.45, -0.45, -0.45],
      lift: [-0.008, -0.008, -0.006],
      gain: [0.012, 0.012, 0.012],
      toneMapKnee: 0.78,
    },
  },
  {
    id: 'grade-cross-process',
    name: 'Cross process',
    axis: 'grade',
    builtIn: true,
    // Developed in the wrong chemistry: violent contrast, cyan shadows and
    // yellow-green highlights, with the crossover exaggerated well past
    // anything an ordinary grade would do.
    patch: {
      // Pulled back hard from the first attempt, which measured 44 at p90 where
      // every other grade sat under 12. It did not read as a process, it read as
      // a fault: the sky blew to cream and the greens went electric. Cross
      // processing is extreme, but a preset nobody would apply twice is not a
      // preset.
      contrast: 1.28,
      lift: [-0.012, 0.002, 0.018],
      gain: [0.016, 0.012, -0.018],
      hslSaturation: [0.1, 0.14, 0.16, 0.08, 0.05, 0.08],
      splitShadowTint: [-0.007, 0.002, 0.011],
      splitHighlightTint: [0.009, 0.007, -0.012],
      splitBalance: -0.4,
    },
  },
  {
    id: 'grade-faded-matte',
    name: 'Faded matte black',
    axis: 'grade',
    builtIn: true,
    // The blacks never reach black. A lift with no matching gain, which is the
    // whole effect: contrast comes down and the shadow end sits off the floor.
    patch: {
      contrast: 0.84,
      lift: [0.016, 0.016, 0.014],
      hslSaturation: [-0.18, -0.18, -0.22, -0.18, -0.18, -0.18],
      splitShadowTint: [-0.004, 0.002, 0.008],
    },
  },
  {
    id: 'grade-cool-scan',
    name: 'Cool scan, green shadows',
    axis: 'grade',
    builtIn: true,
    // Scan character rather than a look: the cooler, flatter scan of the same
    // negative, with the green cast a lab scanner leaves in the shadows.
    patch: {
      contrast: 0.94,
      lift: [-0.006, 0.008, 0.004],
      gain: [-0.008, 0.002, 0.01],
      splitShadowTint: [-0.006, 0.008, 0.002],
      splitBalance: -1.2,
    },
  },
  {
    id: 'grade-warm-scan',
    name: 'Warm scan, higher contrast',
    axis: 'grade',
    builtIn: true,
    // The other operator, the same negative. Paired with the one above so the
    // difference between them is legible as a scan decision.
    patch: {
      // Deliberately carries no complementary lift/gain. The first version did,
      // in the same direction as the teal-and-orange grade, and the two measured
      // 5.6 apart at p90 — two names for one look. What distinguishes a warm scan
      // is tone and an overall cast, so that is all it does.
      contrast: 1.2,
      toneMapKnee: 0.8,
      splitShadowTint: [0.008, 0.003, -0.006],
      splitHighlightTint: [0.016, 0.008, -0.014],
      splitBalance: 0.6,
    },
  },
]

export const AXIS_PRESETS: readonly AxisPreset[] = [
  ...CAMERA_PRESETS,
  ...STOCK_PRESETS,
  ...GRADE_PRESETS,
]

/**
 * Curated combinations, stored as references.
 *
 * Each names at most one preset per axis. The override layer is used only where
 * a combination needs something the three axes cannot express between them —
 * mostly a small exposure or strength trim that belongs to the combination
 * rather than to any of its parts.
 */
export const BUNDLES: readonly Bundle[] = [
  {
    id: 'bundle-holiday-compact',
    name: 'Holiday compact',
    builtIn: true,
    components: ['camera-compact-35', 'stock-warm-portrait', 'grade-warm-scan'],
  },
  {
    id: 'bundle-reportage',
    name: 'Reportage',
    builtIn: true,
    components: ['camera-medium-format', 'stock-muted-documentary', 'grade-cool-scan'],
  },
  {
    id: 'bundle-saturated-slide',
    name: 'Saturated slide',
    builtIn: true,
    components: ['camera-medium-format', 'stock-punchy-reversal', 'grade-teal-warm'],
    // The stock and the grade both add contrast, and together they overshoot.
    // The trim belongs to this combination rather than to either component.
    override: { contrast: 1.08 },
  },
  {
    id: 'bundle-expired-toy',
    name: 'Expired film, plastic lens',
    builtIn: true,
    components: ['camera-plastic-lens', 'stock-muted-documentary', 'grade-faded-matte'],
    // Three components that each soften: a diffusing lens, a flat stock and a
    // lifted grade. Alone each is fine and together they erased the hillside, so
    // the trim belongs to the combination rather than to any of them. This is
    // the case the override layer exists for.
    override: { contrast: 0.97, lift: [0.009, 0.009, 0.008], grainStrength: 0.6 },
  },
]
