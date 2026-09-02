import { describe, expect, it } from 'vitest'

import {
  PRESET_FORMAT,
  PresetFormatError,
  applyPreset,
  isEmptyPatch,
  parsePresets,
  presetFromState,
  presetPatch,
  sanitisePatch,
  serialisePresets,
} from '../../src/core/state/presets'
import { BUILT_IN_PRESETS } from '../../src/core/presets/library'
import {
  DEFAULT_EDIT_STATE,
  PARAMETERS,
  editStatesEqual,
  mergeEditState,
} from '../../src/core/state/editState'
import type { EditState } from '../../src/core/state/editState'

const EDITED: EditState = mergeEditState(DEFAULT_EDIT_STATE, {
  exposure: 0.8,
  temperature: 0.3,
  contrast: 1.2,
  lift: [-0.01, 0, 0.012],
  grainStrength: 0.5,
})

describe('a preset stores only what differs from the default', () => {
  it('is empty for an untouched state', () => {
    expect(isEmptyPatch(presetPatch(DEFAULT_EDIT_STATE))).toBe(true)
  })

  it('carries exactly the parameters that moved', () => {
    expect(Object.keys(presetPatch(EDITED)).sort()).toEqual(
      ['contrast', 'exposure', 'grainStrength', 'lift', 'temperature'].sort(),
    )
  })

  it('does not reset the parameters it does not mention', () => {
    // The whole argument for a sparse preset. Exposure and white balance are
    // decisions about this photograph, not about the look, and a preset that
    // stored the complete state would wipe them on every application.
    const grade = { id: 'g', name: 'Grade', patch: { contrast: 1.4, lift: [0.01, 0, 0] } }
    const applied = applyPreset(EDITED, grade)
    expect(applied.exposure).toBe(EDITED.exposure)
    expect(applied.temperature).toBe(EDITED.temperature)
    expect(applied.contrast).toBe(1.4)
  })

  it('reproduces a state exactly when applied over the default', () => {
    // The cost of sparseness is that a preset is not a complete description of a
    // look — applied to two different edits it gives two different results. The
    // route to exact reproduction is reset-then-apply, and it works precisely
    // because what is stored is a difference from a known state. Asserted, since
    // it is the answer to the objection.
    const preset = presetFromState('x', 'X', EDITED)
    expect(editStatesEqual(applyPreset(DEFAULT_EDIT_STATE, preset), EDITED)).toBe(true)
  })

  it('copies its values rather than sharing them', () => {
    // A preset holding a reference into the state it was captured from would be
    // rewritten by the next edit.
    const preset = presetFromState('x', 'X', EDITED)
    const lift = preset.patch.lift as number[]
    expect(lift).not.toBe(EDITED.lift)
  })
})

describe('an untrusted patch loses only what is wrong with it', () => {
  it('drops keys this build does not know', () => {
    const { patch, dropped } = sanitisePatch({ exposure: 1, saturation: 2, vibrance: 3 })
    expect(Object.keys(patch)).toEqual(['exposure'])
    expect(dropped.sort()).toEqual(['saturation', 'vibrance'])
  })

  it('clamps a value into range rather than rejecting the preset', () => {
    const { patch } = sanitisePatch({ exposure: 9999 })
    const exposure = PARAMETERS.find((p) => p.key === 'exposure')
    expect(patch.exposure).toBe(exposure?.kind === 'scalar' ? exposure.max : undefined)
  })

  it('drops a field whose value cannot be salvaged, and keeps the rest', () => {
    const { patch } = sanitisePatch({ exposure: 0.5, lift: 'not a wheel' })
    expect(patch.exposure).toBe(0.5)
    // `lift` sanitised back to its default, which carries nothing, so it is not
    // stored — a preset should not contain fields that do nothing.
    expect('lift' in patch).toBe(false)
  })

  it('survives anything at all being handed to it', () => {
    for (const junk of [null, undefined, 42, 'text', [], [1, 2], { patch: null }]) {
      expect(() => sanitisePatch(junk)).not.toThrow()
    }
  })
})

describe('the JSON envelope', () => {
  it('round-trips a preset', () => {
    const preset = presetFromState('x', 'A look', EDITED)
    const { presets, dropped } = parsePresets(serialisePresets([preset]))
    expect(dropped).toEqual([])
    expect(presets).toHaveLength(1)
    expect(presets[0]?.name).toBe('A look')
    expect(editStatesEqual(applyPreset(DEFAULT_EDIT_STATE, presets[0]!), EDITED)).toBe(true)
  })

  it('refuses a file that is not one of ours', () => {
    expect(() => parsePresets('not json')).toThrow(PresetFormatError)
    expect(() => parsePresets('{"format":"something-else"}')).toThrow(PresetFormatError)
    expect(() => parsePresets(`{"format":"${PRESET_FORMAT}","version":99,"presets":[]}`)).toThrow(
      /version 99/,
    )
  })

  it('drops a bad preset rather than failing the whole import', () => {
    // One bad entry should cost that entry. An import that refuses everything
    // because of one field is an import nobody can use.
    const file = JSON.stringify({
      format: PRESET_FORMAT,
      version: 1,
      presets: [
        { name: 'Good', patch: { contrast: 1.3 } },
        { name: '', patch: { contrast: 1 } },
        { name: 'Partly good', patch: { contrast: 1.1, nonsense: 5 } },
      ],
    })
    const { presets, dropped } = parsePresets(file)
    expect(presets.map((p) => p.name)).toEqual(['Good', 'Partly good'])
    expect(dropped.some((d) => d.includes('nonsense'))).toBe(true)
  })

  it('cannot smuggle a field into a state through an import', () => {
    const file = JSON.stringify({
      format: PRESET_FORMAT,
      version: 1,
      presets: [{ name: 'Hostile', patch: { __proto__: { polluted: true }, evil: 1, exposure: 1 } }],
    })
    const { presets } = parsePresets(file)
    const applied = applyPreset(DEFAULT_EDIT_STATE, presets[0]!)
    expect(Object.keys(applied).sort()).toEqual(PARAMETERS.map((p) => p.key).sort())
    expect((applied as unknown as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('the presets that ship', () => {
  it('are all applicable and all change something', () => {
    for (const preset of BUILT_IN_PRESETS) {
      expect(isEmptyPatch(preset.patch), `${preset.name} does nothing`).toBe(false)
      const applied = applyPreset(DEFAULT_EDIT_STATE, preset)
      expect(editStatesEqual(applied, DEFAULT_EDIT_STATE), `${preset.name}`).toBe(false)
    }
  })

  it('leave exposure and white balance to the photograph', () => {
    // A look is not a decision about how much light there was.
    for (const preset of BUILT_IN_PRESETS) {
      for (const key of ['exposure', 'temperature', 'tint'] as const) {
        expect(key in preset.patch, `${preset.name} sets ${key}`).toBe(false)
      }
    }
  })

  it('contain only values this build accepts, unchanged', () => {
    // A shipped preset that needed clamping would be a shipped preset with a
    // typo in it.
    for (const preset of BUILT_IN_PRESETS) {
      const { patch, dropped } = sanitisePatch(preset.patch)
      expect(dropped, `${preset.name}`).toEqual([])
      expect(Object.keys(patch).sort(), `${preset.name}`).toEqual(
        Object.keys(preset.patch).sort(),
      )
    }
  })

  it('borrow no trademark, by whole word', () => {
    // Word boundaries, not substrings: an earlier version of this check flagged
    // "warm portrait" for containing "portra".
    const RESERVED = ['portra', 'velvia', 'provia', 'ektar', 'tri-x', 'kodak', 'fuji', 'ilford', 'cinestill']
    for (const preset of BUILT_IN_PRESETS) {
      for (const word of preset.name.toLowerCase().split(/[^a-z-]+/)) {
        expect(RESERVED, `${preset.name} borrows "${word}"`).not.toContain(word)
      }
    }
  })

  it('has a stable id for every one, so a saved choice survives an update', () => {
    const ids = BUILT_IN_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.startsWith('builtin-')).toBe(true)
  })
})
