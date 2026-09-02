/**
 * The parameter kind registry.
 *
 * # Why this replaced two tables
 *
 * Until the grade stage there were exactly two kinds of parameter — a number and
 * a curve — and they lived in two hand-maintained tables. That was deliberate,
 * and `tests/README.md` recorded the trigger for changing it: a third kind
 * arriving would mean every consumer walking both tables together and branching
 * on which it was in.
 *
 * The trigger fired. Colour wheels are triples, split toning is a pair of tinted
 * ranges, and HSL is banded, so a third and fourth kind arrive together. Two
 * tables become four, and `mergeEditState`, `editStatesEqual`, the snapshot
 * copy, the identity check and the control renderer each grow a branch per kind.
 *
 * A kind registers **how it behaves** once, here, and consumers ask the registry
 * instead of branching. Adding a fifth kind touches this file and the descriptor
 * table, and nothing else.
 *
 * # What a kind has to supply
 *
 * - `sanitise` — untrusted input to a stored value. A preset loaded from disk
 *   reaches the shader if nothing checks it.
 * - `snapshot` — a copy safe to put in undo history. See the note on it below;
 *   it is the one method with a correctness requirement rather than a shape.
 * - `equals` — by value. History compares snapshots to decide whether anything
 *   changed, so a reference compare records an entry per drag frame.
 * - `isIdentity` — whether the pass can be skipped entirely.
 */

/** Fields every descriptor has, whatever its kind. */
export interface DescriptorBase {
  readonly key: string
  readonly kind: string
  readonly label: string
  /**
   * Whether the adjustments panel offers a control for this parameter.
   *
   * One flag rather than a branch on kind, which is the distinction that matters:
   * the three film curves are driven by picking a stock and have no business
   * appearing as three spline editors, but that is a fact about those three rows
   * and not about curves in general.
   */
  readonly hidden?: boolean
}

export interface ScalarDescriptor extends DescriptorBase {
  readonly kind: 'scalar'
  readonly min: number
  readonly max: number
  readonly step: number
  readonly defaultValue: number
  readonly unit: string
  /**
   * The value at which this parameter does nothing, when it has one.
   *
   * Not every parameter does. The highlight roll-off knee has no identity: any
   * value is a choice about how highlights behave.
   */
  readonly identityValue?: number
}

export interface CurveDescriptor extends DescriptorBase {
  readonly kind: 'curve'
  /** The range control point x values must lie within. */
  readonly domain: readonly [number, number]
  readonly defaultValue: readonly number[]
}

/**
 * A fixed-length vector: a colour wheel, a split-tone tint, a set of hue bands.
 *
 * **Typed as a readonly array, and that is load-bearing rather than tidy.** A
 * curve is stored as `number[]`, and the curve key type is derived from
 * `EditState[K] extends number[]`. A mutable array would satisfy that test, so
 * wheels would silently join `CurveEditKey` and `withCurve` would accept a wheel
 * key and apply curve semantics to it — sanitising a three-component wheel as
 * interleaved control points. A readonly array is not assignable to `number[]`,
 * so the derivation excludes it and the mistake is a compile error.
 * `tests/unit/parameter-kinds.test.ts` asserts the exclusion holds.
 *
 * One kind carrying its own length rather than a `triple` kind and a `bands`
 * kind. The two would be near-identical code, and the registry's properties —
 * snapshot never shares, sanitise never throws — would then need asserting twice
 * instead of once.
 */
export type Vector = readonly number[]
/** A vector of exactly three, for the callers that know they have one. */
export type Triple = readonly [number, number, number]

export interface VectorDescriptor extends DescriptorBase {
  readonly kind: 'vector'
  /** How many components. Sanitisation rejects anything else outright. */
  readonly length: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly defaultValue: Vector
  /** The value at which this parameter does nothing. */
  readonly identityValue: Vector
  /** Labels for the components, for the control and for messages. */
  readonly components: readonly string[]
}

export type ParameterDescriptor = ScalarDescriptor | CurveDescriptor | VectorDescriptor

/** The stored value of a parameter, whatever its kind. */
export type ParameterValue = number | number[] | Vector

export interface ParameterKind<D extends ParameterDescriptor, V extends ParameterValue> {
  readonly kind: D['kind']
  /**
   * Untrusted input to a stored value, falling back when it cannot be salvaged.
   *
   * Never throws. A preset with one bad field should lose that field, not fail to
   * load, and the caller has a valid fallback to hand in every case.
   */
  sanitise(descriptor: D, incoming: unknown, fallback: V): V
  /**
   * A copy safe to store in a history snapshot.
   *
   * **Must not return the value it was given** when that value is an object.
   * Undo holds snapshots, so a shared array turns a later edit into a silent
   * rewrite of history — a bug that surfaces long after the change that caused
   * it. A scalar returning itself is correct and a triple returning itself is
   * not, which is exactly the kind of distinction a registry should carry rather
   * than each call site. Asserted over the whole registry in
   * `tests/unit/parameter-kinds.test.ts`.
   */
  snapshot(value: V): V
  equals(a: V, b: V): boolean
  isIdentity(descriptor: D, value: V): boolean
  /** The value a fresh edit starts from. */
  defaultOf(descriptor: D): V
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** A finite number, or null. Rejects NaN, Infinity, strings and objects alike. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const scalarKind: ParameterKind<ScalarDescriptor, number> = {
  kind: 'scalar',
  sanitise(descriptor, incoming, fallback) {
    const value = finite(incoming)
    return value === null ? fallback : clamp(value, descriptor.min, descriptor.max)
  },
  snapshot: (value) => value,
  equals: (a, b) => a === b,
  isIdentity: (descriptor, value) =>
    descriptor.identityValue !== undefined && value === descriptor.identityValue,
  defaultOf: (descriptor) => descriptor.defaultValue,
}

export const vectorKind: ParameterKind<VectorDescriptor, Vector> = {
  kind: 'vector',
  sanitise(descriptor, incoming, fallback) {
    // A wrong length is a different parameter, not a damaged one: there is no
    // reading of four numbers as a three-component wheel that is not a guess.
    if (!Array.isArray(incoming) || incoming.length !== descriptor.length) return fallback
    return incoming.map((v, i) => {
      const value = finite(v)
      return value === null ? fallback[i] ?? 0 : clamp(value, descriptor.min, descriptor.max)
    })
  },
  // A fresh array, not the one handed in. See the note on `snapshot`.
  snapshot: (value) => [...value],
  equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
  isIdentity: (descriptor, value) => vectorKind.equals(descriptor.identityValue, value),
  defaultOf: (descriptor) => [...descriptor.defaultValue],
}

/**
 * Curve sanitisation, which is the involved one.
 *
 * Control points arrive interleaved as `[x, y, ...]`. They must be finite, in
 * the descriptor's domain, and strictly increasing in x — a spline through
 * non-monotone x is not a function, and the LUT bake would read garbage.
 */
export const curveKind: ParameterKind<CurveDescriptor, number[]> = {
  kind: 'curve',
  sanitise(descriptor, incoming, fallback) {
    if (!Array.isArray(incoming)) return [...fallback]
    // Odd length means a truncated pair; there is no sensible reading of it.
    if (incoming.length < 4 || incoming.length % 2 !== 0) return [...fallback]

    const [lo, hi] = descriptor.domain
    const points: number[] = []
    let previousX = -Infinity
    for (let i = 0; i < incoming.length; i += 2) {
      const x = finite(incoming[i])
      const y = finite(incoming[i + 1])
      if (x === null || y === null) return [...fallback]
      const clampedX = clamp(x, lo, hi)
      // Equal x values are dropped rather than rejected: two points at the same
      // position are a duplicate, not a corruption, and dropping one leaves a
      // valid curve. A decreasing x is a different matter and rejects the lot.
      if (clampedX < previousX) return [...fallback]
      if (clampedX === previousX) continue
      previousX = clampedX
      points.push(clampedX, clamp(y, lo, hi))
    }
    return points.length >= 4 ? points : [...fallback]
  },
  snapshot: (value) => [...value],
  equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
  isIdentity(descriptor, value) {
    const identity = descriptor.defaultValue
    return value.length === identity.length && value.every((v, i) => v === identity[i])
  },
  defaultOf: (descriptor) => [...descriptor.defaultValue],
}

/**
 * The registry.
 *
 * Keyed by the `kind` string a descriptor carries, so a consumer that has a
 * descriptor can always reach the behaviour without knowing the set of kinds.
 */
const KINDS = new Map<string, ParameterKind<never, never>>([
  [scalarKind.kind, scalarKind as unknown as ParameterKind<never, never>],
  [curveKind.kind, curveKind as unknown as ParameterKind<never, never>],
  [vectorKind.kind, vectorKind as unknown as ParameterKind<never, never>],
])

/** Every registered kind name, for coverage assertions. */
export const REGISTERED_KINDS: readonly string[] = [...KINDS.keys()]

export class UnknownParameterKindError extends Error {}

/**
 * The behaviour registered for a descriptor's kind.
 *
 * Throws rather than returning undefined. A descriptor with an unregistered kind
 * is a programming error at module load, not a runtime condition to handle: it
 * would otherwise silently skip validation for that parameter.
 */
export function kindOf(descriptor: ParameterDescriptor): ParameterKind<never, never> {
  const kind = KINDS.get(descriptor.kind)
  if (!kind) {
    throw new UnknownParameterKindError(
      `parameter "${descriptor.key}" declares unregistered kind "${descriptor.kind}"`,
    )
  }
  return kind
}

/**
 * The registry's operations, applied to a descriptor and a loosely typed value.
 *
 * The casts are confined here. Each kind is internally well typed against its own
 * descriptor and value; the registry is heterogeneous by construction, and the
 * alternative is every consumer carrying the same cast.
 */
type Loose = ParameterKind<ParameterDescriptor, ParameterValue>

export function sanitiseParameter(
  descriptor: ParameterDescriptor,
  incoming: unknown,
  fallback: ParameterValue,
): ParameterValue {
  return (kindOf(descriptor) as unknown as Loose).sanitise(descriptor, incoming, fallback)
}

export function snapshotParameter(
  descriptor: ParameterDescriptor,
  value: ParameterValue,
): ParameterValue {
  return (kindOf(descriptor) as unknown as Loose).snapshot(value)
}

export function parametersEqual(
  descriptor: ParameterDescriptor,
  a: ParameterValue,
  b: ParameterValue,
): boolean {
  return (kindOf(descriptor) as unknown as Loose).equals(a, b)
}

export function parameterIsIdentity(
  descriptor: ParameterDescriptor,
  value: ParameterValue,
): boolean {
  return (kindOf(descriptor) as unknown as Loose).isIdentity(descriptor, value)
}

export function defaultParameter(descriptor: ParameterDescriptor): ParameterValue {
  return (kindOf(descriptor) as unknown as Loose).defaultOf(descriptor)
}
