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
}

/** The keys of `EditState` whose values are numbers. */
export type NumericEditKey = {
  [K in keyof EditState]: EditState[K] extends number ? K : never
}[keyof EditState]

/**
 * Static metadata for one numeric parameter: everything the interface needs to
 * present it and everything loading needs to validate it.
 *
 * Kept as plain data rather than carrying a formatter, so the table stays as
 * serialisable as the state it describes and formatting stays a presentation
 * decision.
 */
export interface ParameterDescriptor {
  readonly key: NumericEditKey
  readonly label: string
  readonly min: number
  readonly max: number
  /** Slider granularity. Not a constraint on the value; see {@link clampParameter}. */
  readonly step: number
  readonly defaultValue: number
  /** Suffix for display. Empty when the parameter is a bare ratio. */
  readonly unit: string
}

/**
 * The parameter table. Adding a parameter is adding a field to `EditState`, a
 * row here, and a default below — the interface, validation and reset all follow
 * from it without further work.
 *
 * Ranges are the *interface's* range, not a mathematical limit. `grade.ts`
 * accepts a negative contrast slope, which inverts the image; that is not
 * something a slider should offer, and the two decisions are kept separate.
 */
export const EDIT_PARAMETERS: readonly ParameterDescriptor[] = [
  {
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
]

/**
 * The state a new edit starts from, and what "reset" returns to.
 *
 * Written out rather than derived from {@link EDIT_PARAMETERS}, so that the type
 * checker verifies it covers every field. A test asserts the two agree, which is
 * two independent derivations of the same thing rather than one with a cast.
 */
export const DEFAULT_EDIT_STATE: EditState = {
  exposure: 0,
  contrast: 1,
}

const DESCRIPTORS_BY_KEY = new Map<NumericEditKey, ParameterDescriptor>(
  EDIT_PARAMETERS.map((parameter) => [parameter.key, parameter]),
)

export function parameterDescriptor(key: NumericEditKey): ParameterDescriptor {
  const descriptor = DESCRIPTORS_BY_KEY.get(key)
  if (!descriptor) throw new RangeError(`no descriptor for parameter "${key}"`)
  return descriptor
}

/**
 * Bring a value into the parameter's range, replacing anything non-finite with
 * the default.
 *
 * `NaN` is the case that matters. It arrives from an empty number input, a
 * malformed preset or a division in a future derived parameter, and it does not
 * announce itself: `NaN` compared against a range is neither too big nor too
 * small, so an unchecked value propagates into the shader and turns a region of
 * the image into undefined output. Failing back to the default is recoverable;
 * a frame of `NaN` is not diagnosable from the picture.
 *
 * The value is **not** snapped to `step`. Step is slider granularity; a preset
 * or a typed value is free to sit between stops.
 */
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
 * if nothing checks it. Unknown keys are dropped rather than carried, so a
 * preset written against a later version of the application cannot smuggle a
 * field into a state that is then snapshotted into undo history.
 */
export function mergeEditState(base: EditState, patch: Partial<EditState>): EditState {
  const merged: Record<string, number> = {}
  for (const descriptor of EDIT_PARAMETERS) {
    const incoming = patch[descriptor.key]
    merged[descriptor.key] =
      incoming === undefined ? base[descriptor.key] : clampParameter(descriptor.key, incoming)
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
  const next: Record<string, number> = { ...state }
  next[key] = clampParameter(key, value)
  return next as unknown as EditState
}

/** Whether two states describe the same edit. Flat, so a key-wise compare is exact. */
export function editStatesEqual(a: EditState, b: EditState): boolean {
  return EDIT_PARAMETERS.every((descriptor) => a[descriptor.key] === b[descriptor.key])
}
