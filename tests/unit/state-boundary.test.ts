import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EDIT_STATE,
  PARAMETERS,
  editStatesEqual,
  mergeEditState,
} from '../../src/core/state/editState'
import { DEFAULT_VIEW_STATE } from '../../src/render/passes/types'
import { imageKey } from '../../src/core/state/sessionStore'
import { presetPatch, sanitisePatch } from '../../src/core/state/presets'
import { defaultParameter, parametersEqual } from '../../src/core/state/parameterKinds'
import type { ParameterValue } from '../../src/core/state/parameterKinds'

/**
 * The `EditState` / `ViewState` boundary, five stages on.
 *
 * The split was drawn at Stage 4 and has since accumulated parameters across the
 * scene, lens, film, grade and display stages. It is exactly the sort of line
 * that stays correct while anyone remembers why it is there and then quietly
 * stops, because adding a parameter to the wrong side is one line and nothing
 * complains.
 *
 * The rule: `EditState` is what the photograph is, and it must be flat,
 * serialisable, snapshot-able for undo and carryable in a preset. `ViewState` is
 * how you are looking at it — debug display modes, the inspector's position —
 * and belongs to the session rather than to the picture.
 *
 * Driven from the registry rather than a hand-maintained list, so a parameter
 * added tomorrow is covered without anyone remembering to extend this.
 */

const editRecord = DEFAULT_EDIT_STATE as unknown as Record<string, ParameterValue>

describe('everything in EditState survives a round trip to disk', () => {
  it('serialises and comes back identical, for every parameter', () => {
    // Not "for these fields": for whatever the table says the fields are.
    const edited: Record<string, ParameterValue> = {}
    for (const descriptor of PARAMETERS) {
      const current = editRecord[descriptor.key]
      if (current === undefined) continue
      // Move each parameter away from its default, so the round trip is carrying
      // something. A state that is all defaults round-trips trivially.
      if (typeof current === 'number') {
        const span = descriptor.kind === 'scalar' ? descriptor.max - descriptor.min : 1
        edited[descriptor.key] = current + span * 0.123
      } else if (descriptor.kind === 'vector') {
        edited[descriptor.key] = current.map((v, i) => v + (i + 1) * 0.011)
      } else {
        edited[descriptor.key] = [...current]
      }
    }
    const state = mergeEditState(DEFAULT_EDIT_STATE, edited)

    const revived = mergeEditState(
      DEFAULT_EDIT_STATE,
      JSON.parse(JSON.stringify(presetPatch(state))) as never,
    )
    expect(editStatesEqual(revived, state)).toBe(true)
  })

  it('has no field JSON cannot carry', () => {
    // Undefined, functions, and anything with a prototype are the ways a flat
    // state stops being flat. `JSON.stringify` drops them silently, so the
    // failure is a field that quietly stops persisting rather than an error.
    const text = JSON.stringify(DEFAULT_EDIT_STATE)
    const revived = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(revived).sort()).toEqual(PARAMETERS.map((p) => p.key).sort())
    for (const descriptor of PARAMETERS) {
      const value = revived[descriptor.key]
      expect(value, `${descriptor.key} did not survive`).toBeDefined()
      expect(typeof value === 'number' || Array.isArray(value)).toBe(true)
    }
  })

  it('round-trips every parameter at both ends of its range', () => {
    // Extremes are where a serialiser goes wrong: a range crossing zero, a value
    // that stringifies in exponential notation, a negative zero.
    for (const descriptor of PARAMETERS) {
      if (descriptor.kind !== 'scalar') continue
      for (const value of [descriptor.min, descriptor.max, 0, -0]) {
        const patch = { [descriptor.key]: value } as never
        const state = mergeEditState(DEFAULT_EDIT_STATE, patch)
        const revived = mergeEditState(
          DEFAULT_EDIT_STATE,
          JSON.parse(JSON.stringify(presetPatch(state))) as never,
        )
        expect(
          editStatesEqual(revived, state),
          `${descriptor.key} at ${value} did not survive`,
        ).toBe(true)
      }
    }
  })
})

describe('nothing from ViewState has leaked into EditState', () => {
  it('shares no key with the viewing settings', () => {
    // The direction that matters. A viewing setting that drifted into the edit
    // would be snapshotted into undo, carried in a preset, and written to disk
    // per image — so toggling a debug display mode would become an undoable
    // change to the photograph.
    const viewKeys = new Set(Object.keys(DEFAULT_VIEW_STATE))
    const shared = PARAMETERS.map((p) => p.key).filter((key) => viewKeys.has(key))
    expect(shared, `these belong to ViewState: ${shared.join(', ')}`).toEqual([])
  })

  it('keeps the display debug switches out of the edit entirely', () => {
    // Named explicitly as well as covered by the set difference above, because
    // these are the three with a real pull toward `EditState` — they change the
    // picture on screen, which is what makes them look like edits.
    for (const key of ['displayMode', 'toneMap', 'gamutCompress', 'inspect', 'inspectCentre']) {
      expect(key in DEFAULT_EDIT_STATE, `${key} is in EditState`).toBe(false)
    }
  })

  it('refuses a viewing setting offered as a preset', () => {
    // The path a leak would actually take: a preset file, or a stored session
    // edit, carrying a view key. It must be dropped rather than merged.
    const { patch, dropped } = sanitisePatch({
      exposure: 0.5,
      displayMode: 'identity',
      toneMap: false,
      inspect: true,
    })
    expect(Object.keys(patch)).toEqual(['exposure'])
    expect(dropped.sort()).toEqual(['displayMode', 'inspect', 'toneMap'])
  })

  it('keeps the roll-off knee on the edit side, deliberately', () => {
    // The one that moved. It is a choice about the photograph — how its
    // highlights behave — rather than about how it is being viewed, so it lives
    // in `EditState` and belongs in undo and in presets. The gamut threshold
    // beside it did not move, and that asymmetry is the boundary being drawn
    // rather than defaulted.
    expect('toneMapKnee' in DEFAULT_EDIT_STATE).toBe(true)
    expect('gamutThreshold' in DEFAULT_VIEW_STATE).toBe(true)
    expect('gamutThreshold' in DEFAULT_EDIT_STATE).toBe(false)
  })
})

describe('a stored session edit', () => {
  it('identifies an image by name, size and modification time', () => {
    const a = imageKey({ name: 'IMG_1.jpg', size: 1234, lastModified: 99 })
    expect(a).toBe('IMG_1.jpg:1234:99')
    // Different in any component is a different image.
    expect(imageKey({ name: 'IMG_1.jpg', size: 1234, lastModified: 100 })).not.toBe(a)
    expect(imageKey({ name: 'IMG_2.jpg', size: 1234, lastModified: 99 })).not.toBe(a)
    expect(imageKey({ name: 'IMG_1.jpg', size: 1235, lastModified: 99 })).not.toBe(a)
  })

  it('stores only what differs, so an older record does not pin new fields', () => {
    // The same argument as presets. A record written before a parameter existed
    // should let this build's default supply it rather than having a value
    // invented for it.
    const state = mergeEditState(DEFAULT_EDIT_STATE, { exposure: 0.7 })
    const patch = presetPatch(state)
    expect(Object.keys(patch)).toEqual(['exposure'])
  })

  it('restores nothing at all from an unedited photograph', () => {
    // A record with an empty patch takes a slot and restores nothing.
    expect(Object.keys(presetPatch(DEFAULT_EDIT_STATE))).toEqual([])
  })

  it('survives a record written against parameters this build lacks', () => {
    const { patch, dropped } = sanitisePatch({
      exposure: 0.4,
      filmHalide: 'silver',
      lensBreathing: 3,
    })
    const restored = mergeEditState(DEFAULT_EDIT_STATE, patch)
    expect(dropped.sort()).toEqual(['filmHalide', 'lensBreathing'])
    expect(restored.exposure).toBe(0.4)
    // Everything else is this build's default, not something invented.
    for (const descriptor of PARAMETERS) {
      if (descriptor.key === 'exposure') continue
      const value = (restored as unknown as Record<string, ParameterValue>)[descriptor.key]
      expect(
        parametersEqual(descriptor, value ?? 0, defaultParameter(descriptor)),
        `${descriptor.key} was not left at its default`,
      ).toBe(true)
    }
  })
})
