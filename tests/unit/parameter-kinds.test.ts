import { describe, expect, it } from 'vitest'

import {
  REGISTERED_KINDS,
  UnknownParameterKindError,
  curveKind,
  defaultParameter,
  kindOf,
  parameterIsIdentity,
  parametersEqual,
  sanitiseParameter,
  scalarKind,
  snapshotParameter,
  tripleKind,
} from '../../src/core/state/parameterKinds'
import type {
  CurveDescriptor,
  ParameterDescriptor,
  ScalarDescriptor,
  TripleDescriptor,
} from '../../src/core/state/parameterKinds'
import { PARAMETERS } from '../../src/core/state/editState'

/**
 * Properties of the registry itself, asserted once and inherited by every kind
 * added later.
 *
 * This is the whole return on the conversion. Before it, "a snapshot must not
 * share an array" was a rule each call site had to remember, and remembering it
 * for curves while forgetting it for a triple is the sort of thing that surfaces
 * as corrupted undo history a week later. Here it is one test over the registry.
 */

const SCALAR: ScalarDescriptor = {
  kind: 'scalar', key: 'test', label: 'Test',
  min: -2, max: 2, step: 0.1, defaultValue: 0.5, unit: '', identityValue: 0,
}
const CURVE: CurveDescriptor = {
  kind: 'curve', key: 'testCurve', label: 'Test curve',
  domain: [0, 1], defaultValue: [0, 0, 1, 1],
}
const TRIPLE: TripleDescriptor = {
  kind: 'triple', key: 'testTriple', label: 'Test triple',
  min: -1, max: 1, step: 0.01, defaultValue: [0, 0, 0], identityValue: [0, 0, 0],
  components: ['R', 'G', 'B'],
}
const SAMPLES: readonly { descriptor: ParameterDescriptor; value: unknown }[] = [
  { descriptor: SCALAR, value: 0.5 },
  { descriptor: CURVE, value: [0, 0, 1, 1] },
  { descriptor: TRIPLE, value: [0.1, -0.2, 0.3] as const },
]

describe('the registry', () => {
  it('registers a behaviour for every kind any descriptor declares', () => {
    // The failure this prevents is silent rather than loud: a descriptor with an
    // unregistered kind would otherwise skip validation entirely, so a preset
    // could put anything in that field.
    for (const descriptor of PARAMETERS) {
      expect(() => kindOf(descriptor), `${descriptor.key}`).not.toThrow()
      expect(REGISTERED_KINDS).toContain(descriptor.kind)
    }
  })

  it('refuses a descriptor whose kind is not registered', () => {
    const rogue = { kind: 'quaternion', key: 'x', label: 'X' } as unknown as ParameterDescriptor
    expect(() => kindOf(rogue)).toThrow(UnknownParameterKindError)
  })

  it('has every registered kind reachable by name', () => {
    expect([...REGISTERED_KINDS].sort()).toEqual(['curve', 'scalar', 'triple'])
    expect(scalarKind.kind).toBe('scalar')
    expect(curveKind.kind).toBe('curve')
    expect(tripleKind.kind).toBe('triple')
  })
})

describe('snapshot never shares a mutable value', () => {
  // The one method with a correctness requirement rather than a shape. Undo holds
  // snapshots, so a shared array turns a later edit into a silent rewrite of
  // history. A scalar returning itself is correct; a triple returning itself is
  // not, and that distinction is exactly what belongs in a registry rather than
  // at each call site.
  it('returns a fresh object for every kind whose value is one', () => {
    for (const { descriptor, value } of SAMPLES) {
      const copy = snapshotParameter(descriptor, value as never)
      expect(parametersEqual(descriptor, copy, value as never), `${descriptor.kind} value`).toBe(
        true,
      )
      if (typeof value === 'object' && value !== null) {
        expect(copy, `${descriptor.kind} snapshot shares its input`).not.toBe(value)
      }
    }
  })

  it('produces a copy that cannot be changed through the original', () => {
    const original = [0, 0, 0.5, 0.5, 1, 1]
    const copy = snapshotParameter(CURVE, original) as number[]
    original[2] = 0.9
    expect(copy[2]).toBe(0.5)
  })

  it('produces a default that cannot be changed through the descriptor', () => {
    // The same hazard one level up: handing out the descriptor's own array would
    // let one edit rewrite the default for the whole session.
    const first = defaultParameter(CURVE) as number[]
    first[0] = 99
    expect((defaultParameter(CURVE) as number[])[0]).toBe(0)
  })
})

describe('sanitise never throws and always returns something usable', () => {
  const JUNK: readonly unknown[] = [
    undefined, null, NaN, Infinity, -Infinity, 'string', {}, [], [1], [1, 2, 3, 'x'],
    { length: 4 }, true, () => 0, [1, 2, 3, 4, 5],
  ]

  it('falls back rather than failing, for every kind and every kind of junk', () => {
    // A preset with one bad field should lose that field, not fail to load.
    for (const { descriptor, value } of SAMPLES) {
      for (const junk of JUNK) {
        expect(
          () => sanitiseParameter(descriptor, junk, value as never),
          `${descriptor.kind} given ${String(junk)}`,
        ).not.toThrow()
      }
    }
  })

  it('clamps a scalar into range and rejects what is not a number', () => {
    expect(sanitiseParameter(SCALAR, 99, 0.5)).toBe(2)
    expect(sanitiseParameter(SCALAR, -99, 0.5)).toBe(-2)
    expect(sanitiseParameter(SCALAR, NaN, 0.5)).toBe(0.5)
    expect(sanitiseParameter(SCALAR, '1', 0.5)).toBe(0.5)
  })

  it('clamps a triple component-wise and keeps its length', () => {
    expect(sanitiseParameter(TRIPLE, [5, -5, 0.25], [0, 0, 0])).toEqual([1, -1, 0.25])
    expect(sanitiseParameter(TRIPLE, [1, 2], [0, 0, 0])).toEqual([0, 0, 0])
    // One bad component falls back for that component only, not the whole triple.
    expect(sanitiseParameter(TRIPLE, [0.5, NaN, 0.5], [0, 0.9, 0])).toEqual([0.5, 0.9, 0.5])
  })

  it('rejects a curve whose x values decrease, and drops duplicates', () => {
    expect(sanitiseParameter(CURVE, [0, 0, 0.5, 0.5, 0.2, 0.2], [0, 0, 1, 1])).toEqual([0, 0, 1, 1])
    // A repeated x is a duplicate rather than a corruption: dropping one leaves a
    // valid curve, where rejecting the lot would discard a usable edit.
    expect(sanitiseParameter(CURVE, [0, 0, 0.5, 0.5, 0.5, 0.7, 1, 1], [0, 0, 1, 1])).toEqual([
      0, 0, 0.5, 0.5, 1, 1,
    ])
  })

  it('never returns a value outside the descriptor it was given', () => {
    for (let i = 0; i < 200; i++) {
      const wild = (Math.random() - 0.5) * 1000
      expect(sanitiseParameter(SCALAR, wild, 0)).toBeGreaterThanOrEqual(SCALAR.min)
      expect(sanitiseParameter(SCALAR, wild, 0)).toBeLessThanOrEqual(SCALAR.max)
      const triple = sanitiseParameter(TRIPLE, [wild, -wild, wild / 2], [0, 0, 0]) as number[]
      for (const c of triple) {
        expect(c).toBeGreaterThanOrEqual(TRIPLE.min)
        expect(c).toBeLessThanOrEqual(TRIPLE.max)
      }
    }
  })
})

describe('equality and identity', () => {
  it('compares by value, not by reference', () => {
    // History compares snapshots to decide whether anything changed. A reference
    // compare would record an entry for every frame of a drag.
    expect(parametersEqual(CURVE, [0, 0, 1, 1], [0, 0, 1, 1])).toBe(true)
    expect(parametersEqual(TRIPLE, [1, 2, 3] as const, [1, 2, 3] as const)).toBe(true)
    expect(parametersEqual(TRIPLE, [1, 2, 3] as const, [1, 2, 4] as const)).toBe(false)
  })

  it('recognises the identity for the kinds that have one', () => {
    expect(parameterIsIdentity(SCALAR, 0)).toBe(true)
    expect(parameterIsIdentity(SCALAR, 0.5)).toBe(false)
    expect(parameterIsIdentity(TRIPLE, [0, 0, 0] as const)).toBe(true)
    expect(parameterIsIdentity(TRIPLE, [0, 0, 0.01] as const)).toBe(false)
    expect(parameterIsIdentity(CURVE, [0, 0, 1, 1])).toBe(true)
  })

  it('reports no identity for a scalar that has none', () => {
    // The roll-off knee is the real case: every value is a choice, so nothing is
    // a no-op, and claiming one would skip a pass that must run.
    const noIdentity: ScalarDescriptor = { ...SCALAR }
    delete (noIdentity as { identityValue?: number }).identityValue
    expect(parameterIsIdentity(noIdentity, 0)).toBe(false)
  })
})

describe('a triple cannot be mistaken for a curve at the type level', () => {
  // `CurveEditKey` is derived from `EditState[K] extends number[]`. A triple
  // stored as a mutable `number[]` would satisfy that, so colour wheel keys would
  // silently join the curve key union and `withCurve` would accept one and apply
  // curve semantics — sanitising a three-component wheel as interleaved control
  // points, which would reorder it or discard it.
  //
  // A readonly tuple is not assignable to `number[]`, so the derivation excludes
  // it and the mistake is a compile error rather than a runtime surprise. The
  // check is at compile time; the assertion below only makes the failure legible
  // in a test run, since a broken conditional type would fail the build first.
  type Extends<A, B> = A extends B ? true : false
  const tripleIsNotACurve: Extends<readonly [number, number, number], number[]> = false
  const arrayIsACurve: Extends<number[], number[]> = true

  it('excludes a readonly tuple from the curve key derivation', () => {
    expect(tripleIsNotACurve).toBe(false)
    expect(arrayIsACurve).toBe(true)
  })
})
