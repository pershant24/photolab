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
      distortion: -0.012,
      aberration: 0.0004,
      vignette: 0.16,
      grainSize: 0.0006,
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
      distortion: -0.22,
      aberration: 0.0062,
      vignette: 0.78,
      diffusionStrength: 0.22,
      diffusionRadius: 0.014,
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
      grainSize: 0.0009,
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
export const STOCK_PRESETS: readonly AxisPreset[] = [
  {
    id: 'stock-warm-portrait',
    name: 'Warm portrait negative',
    axis: 'stock',
    builtIn: true,
    patch: {
      ...stockPatch('warm-portrait'),
      filmStrength: 0.8,
      halationStrength: 0.32,
      halationThreshold: 2.05,
      halationRadius: 0.005,
      grainStrength: 0.3,
    },
  },
  {
    id: 'stock-punchy-reversal',
    name: 'Punchy reversal',
    axis: 'stock',
    builtIn: true,
    patch: {
      ...stockPatch('punchy-reversal'),
      filmStrength: 0.85,
      halationStrength: 0.5,
      halationThreshold: 1.95,
      halationRadius: 0.007,
      grainStrength: 0.26,
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
      filmStrength: 0.9,
      grainStrength: 0.52,
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
      lift: [-0.012, 0.002, 0.016],
      gain: [0.018, 0.004, -0.014],
      hslSaturation: [0.08, 0.12, 0, 0, -0.12, 0],
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
      contrast: 1.5,
      lift: [-0.022, 0.004, 0.03],
      gain: [0.026, 0.02, -0.03],
      hslSaturation: [0.2, 0.25, 0.3, 0.15, 0.1, 0.15],
      splitShadowTint: [-0.012, 0.004, 0.018],
      splitHighlightTint: [0.016, 0.012, -0.02],
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
      contrast: 1.12,
      lift: [0.004, 0, -0.004],
      gain: [0.012, 0.004, -0.01],
      splitHighlightTint: [0.01, 0.004, -0.008],
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
    override: { grainStrength: 0.62 },
  },
]
