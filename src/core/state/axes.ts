/**
 * The three preset axes, and bundles that compose them.
 *
 * A look is three independent decisions that happened to the same photograph:
 *
 *   camera   what the physical camera did to the light
 *   stock    how the emulsion responded to it
 *   grade    what a colourist, and a scanner, did afterwards
 *
 * Splitting them is what makes presets compose. Any camera with any stock with
 * any grade is a valid combination, and the number of looks available is the
 * product rather than the sum.
 *
 * # Disjointness is by parameter, and deliberately not by stage
 *
 * The property that makes composition work is that two presets on different axes
 * cannot touch the same parameter — otherwise applying one silently clobbers
 * part of another and the order starts to matter.
 *
 * It would be convenient if each axis were a pass stage, and it is not. The
 * camera axis already spans two stages: the lens parameters live in the lens
 * stage, `grainSize` is read by a film-stage pass. It will span more — a light
 * leak injects before the film stage, a border lands after display. So the table
 * below is written against **parameter keys** and nothing else. An assertion
 * written against stages would look correct and check something else.
 *
 * # Why `grainSize` is camera and `grainStrength` is stock
 *
 * The split is real rather than a tidy-up. Grain size on the print stands in for
 * **format**: a larger negative enlarged to the same size shows finer grain, so
 * it is a fact about the camera that exposed it. Grain strength is the
 * emulsion's own — how fast the film is, how coarse its crystals. A 35mm camera
 * loaded with two different stocks gives the same grain scale and different
 * grain amounts, which is exactly what this split reproduces.
 *
 * Halation is the film base reflecting light back into the emulsion, so it goes
 * with the stock for the same kind of reason.
 *
 * # The parameters no axis may touch
 *
 * `exposure`, `temperature` and `tint` are measurements of the scene — how much
 * light there was and what colour it was — rather than decisions about a look.
 * `presets.ts` already carries the argument for why a preset must not reset
 * them, and this is that argument enforced. A preset that sets exposure is not a
 * look, it is a claim about someone else's photograph.
 */

import { DEFAULT_EDIT_STATE, PARAMETERS, mergeEditState } from './editState'
import type { EditState } from './editState'
import type { Preset } from './presets'

export const PRESET_AXES = ['camera', 'stock', 'grade'] as const
export type PresetAxis = (typeof PRESET_AXES)[number]

/**
 * Which parameters each axis owns.
 *
 * Exhaustive and disjoint, both asserted rather than asserted-by-comment. Adding
 * a parameter to `EditState` without placing it here fails
 * `tests/unit/axes.test.ts`, which is deliberate: the alternative is a parameter
 * that quietly belongs to no axis and can never appear in a preset.
 */
export const AXIS_PARAMETERS: Record<PresetAxis, readonly string[]> = {
  camera: [
    'distortion',
    'aberration',
    'diffusionStrength',
    'diffusionRadius',
    'vignette',
    'grainSize',
  ],
  stock: [
    'filmCurveRed',
    'filmCurveGreen',
    'filmCurveBlue',
    'filmStrength',
    'grainStrength',
    'halationStrength',
    'halationThreshold',
    'halationRadius',
  ],
  grade: [
    'toneCurve',
    'contrast',
    'lift',
    'gamma',
    'gain',
    'hslHue',
    'hslSaturation',
    'hslLuminance',
    'splitShadowTint',
    'splitHighlightTint',
    'splitBalance',
    // A look decision about how highlights roll off, not a property of the
    // scene, so it sits with the colourist rather than outside the axes.
    'toneMapKnee',
  ],
}

/**
 * Parameters that belong to the photograph rather than to any look.
 *
 * No axis preset may set these. A bundle's override layer may, because that
 * layer is explicitly the exception, and a user saving their own tweak of their
 * own photograph is entitled to include the exposure they chose.
 */
export const PHOTOGRAPH_PARAMETERS: readonly string[] = ['exposure', 'temperature', 'tint']

/** The axis owning a parameter, or `null` for the photograph's own. */
export function axisOf(key: string): PresetAxis | null {
  for (const axis of PRESET_AXES) {
    if (AXIS_PARAMETERS[axis].includes(key)) return axis
  }
  return null
}

/** A preset that declares which axis it belongs to. */
export interface AxisPreset extends Preset {
  readonly axis: PresetAxis
}

export function isAxisPreset(preset: Preset): preset is AxisPreset {
  return 'axis' in preset && typeof (preset as AxisPreset).axis === 'string'
}

/**
 * Whether a patch stays inside its axis, and what it touched if not.
 *
 * Returned rather than thrown so a caller can report every offending key at
 * once. A preset failing this is a bug in the library, not user input.
 */
export function patchViolations(axis: PresetAxis, patch: Partial<EditState>): string[] {
  const allowed = AXIS_PARAMETERS[axis]
  return Object.keys(patch).filter((key) => !allowed.includes(key))
}

/**
 * A curated combination: an ordered list of axis preset **ids**, and an optional
 * sparse override applied last.
 *
 * # It references, it does not flatten
 *
 * Storing the resolved patch would be simpler and wrong. A flattened bundle is a
 * copy taken at one moment, so the first time anyone edits one of its components
 * the bundle silently stops matching the thing it is named after. Referencing
 * costs a lookup and means a fix to a stock propagates to every bundle built on
 * it, which is the reason to have components at all.
 *
 * # The order is stored and cannot matter
 *
 * `components` is a list rather than three named slots, because that is the
 * general shape and because it makes the disjointness property observable: since
 * no two axes share a parameter, permuting the list cannot change the result.
 * `tests/unit/axes.test.ts` asserts that rather than trusting it, which is the
 * only way to notice if disjointness is ever broken.
 *
 * The override is the exception and is applied last, deliberately: it exists for
 * the tweak the three axes cannot express, so it has to win.
 */
export interface Bundle {
  readonly id: string
  readonly name: string
  /** Axis preset ids, in application order. */
  readonly components: readonly string[]
  /** The fourth layer. The one place the disjointness rule does not apply. */
  readonly override?: Partial<EditState>
  readonly builtIn?: boolean
}

export interface ResolvedBundle {
  /** Everything the bundle sets, in one patch, ready for a single history entry. */
  readonly patch: Partial<EditState>
  /** Component ids the bundle names that no longer exist. */
  readonly missing: readonly string[]
  /** The components that did resolve, in application order. */
  readonly applied: readonly AxisPreset[]
}

/**
 * Resolve a bundle against the presets currently available.
 *
 * # A missing component is skipped, and reported
 *
 * A bundle can outlive one of its components: presets are user-editable and
 * deletable, and a bundle imported from elsewhere may name ids this build has
 * never seen. Three things were possible and the choice is not obvious, so the
 * reasoning is here rather than implied.
 *
 * **Refusing to apply the bundle** was rejected. Two thirds of a look is still a
 * useful starting point, and a user who has deleted a camera preset has not
 * asked for the stock and grade to become unreachable.
 *
 * **Silently repairing the bundle** — dropping the dead id — was rejected too,
 * and this is the one that would have been tempting. The preset may come back:
 * imported again, restored from another machine, or shipped by a later build. A
 * repair discards that possibility permanently in exchange for tidiness, and it
 * does it at read time, where the user cannot see it happen.
 *
 * So: apply what resolves, keep the reference, and hand the caller the list of
 * what was missing so the interface can say so. The bundle stays a truthful
 * record of what it was built from.
 */
export function resolveBundle(bundle: Bundle, available: readonly Preset[]): ResolvedBundle {
  const byId = new Map(available.map((preset) => [preset.id, preset]))
  const missing: string[] = []
  const applied: AxisPreset[] = []
  let patch: Partial<EditState> = {}

  for (const id of bundle.components) {
    const found = byId.get(id)
    if (!found || !isAxisPreset(found)) {
      missing.push(id)
      continue
    }
    applied.push(found)
    patch = { ...patch, ...found.patch }
  }
  // Last, and the only layer permitted to cross axes.
  if (bundle.override) patch = { ...patch, ...bundle.override }

  return { patch, missing, applied }
}

/** The state a bundle produces from a starting state. One merge, one entry. */
export function applyBundle(
  state: EditState,
  bundle: Bundle,
  available: readonly Preset[],
): { next: EditState; missing: readonly string[] } {
  const { patch, missing } = resolveBundle(bundle, available)
  return { next: mergeEditState(state, patch), missing }
}

/** Every parameter key the registry knows, for the exhaustiveness assertion. */
export function allParameterKeys(): string[] {
  return PARAMETERS.map((parameter) => parameter.key)
}

export { DEFAULT_EDIT_STATE }
