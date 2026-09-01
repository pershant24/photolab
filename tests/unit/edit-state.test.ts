import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EDIT_STATE,
  CURVE_PARAMETERS,
  EDIT_PARAMETERS,
  clampParameter,
  isIdentityCurve,
  editStatesEqual,
  mergeEditState,
  parameterDescriptor,
  withParameter,
} from '../../src/core/state/editState'
import type { EditState } from '../../src/core/state/editState'

describe('EditState', () => {
  it('survives a JSON round trip unchanged', () => {
    // Undo is an array of snapshots and persistence is a structured clone, so
    // anything that does not survive this breaks both — and breaks them quietly,
    // returning null or dropping the key rather than throwing.
    const state: EditState = { ...DEFAULT_EDIT_STATE, exposure: -1.25, contrast: 1.4 }
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    expect(JSON.parse(JSON.stringify(DEFAULT_EDIT_STATE))).toEqual(DEFAULT_EDIT_STATE)
  })

  it('holds only plain serialisable values', () => {
    // Stated as a property over the object rather than as a list, so a field
    // added later is covered without anyone remembering to extend this.
    for (const [key, value] of Object.entries(DEFAULT_EDIT_STATE)) {
      const kind = typeof value
      const plain =
        kind === 'number' ||
        kind === 'string' ||
        kind === 'boolean' ||
        (Array.isArray(value) &&
          (value as unknown[]).every((v) => ['number', 'string', 'boolean'].includes(typeof v)))
      expect(plain, `${key} is ${kind}, which does not survive a JSON round trip`).toBe(true)
      expect(value).not.toBeUndefined()
    }
  })

  it('has a descriptor for every field, and a field for every descriptor', () => {
    // The defaults are written out so the type checker verifies coverage, and
    // the table is written out so the interface has ranges. This is the check
    // that the two independent statements agree.
    // The union of both tables, because there are two kinds of parameter and
    // they are deliberately kept in separate tables rather than one with a type
    // discriminant. This is the assertion that stops a third kind being added
    // without a table: a field with no descriptor has no interface, no
    // validation and no place in a preset merge.
    const fields = Object.keys(DEFAULT_EDIT_STATE).sort()
    const described = [
      ...EDIT_PARAMETERS.map((p) => p.key as string),
      ...CURVE_PARAMETERS.map((p) => p.key as string),
    ].sort()
    expect(described).toEqual(fields)
  })

  it('has defaults that match the parameter table', () => {
    for (const parameter of EDIT_PARAMETERS) {
      expect(DEFAULT_EDIT_STATE[parameter.key], `${parameter.key} default`).toBe(
        parameter.defaultValue,
      )
    }
    // Curves too, and this one has already caught a real drift: the descriptor's
    // domain moved to start at black in ACEScct while the default state kept
    // control points at zero. The two disagreed, so the identity check never
    // matched and the curve pass ran on every unedited photograph.
    for (const curve of CURVE_PARAMETERS) {
      expect(DEFAULT_EDIT_STATE[curve.key], `${curve.key} default`).toEqual([
        ...curve.defaultValue,
      ])
      expect(
        isIdentityCurve(curve.key, DEFAULT_EDIT_STATE[curve.key]),
        `${curve.key} default must be the identity, or its pass runs unasked`,
      ).toBe(true)
    }
  })

  it('has a default inside its own range for every parameter', () => {
    for (const parameter of EDIT_PARAMETERS) {
      expect(parameter.min).toBeLessThan(parameter.max)
      expect(parameter.defaultValue).toBeGreaterThanOrEqual(parameter.min)
      expect(parameter.defaultValue).toBeLessThanOrEqual(parameter.max)
      expect(parameter.step).toBeGreaterThan(0)
    }
  })

  it('describes the identity edit, for the parameters that have one', () => {
    // Zero stops is no change and a contrast slope of 1 is no change. A default
    // that altered the photograph would mean opening a file already graded.
    expect(DEFAULT_EDIT_STATE.exposure).toBe(0)
    expect(DEFAULT_EDIT_STATE.contrast).toBe(1)

    // The roll-off knee has no identity value, and that is not an oversight: any
    // operator that is the identity below a knee and compressing above it maps
    // everything between the knee and 1.0 below itself, so there is no setting
    // that both preserves white and rolls off above it. The default is a
    // position on that trade rather than a no-op.
    expect(DEFAULT_EDIT_STATE.toneMapKnee).toBeGreaterThan(0.18)
  })
})

describe('parameter validation', () => {
  it('clamps to the declared range', () => {
    expect(clampParameter('exposure', 99)).toBe(parameterDescriptor('exposure').max)
    expect(clampParameter('exposure', -99)).toBe(parameterDescriptor('exposure').min)
    expect(clampParameter('contrast', -1)).toBe(parameterDescriptor('contrast').min)
  })

  it('replaces a non-finite value with the default rather than passing it on', () => {
    // NaN is the case that matters and the one that does not announce itself: it
    // is neither greater nor less than a bound, so an unchecked comparison lets
    // it through, and it reaches the shader as undefined output over part of the
    // frame. An empty number input produces one.
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(clampParameter('exposure', bad)).toBe(DEFAULT_EDIT_STATE.exposure)
      expect(clampParameter('contrast', bad)).toBe(DEFAULT_EDIT_STATE.contrast)
    }
  })

  it('does not snap to the step', () => {
    // Step is slider granularity. A preset or a typed value may sit between.
    expect(clampParameter('exposure', 0.005)).toBe(0.005)
  })

  it('leaves an in-range value exactly alone', () => {
    for (const value of [-4.999, -1, 0, 0.333, 4.999]) {
      expect(clampParameter('exposure', value)).toBe(value)
    }
  })
})

describe('merging a preset', () => {
  it('applies only the keys the patch carries', () => {
    const base: EditState = { ...DEFAULT_EDIT_STATE, exposure: 1, contrast: 1.5 }
    expect(mergeEditState(base, { exposure: -2 })).toEqual({ ...DEFAULT_EDIT_STATE, exposure: -2, contrast: 1.5 })
    expect(mergeEditState(base, {})).toEqual(base)
  })

  it('validates the patch rather than trusting it', () => {
    // A preset from disk is untrusted input and reaches the shader if nothing
    // checks it.
    const base: EditState = { ...DEFAULT_EDIT_STATE, exposure: 0, contrast: 1 }
    expect(mergeEditState(base, { exposure: 1000 }).exposure).toBe(
      parameterDescriptor('exposure').max,
    )
    expect(mergeEditState(base, { contrast: Number.NaN }).contrast).toBe(1)
  })

  it('drops keys that are not parameters', () => {
    // A preset written against a later version must not smuggle a field into a
    // state that is then snapshotted into undo history.
    const base: EditState = { ...DEFAULT_EDIT_STATE, exposure: 0, contrast: 1 }
    const merged = mergeEditState(base, { saturation: 2 } as unknown as Partial<EditState>)
    // Against the parameter table rather than a hardcoded list, so adding a
    // parameter does not need this test edited — which is the property the flat
    // shape exists to give.
    expect(Object.keys(merged).sort()).toEqual(
      [
        ...EDIT_PARAMETERS.map((p) => p.key as string),
        ...CURVE_PARAMETERS.map((p) => p.key as string),
      ].sort(),
    )
  })
})

describe('withParameter', () => {
  it('changes one field and validates it', () => {
    const base: EditState = { ...DEFAULT_EDIT_STATE, exposure: 0, contrast: 1 }
    expect(withParameter(base, 'exposure', 2)).toEqual({ ...DEFAULT_EDIT_STATE, exposure: 2, contrast: 1 })
    expect(withParameter(base, 'exposure', 99).exposure).toBe(parameterDescriptor('exposure').max)
  })

  it('does not mutate its argument', () => {
    // Snapshots in history are shared by reference; mutating one would rewrite
    // the past.
    const base: EditState = { ...DEFAULT_EDIT_STATE, exposure: 0, contrast: 1 }
    withParameter(base, 'exposure', 3)
    expect(base.exposure).toBe(0)
  })
})

describe('editStatesEqual', () => {
  it('compares every parameter', () => {
    expect(editStatesEqual({ ...DEFAULT_EDIT_STATE, exposure: 1, contrast: 1 }, { ...DEFAULT_EDIT_STATE, exposure: 1, contrast: 1 })).toBe(true)
    expect(editStatesEqual({ ...DEFAULT_EDIT_STATE, exposure: 1, contrast: 1 }, { ...DEFAULT_EDIT_STATE, exposure: 1, contrast: 1.1 })).toBe(false)
    expect(editStatesEqual({ ...DEFAULT_EDIT_STATE, exposure: 1, contrast: 1 }, { ...DEFAULT_EDIT_STATE, exposure: 1.1, contrast: 1 })).toBe(false)
  })
})
