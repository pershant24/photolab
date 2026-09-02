import { encodeACEScct } from '../colour/transfer'
import { WHEEL_RANGE } from '../colour/wheels'
import {
  HSL_BANDS,
  HSL_BAND_COUNT,
  HSL_HUE_RANGE,
  HSL_LUMINANCE_RANGE,
  HSL_SATURATION_RANGE,
} from '../colour/hsl'
import { SPLIT_BALANCE_MAX, SPLIT_BALANCE_MIN, SPLIT_TINT_RANGE } from '../colour/splitTone'
import {
  defaultParameter,
  parameterIsIdentity,
  parametersEqual,
  sanitiseParameter,
  snapshotParameter,
} from './parameterKinds'
import type {
  CurveDescriptor,
  ParameterDescriptor,
  ParameterValue,
  ScalarDescriptor,
  VectorDescriptor,
} from './parameterKinds'
import { NEUTRAL_TEMPERATURE, NEUTRAL_TINT } from '../colour/whiteBalance'
import { FILM_DOMAIN, IDENTITY_CHANNEL, isIdentityChannel } from '../colour/filmStock'
import type { FilmStock } from '../colour/filmStock'
import { TONE_MAP_KNEE } from '../colour/display'

/**
 * `EditState`: every parameter the renderer reads, in one flat object.
 *
 * ## Flat, and plain values only
 *
 * Numbers, strings, booleans, and arrays of those. Nothing else — no `Map`, no
 * `Date`, no class instance, no `undefined`, no function, no texture handle.
 *
 * The constraint is not stylistic. Undo is an array of snapshots of this object
 * and persistence is `structuredClone` into IndexedDB, so anything that does not
 * survive a JSON round trip breaks both, and it breaks them *quietly*: the value
 * comes back as `null` or vanishes, and the image is subtly wrong rather than
 * obviously broken. `tests/unit/edit-state.test.ts` asserts the round trip.
 *
 * Flatness is what makes the shape stable as parameters are added. A tone curve
 * arrives as `toneCurveX: number[]` and `toneCurveY: number[]`, not as a nested
 * `curve: { x, y }`; a film stock arrives as its own scalar fields. Adding a key
 * to a flat object changes nothing about how snapshots, merges or presets work,
 * which is the property that has to hold thirty parameters from now.
 *
 * ## What is deliberately *not* here
 *
 * The **source image** is the other argument to `render(sourceImage, EditState)`.
 * A GPU texture is not serialisable and does not belong in undo history.
 *
 * **View and debug settings** — the identity display mode, which proxy is in use
 * — are not edit parameters. They do not describe the photograph, and putting
 * them in undo history would make "undo" step through view changes. They live in
 * `ViewState`, in `src/render/passes/types.ts`.
 */

/** Every parameter of the edit. Flat, serialisable, and merged by spread. */
export interface EditState {
  /** Exposure in **stops**. `0` is unchanged; each `+1` doubles the light. */
  readonly exposure: number

  /**
   * Contrast as a **slope about middle grey** in ACEScct. `1` is unchanged,
   * above 1 steepens, `0` flattens the image to middle grey.
   */
  readonly contrast: number

  /**
   * Where the display transform's highlight roll-off begins, in display-linear.
   *
   * A creative parameter rather than a technical one, which is why it lives here
   * and is carried by undo and by presets. It is the white point seen from the
   * other end: `f(1.0) = (1 + knee) / 2`, so the code values it gives up below
   * white are exactly the ones it gains above. See `src/core/colour/display.ts`.
   */
  readonly toneMapKnee: number

  /**
   * Tone curve control points, interleaved as `[x0, y0, x1, y1, ...]`.
   *
   * One flat array rather than two, or an array of pairs, because the flatness
   * rule at the top of this file is what keeps snapshots, merges and persistence
   * working without special cases. An array of `{x, y}` objects would survive a
   * JSON round trip too, but it is the first step toward a shape where some
   * parameters are objects and the machinery has to know which.
   *
   * `x` values must be strictly increasing. The default is the two-point
   * identity, at which the pass is skipped entirely.
   */
  readonly toneCurve: number[]

  /** Colour temperature of the light the scene was under, in kelvin. */
  readonly temperature: number

  /** Green to magenta correction, perpendicular to the Planckian locus. */
  readonly tint: number

  /**
   * The film stage's three characteristic curves, one per channel.
   *
   * Three separate parameters rather than one grouped object, because the
   * flatness rule at the top of this file is what keeps snapshots, merges and
   * persistence free of special cases — and because they are independently
   * editable, which is the whole point of having three.
   */
  readonly filmCurveRed: number[]
  readonly filmCurveGreen: number[]
  readonly filmCurveBlue: number[]

  /** How far toward the film curves to go. 0 is off, 1 is the stock as designed. */
  readonly filmStrength: number

  /** How much scattered light to add back. 0 is off. */
  readonly halationStrength: number

  /**
   * Where scattering begins, in **stops from middle grey**. Display white is
   * +2.474, so a threshold above that catches only what exposure created.
   */
  readonly halationThreshold: number

  /** Scatter radius, as a fraction of the source image's long edge. */
  readonly halationRadius: number

  readonly grainStrength: number

  /**
   * The three colour wheels, as per-channel offsets in ACEScct.
   *
   * `readonly number[]` rather than `number[]`, which is what keeps them out of
   * the curve key derivation — see `parameterKinds.ts`. A mutable array here
   * would let `withCurve` accept a wheel key and sanitise three offsets as
   * interleaved control points.
   */
  readonly lift: readonly number[]
  readonly gamma: readonly number[]
  readonly gain: readonly number[]

  /** Six hue bands each, red through magenta. Neutral is zero throughout. */
  readonly hslHue: readonly number[]
  readonly hslSaturation: readonly number[]
  readonly hslLuminance: readonly number[]

  /**
   * Split toning: a tint for the shadows, a tint for the highlights, and the
   * position of the handover.
   *
   * The balance is in **stops from middle grey**, not as a position in the
   * encoded domain. That is the third parameter in this project to face the
   * choice and the first two got it wrong in the same way — a `[0, 1]` position
   * over an encoding puts most of its travel where no photograph has pixels.
   */
  readonly splitShadowTint: readonly number[]
  readonly splitHighlightTint: readonly number[]
  readonly splitBalance: number

  /**
   * Grain period, as a fraction of the source image's long edge.
   *
   * A physical size, so it is expressed against the source rather than against
   * whatever buffer is being drawn. Below about two buffer pixels the preview
   * cannot represent it and fades it out instead — see `src/core/colour/grain.ts`.
   */
  readonly grainSize: number
}

/** The keys of `EditState` whose values are numbers. */
export type NumericEditKey = {
  [K in keyof EditState]: EditState[K] extends number ? K : never
}[keyof EditState]

export type { ParameterDescriptor, ScalarDescriptor, CurveDescriptor } from './parameterKinds'

/**
 * The registry's descriptor types, narrowed to this build's actual keys.
 *
 * The registry has to type `key` as `string`, because it is heterogeneous by
 * construction and cannot know the state shape. Narrowing it back here means a
 * consumer holding a scalar descriptor gets a `NumericEditKey` and can index
 * `EditState` with it, which is what the tables were worth before the conversion
 * and would otherwise have been lost to it.
 */
export type ScalarParameter = ScalarDescriptor & { readonly key: NumericEditKey }
export type VectorParameter = VectorDescriptor & { readonly key: VectorEditKey }
export type CurveParameter = CurveDescriptor & { readonly key: CurveEditKey }

/**
 * The parameter table. Adding a parameter is adding a field to `EditState`, a
 * row here, and a default below — the interface, validation and reset all follow
 * from it without further work.
 *
 * Ranges are the *interface's* range, not a mathematical limit. `grade.ts`
 * accepts a negative contrast slope, which inverts the image; that is not
 * something a slider should offer, and the two decisions are kept separate.
 */
const SCALARS: readonly ScalarParameter[] = [
  {
    kind: 'scalar',
    key: 'exposure',
    label: 'Exposure',
    // Five stops either way covers recovering a badly underexposed frame and
    // pulling back a blown one, which is the useful photographic range. Wider
    // than that is a fix for a different problem.
    min: -5,
    max: 5,
    step: 0.01,
    defaultValue: 0,
    unit: 'EV',
  },
  {
    kind: 'scalar',
    key: 'contrast',
    label: 'Contrast',
    // A slope of 2 in ACEScct squares the ratio between any two channels in
    // linear light, which is already an extreme grade. 0 flattens to middle grey.
    //
    // The range is deliberately NOT narrowed to the 0.8-1.3 that was usable when
    // this was measured. Above about 1.3 the image was being destroyed — 42% of
    // a backlit frame blown to flat white at a slope of 1.4 — but that was the
    // *display path* clipping, not the operator misbehaving: the values were
    // correct and ordered right up to the point a hard clamp discarded them.
    // Narrowing the range would have treated a display problem as a parameter
    // problem, and baked in a limit that a tone map makes wrong.
    min: 0,
    max: 2,
    step: 0.01,
    defaultValue: 1,
    unit: '',
  },
  {
    kind: 'scalar',
    key: 'temperature',
    label: 'Temperature',
    // The range the Planckian fit is valid over, narrowed at the top: above
    // about 12000K the locus is so close to flat that the slider stops doing
    // anything visible, and the remaining travel is wasted.
    min: 2000,
    max: 12000,
    step: 10,
    defaultValue: NEUTRAL_TEMPERATURE,
    unit: 'K',
  },
  {
    kind: 'scalar',
    key: 'tint',
    label: 'Tint',
    min: -100,
    max: 100,
    step: 1,
    defaultValue: NEUTRAL_TINT,
    unit: '',
  },
  {
    kind: 'scalar',
    key: 'filmStrength',
    label: 'Film strength',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 1,
    unit: '',
  },
  {
    kind: 'scalar',
    key: 'halationStrength',
    label: 'Halation',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0,
    unit: '',
  },
  {
    kind: 'scalar',
    key: 'halationThreshold',
    label: 'Halation threshold',
    // In stops from middle grey, and the range is bounded by where data is
    // rather than by what reads as a round number.
    //
    // A display-referred image has no linear value above 1.0, so nothing in a
    // photograph sits above +2.474 until exposure lifts it. The range that
    // shipped ran to +4 with a comment claiming the whole of it was occupied;
    // measured against a real histogram, its top third did nothing at all.
    //
    // +3 keeps a stop of headroom, which exposure genuinely reaches, and stops
    // there. The floor is 0 rather than negative: below grey the effect stops
    // being a highlight threshold and washes the whole frame, which is a
    // legitimate extreme but not a place to go looking.
    //
    // The default moved from +1.5 to +2.0 after looking at photographs. At +1.5,
    // 31% of a lit interior is above threshold and a white brick wall glows pink
    // — see `tests/unit/occupancy.test.ts`, which holds the bound.
    min: 0,
    max: 3,
    step: 0.05,
    defaultValue: 2,
    unit: 'EV',
  },
  {
    kind: 'scalar',
    key: 'halationRadius',
    label: 'Halation radius',
    // A fraction of the source long edge, so it is the same size on a proxy and
    // on an export. Past about 0.015 it stops looking like film; the slider goes
    // further because that is a judgement rather than a limit.
    min: 0.001,
    max: 0.04,
    step: 0.0005,
    defaultValue: 0.006,
    unit: '',
  },
  {
    kind: 'scalar',
    key: 'grainStrength',
    label: 'Grain',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0,
    unit: '',
  },
  {
    kind: 'scalar',
    key: 'grainSize',
    label: 'Grain size',
    // A fraction of the source long edge. 0.0009 is about 5.4 source pixels on a
    // 6000px image, which is roughly 35mm grain viewed at a normal print size.
    //
    // The floor is not a taste decision: below two buffer pixels the preview
    // cannot represent the period at all and fades the amplitude rather than
    // drawing grain of the wrong size, so a slider reaching much further down
    // would be a control that visibly stops working partway along. 0.0005 is
    // three source pixels on a 6000px image, which a full-resolution export
    // can still draw on a 6000px source.
    min: 0.0005,
    max: 0.004,
    step: 0.0001,
    defaultValue: 0.0009,
    unit: '',
  },
  {
    kind: 'scalar',
    key: 'toneMapKnee',
    label: 'Highlight roll-off',
    // A single default cannot serve both an unedited photograph and a heavily
    // graded one, which was measured rather than assumed: on a backlit frame a
    // knee of 0.85 renders the sun gradient in 25 code values unedited against
    // 20 at 0.75, and in *one* code value at +2 EV against two. Raising the knee
    // improves an untouched image and flattens a pushed one, because it trades
    // resolution below white for resolution above it and no fixed point on that
    // trade is right for both.
    //
    // Bounds: below 0.3 pure white renders at code 218 or less, which reads as a
    // washed-out image before any grade; above 0.95 there are three code values
    // for everything the pipeline puts above white, which cannot represent a
    // roll-off at all.
    min: 0.3,
    max: 0.95,
    step: 0.01,
    defaultValue: 0.85,
    unit: '',
  },
  {
    kind: 'scalar',
    key: 'splitBalance',
    label: 'Split tone: balance',
    // In stops from middle grey. See src/core/colour/splitTone.ts for why this
    // is not a position in the encoded domain.
    min: SPLIT_BALANCE_MIN,
    max: SPLIT_BALANCE_MAX,
    step: 0.05,
    defaultValue: 0,
    unit: 'EV',
  },
]

/**
 * The state a new edit starts from, and what "reset" returns to.
 *
 * Written out rather than derived from {@link EDIT_PARAMETERS}, so that the type
 * checker verifies it covers every field. A test asserts the two agree, which is
 * two independent derivations of the same thing rather than one with a cast.
 */
/**
 * The tone curve's x axis is **ACEScct, from black to the encoding's top**, not
 * `[0, 1]`.
 *
 * `encodeACEScct(0)` is 0.0729, not zero: the encoding has a linear toe that
 * carries negative linear values, so the part of `[0, 1]` below that constant
 * describes light that does not exist. Starting the domain at black is both more
 * honest and the reason the remap in `curve.glsl` is exercised at all — with a
 * `[0, 1]` domain the remap is the identity, and a shader that ignored the
 * domain entirely would pass every test. That mutation was run and did pass
 * before this change.
 */
export const TONE_CURVE_DOMAIN: readonly [number, number] = [encodeACEScct(0), 1]

export const DEFAULT_EDIT_STATE: EditState = {
  exposure: 0,
  contrast: 1,
  temperature: NEUTRAL_TEMPERATURE,
  tint: NEUTRAL_TINT,
  toneMapKnee: TONE_MAP_KNEE,
  toneCurve: [TONE_CURVE_DOMAIN[0], TONE_CURVE_DOMAIN[0], 1, 1],
  filmCurveRed: [...IDENTITY_CHANNEL],
  filmCurveGreen: [...IDENTITY_CHANNEL],
  filmCurveBlue: [...IDENTITY_CHANNEL],
  filmStrength: 1,
  halationStrength: 0,
  halationThreshold: 2,
  halationRadius: 0.006,
  grainStrength: 0,
  grainSize: 0.0009,
  lift: [0, 0, 0],
  gamma: [0, 0, 0],
  gain: [0, 0, 0],
  hslHue: [0, 0, 0, 0, 0, 0],
  hslSaturation: [0, 0, 0, 0, 0, 0],
  hslLuminance: [0, 0, 0, 0, 0, 0],
  splitShadowTint: [0, 0, 0],
  splitHighlightTint: [0, 0, 0],
  splitBalance: 0,
}

/**
 * Keys whose value is an array of control points.
 *
 * Kept as a **separate table** from {@link EDIT_PARAMETERS} rather than adding a
 * `type` discriminant to it. A discriminated table would mean every consumer —
 * the interface, the validator, the merge — branching on the kind, which is the
 * special-casing that a second table avoids: a slider table and a curve table
 * each stay simple, and code that only cares about one iterates only that one.
 *
 * If a third kind arrives and the tables start needing to be walked together
 * everywhere, that is the signal this should become a registry rather than a
 * list, and it should be changed then rather than discriminated now.
 */
export type CurveEditKey = {
  [K in keyof EditState]: EditState[K] extends number[] ? K : never
}[keyof EditState]

/**
 * Keys whose value is a fixed-length vector.
 *
 * Note the asymmetry with {@link CurveEditKey}: a curve is a mutable `number[]`
 * and a vector is a `readonly number[]`, so the two derivations are disjoint and
 * a wheel key cannot reach `withCurve`.
 */
export type VectorEditKey = {
  [K in keyof EditState]: EditState[K] extends number[]
    ? never
    : EditState[K] extends readonly number[]
      ? K
      : never
}[keyof EditState]

const VECTORS: readonly VectorParameter[] = [
  {
    kind: 'vector',
    key: 'lift',
    label: 'Lift (shadows)',
    length: 3,
    // The offset is in ACEScct, so the range is in the same units the value is.
    // WHEEL_RANGE is a little over one stop; wheels are a trim control and a
    // range that moves a zone further than that has already stopped looking like
    // a photograph.
    min: -WHEEL_RANGE,
    max: WHEEL_RANGE,
    step: 0.001,
    defaultValue: [0, 0, 0],
    identityValue: [0, 0, 0],
    components: ['Red', 'Green', 'Blue'],
  },
  {
    kind: 'vector',
    key: 'gamma',
    label: 'Gamma (midtones)',
    length: 3,
    // The offset is in ACEScct, so the range is in the same units the value is.
    // WHEEL_RANGE is a little over one stop; wheels are a trim control and a
    // range that moves a zone further than that has already stopped looking like
    // a photograph.
    min: -WHEEL_RANGE,
    max: WHEEL_RANGE,
    step: 0.001,
    defaultValue: [0, 0, 0],
    identityValue: [0, 0, 0],
    components: ['Red', 'Green', 'Blue'],
  },
  {
    kind: 'vector',
    key: 'gain',
    label: 'Gain (highlights)',
    length: 3,
    // The offset is in ACEScct, so the range is in the same units the value is.
    // WHEEL_RANGE is a little over one stop; wheels are a trim control and a
    // range that moves a zone further than that has already stopped looking like
    // a photograph.
    min: -WHEEL_RANGE,
    max: WHEEL_RANGE,
    step: 0.001,
    defaultValue: [0, 0, 0],
    identityValue: [0, 0, 0],
    components: ['Red', 'Green', 'Blue'],
  },
  {
    kind: 'vector',
    key: 'hslHue',
    label: 'Hue by band',
    length: HSL_BAND_COUNT,
    min: -HSL_HUE_RANGE,
    max: HSL_HUE_RANGE,
    step: 0.5,
    defaultValue: [0, 0, 0, 0, 0, 0],
    identityValue: [0, 0, 0, 0, 0, 0],
    components: HSL_BANDS,
  },
  {
    kind: 'vector',
    key: 'hslSaturation',
    label: 'Saturation by band',
    length: HSL_BAND_COUNT,
    min: -HSL_SATURATION_RANGE,
    max: HSL_SATURATION_RANGE,
    step: 0.01,
    defaultValue: [0, 0, 0, 0, 0, 0],
    identityValue: [0, 0, 0, 0, 0, 0],
    components: HSL_BANDS,
  },
  {
    kind: 'vector',
    key: 'hslLuminance',
    label: 'Luminance by band',
    length: HSL_BAND_COUNT,
    min: -HSL_LUMINANCE_RANGE,
    max: HSL_LUMINANCE_RANGE,
    step: 0.01,
    defaultValue: [0, 0, 0, 0, 0, 0],
    identityValue: [0, 0, 0, 0, 0, 0],
    components: HSL_BANDS,
  },
  {
    kind: 'vector',
    key: 'splitShadowTint',
    label: 'Split tone: shadows',
    length: 3,
    min: -SPLIT_TINT_RANGE,
    max: SPLIT_TINT_RANGE,
    step: 0.001,
    defaultValue: [0, 0, 0],
    identityValue: [0, 0, 0],
    components: ['Red', 'Green', 'Blue'],
  },
  {
    kind: 'vector',
    key: 'splitHighlightTint',
    label: 'Split tone: highlights',
    length: 3,
    min: -SPLIT_TINT_RANGE,
    max: SPLIT_TINT_RANGE,
    step: 0.001,
    defaultValue: [0, 0, 0],
    identityValue: [0, 0, 0],
    components: ['Red', 'Green', 'Blue'],
  },
]

const CURVES: readonly CurveParameter[] = [
  {
    kind: 'curve',
    key: 'toneCurve',
    label: 'Tone curve',
    domain: TONE_CURVE_DOMAIN,
    defaultValue: [TONE_CURVE_DOMAIN[0], TONE_CURVE_DOMAIN[0], 1, 1],
  },
  { kind: 'curve', hidden: true, key: 'filmCurveRed', label: 'Film red', domain: FILM_DOMAIN, defaultValue: IDENTITY_CHANNEL },
  { kind: 'curve', hidden: true, key: 'filmCurveGreen', label: 'Film green', domain: FILM_DOMAIN, defaultValue: IDENTITY_CHANNEL },
  { kind: 'curve', hidden: true, key: 'filmCurveBlue', label: 'Film blue', domain: FILM_DOMAIN, defaultValue: IDENTITY_CHANNEL },
]

/**
 * **The** parameter table: one row per field of {@link EditState}, in the order
 * the interface presents them.
 *
 * Adding a parameter is adding a field to `EditState`, a row here, and a default
 * below. Validation, merging, snapshotting, equality, the identity check and the
 * control all follow from the row's `kind` through the registry in
 * `parameterKinds.ts`, without any consumer learning that the kind exists.
 */
export const PARAMETERS: readonly ParameterDescriptor[] = [
  ...SCALARS,
  ...VECTORS,
  ...CURVES,
]

/**
 * Views onto {@link PARAMETERS}, derived rather than maintained.
 *
 * These exist because a slider panel genuinely wants only the scalars and a curve
 * editor genuinely wants only the curves. They are a query against the one table,
 * not a second and third table to keep in step — which is what they were before
 * the registry, and what made a third kind expensive.
 */
export const EDIT_PARAMETERS: readonly ScalarParameter[] = SCALARS
export const VECTOR_PARAMETERS: readonly VectorParameter[] = VECTORS
export const CURVE_PARAMETERS: readonly CurveParameter[] = CURVES

const BY_KEY = new Map<string, ParameterDescriptor>(PARAMETERS.map((p) => [p.key, p]))

export class UnknownParameterError extends RangeError {}

/** The descriptor for a key, whatever its kind. */
export function descriptorFor(key: string): ParameterDescriptor {
  const descriptor = BY_KEY.get(key)
  if (!descriptor) throw new UnknownParameterError(`no descriptor for parameter "${key}"`)
  return descriptor
}

/** Whether a key is one this build knows about. Used when loading a preset. */
export function isKnownParameter(key: string): boolean {
  return BY_KEY.has(key)
}

/**
 * A film stock as a `Partial<EditState>` — which is what a preset is.
 *
 * Deliberately *not* a `filmStock: string` parameter. That would have been a
 * third kind of parameter, after numbers and curves, and the tables would then
 * have needed walking together everywhere — which is the trigger recorded in
 * `tests/README.md` for replacing them with a registry.
 *
 * Making a stock a preset avoids the question rather than answering it, and is
 * the better model anyway: `CLAUDE.md` already defines a preset as a
 * `Partial<EditState>` applied by merge, the three curves stay independently
 * editable after a stock is applied, and nothing has to remember which stock
 * "is selected" once the curves have been touched. The registry trigger stands
 * for whenever a genuinely new kind arrives.
 */
export function filmStockPatch(stock: FilmStock): Partial<EditState> {
  return {
    filmCurveRed: [...stock.red],
    filmCurveGreen: [...stock.green],
    filmCurveBlue: [...stock.blue],
  }
}

/** Whether the film stage would do anything. */
export function isFilmStageIdentity(state: EditState): boolean {
  return (
    state.filmStrength === 0 ||
    (isIdentityChannel(state.filmCurveRed) &&
      isIdentityChannel(state.filmCurveGreen) &&
      isIdentityChannel(state.filmCurveBlue))
  )
}

/**
 * Bring a control point array into a usable state, or fall back to the default.
 *
 * Now a thin call into the registry, which owns the rules: reject anything
 * structurally wrong — an odd length, fewer than two points, a non-finite value,
 * x values that decrease — because a repaired curve is a different curve and
 * silently substituting one is worse than visibly falling back. Values *within* a
 * valid structure are clamped, since that is a bound rather than a shape.
 */
export function sanitiseCurve(key: CurveEditKey, points: readonly number[]): number[] {
  const descriptor = descriptorFor(key)
  return sanitiseParameter(descriptor, points, defaultParameter(descriptor)) as number[]
}

/** Split interleaved control points into the two arrays the spline works on. */
export function splitControlPoints(points: readonly number[]): {
  xs: number[]
  ys: number[]
} {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i + 1 < points.length; i += 2) {
    xs.push(points[i] ?? Number.NaN)
    ys.push(points[i + 1] ?? Number.NaN)
  }
  return { xs, ys }
}

/**
 * Whether a curve is its descriptor's identity, in which case its pass is
 * skipped.
 *
 * Compared against the descriptor rather than against hardcoded endpoints, so the
 * identity follows the domain instead of having to be remembered alongside it. A
 * curve that is the identity by shape but carries extra control points is not
 * detected, which costs a redundant pass and never a wrong image.
 */
export function isIdentityCurve(key: CurveEditKey, points: readonly number[]): boolean {
  return parameterIsIdentity(descriptorFor(key), [...points])
}

export function parameterDescriptor(key: NumericEditKey): ScalarDescriptor {
  const descriptor = descriptorFor(key)
  if (descriptor.kind !== 'scalar') {
    throw new UnknownParameterError(`parameter "${key}" is not a scalar`)
  }
  return descriptor
}

export function clampParameter(key: NumericEditKey, value: number): number {
  const descriptor = parameterDescriptor(key)
  if (!Number.isFinite(value)) return descriptor.defaultValue
  return Math.min(descriptor.max, Math.max(descriptor.min, value))
}

/**
 * Apply a `Partial<EditState>` — which is what a preset is — over a base state,
 * validating as it goes.
 *
 * A merge is a spread, and this exists for the validation rather than for the
 * merge: a preset loaded from disk is untrusted input, and it reaches the shader
 * if nothing checks it.
 *
 * **Unknown keys are dropped rather than carried**, because the loop is over the
 * parameter table and not over the patch's own keys. A preset written against a
 * later version of the application therefore cannot smuggle a field into a state
 * that is then snapshotted into undo history. That property comes from the
 * direction of the iteration, so it survives any number of new kinds.
 *
 * Every value that is *not* being replaced is snapshotted rather than referenced,
 * so no two states share a mutable array.
 */
export function mergeEditState(base: EditState, patch: Partial<EditState>): EditState {
  const source = base as unknown as Record<string, ParameterValue>
  const incoming = patch as unknown as Record<string, unknown>
  const merged: Record<string, ParameterValue> = {}
  for (const descriptor of PARAMETERS) {
    const current = source[descriptor.key] ?? defaultParameter(descriptor)
    merged[descriptor.key] =
      incoming[descriptor.key] === undefined
        ? snapshotParameter(descriptor, current)
        : sanitiseParameter(descriptor, incoming[descriptor.key], current)
  }
  return merged as unknown as EditState
}

/**
 * A copy of `state` with one parameter changed, validated.
 *
 * The cast is confined here, alongside the flatness invariant it depends on,
 * rather than repeated at every call site with a computed key.
 */
export function withParameter(state: EditState, key: NumericEditKey, value: number): EditState {
  return withValue(state, key, value)
}

/** A copy of `state` with one curve replaced, validated. */
export function withCurve(
  state: EditState,
  key: CurveEditKey,
  points: readonly number[],
): EditState {
  return withValue(state, key, [...points])
}

/**
 * A copy of `state` with one parameter of any kind replaced, validated.
 *
 * The kind-agnostic form the registry makes possible. `withParameter` and
 * `withCurve` remain as the typed entry points, because a caller that knows it is
 * setting a number should not be able to hand in an array by mistake.
 */
export function withValue(state: EditState, key: string, value: unknown): EditState {
  const descriptor = descriptorFor(key)
  const source = state as unknown as Record<string, ParameterValue>
  const next: Record<string, unknown> = { ...state }
  next[key] = sanitiseParameter(descriptor, value, source[key] ?? defaultParameter(descriptor))
  return next as unknown as EditState
}

/** Whether two states describe the same edit. Flat, so a key-wise compare is exact. */
export function editStatesEqual(a: EditState, b: EditState): boolean {
  const left = a as unknown as Record<string, ParameterValue>
  const right = b as unknown as Record<string, ParameterValue>
  // By value, not by reference. Two states reached by different routes hold
  // different arrays, and history compares snapshots to decide whether anything
  // changed — a reference compare would record an entry for every drag frame.
  return PARAMETERS.every((descriptor) => {
    const l = left[descriptor.key]
    const r = right[descriptor.key]
    if (l === undefined || r === undefined) return l === r
    return parametersEqual(descriptor, l, r)
  })
}

/** A deep copy, safe to store in history. Every kind supplies its own copy rule. */
export function snapshotEditState(state: EditState): EditState {
  const source = state as unknown as Record<string, ParameterValue>
  const out: Record<string, ParameterValue> = {}
  for (const descriptor of PARAMETERS) {
    out[descriptor.key] = snapshotParameter(
      descriptor,
      source[descriptor.key] ?? defaultParameter(descriptor),
    )
  }
  return out as unknown as EditState
}

/** Whether a parameter is at the value that makes its pass a no-op. */
export function isParameterIdentity(state: EditState, key: string): boolean {
  const descriptor = descriptorFor(key)
  const source = state as unknown as Record<string, ParameterValue>
  return parameterIsIdentity(descriptor, source[key] ?? defaultParameter(descriptor))
}
