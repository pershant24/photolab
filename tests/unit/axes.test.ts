import { describe, expect, it } from 'vitest'

import {
  AXIS_PARAMETERS,
  PHOTOGRAPH_PARAMETERS,
  PRESET_AXES,
  allParameterKeys,
  applyAxisPreset,
  applyBundle,
  axisOf,
  isAxisPreset,
  patchViolations,
  resolveBundle,
} from '../../src/core/state/axes'
import type { AxisPreset, Bundle } from '../../src/core/state/axes'
import { AXIS_PRESETS, BUNDLES } from '../../src/core/presets/axisLibrary'
import { DEFAULT_EDIT_STATE, editStatesEqual, mergeEditState } from '../../src/core/state/editState'
import type { EditState } from '../../src/core/state/editState'
import { createEditorStore } from '../../src/core/state/editorStore'
import { borrowedTrademark } from '../support/trademarks'

/**
 * The axis split, and the property that makes it worth having.
 *
 * A collision between two axes is a test failure here rather than one preset
 * silently clobbering part of another at runtime, which is the entire argument
 * for splitting them in the first place.
 *
 * **These assertions are against parameter keys, never against pass stages.**
 * The camera axis does not map to one stage and never will: its lens parameters
 * are in the lens stage, `grainSize` is read by a film-stage pass, and a light
 * leak will inject before the film stage while a border lands after display. An
 * assertion phrased in stages would look correct and check a different thing.
 */

describe('the axes partition the parameters', () => {
  it('never lets two axes claim the same parameter', () => {
    // The property composition rests on. Without it, applying a camera preset
    // after a stock preset would undo part of the stock, and the order of
    // application would become a thing users had to know about.
    for (const a of PRESET_AXES) {
      for (const b of PRESET_AXES) {
        if (a === b) continue
        const shared = AXIS_PARAMETERS[a].filter((key) => AXIS_PARAMETERS[b].includes(key))
        expect(shared, `${a} and ${b} both claim: ${shared.join(', ')}`).toEqual([])
      }
    }
  })

  it('places every parameter in the registry, on an axis or on the photograph', () => {
    // Exhaustive, so a parameter added tomorrow cannot quietly belong nowhere
    // and become impossible to put in a preset. This is the assertion that fails
    // when someone adds a light leak and forgets the table.
    const placed = new Set([...PRESET_AXES.flatMap((a) => AXIS_PARAMETERS[a]), ...PHOTOGRAPH_PARAMETERS])
    const unplaced = allParameterKeys().filter((key) => !placed.has(key))
    expect(unplaced, `not on any axis and not photograph-specific: ${unplaced.join(', ')}`).toEqual(
      [],
    )
  })

  it('claims nothing that is not a real parameter', () => {
    // The other direction. A typo in the table would otherwise sit there
    // claiming a key nothing sets.
    const known = new Set(allParameterKeys())
    for (const axis of PRESET_AXES) {
      for (const key of AXIS_PARAMETERS[axis]) {
        expect(known.has(key), `${axis} claims "${key}", which is not a parameter`).toBe(true)
      }
    }
    for (const key of PHOTOGRAPH_PARAMETERS) {
      expect(known.has(key), `"${key}" is not a parameter`).toBe(true)
    }
  })

  it('keeps the scene measurements off every axis', () => {
    // Exposure and white balance describe the light that was there, not a look.
    // A preset that set them would be making a claim about someone else's
    // photograph, which is the argument `presets.ts` already makes for sparse
    // patches, enforced here rather than left to reviewers.
    for (const key of ['exposure', 'temperature', 'tint']) {
      expect(axisOf(key), `${key} should belong to no axis`).toBeNull()
    }
  })
})

describe('every shipped axis preset stays inside its axis', () => {
  it('ships at least one preset on each axis, so the rest is not vacuous', () => {
    // The assertions below iterate the library. An empty library passes them all
    // while checking nothing, which is the failure mode `tests/README.md` records
    // three instances of.
    for (const axis of PRESET_AXES) {
      const count = AXIS_PRESETS.filter((preset) => preset.axis === axis).length
      expect(count, `no presets on the ${axis} axis`).toBeGreaterThan(0)
    }
  })

  it('touches only parameters its own axis owns', () => {
    for (const preset of AXIS_PRESETS) {
      const violations = patchViolations(preset.axis, preset.patch)
      expect(
        violations,
        `"${preset.name}" is a ${preset.axis} preset but sets: ${violations.join(', ')}`,
      ).toEqual([])
    }
  })

  it('sets something, so no preset is an expensive no-op', () => {
    for (const preset of AXIS_PRESETS) {
      expect(Object.keys(preset.patch).length, `"${preset.name}" is empty`).toBeGreaterThan(0)
    }
  })

  it('has unique ids across the whole library', () => {
    const ids = AXIS_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size, `duplicate ids: ${ids.join(', ')}`).toBe(ids.length)
  })

  it('names nothing after a real film stock or camera maker', () => {
    // Third time this rule has been written down and the first time the
    // repository is public, so it is asserted rather than trusted. Naming a
    // preset after a trademark is a legal problem, not a taste problem.
    // One shared list, in tests/support/trademarks.ts. It lives there because
    // this check was written twice independently and both copies were first
    // written as substring matches and both rejected the word "portrait" for
    // containing a mark.
    for (const preset of [...AXIS_PRESETS, ...BUNDLES]) {
      expect(borrowedTrademark(preset.name), `"${preset.name}" names a trademark`).toBeNull()
      expect(borrowedTrademark(preset.id), `id "${preset.id}" names a trademark`).toBeNull()
    }
  })
})

describe('composition', () => {
  const bundleOf = (...ids: string[]): Bundle => ({
    id: 'test-bundle',
    name: 'test',
    components: ids,
  })
  const oneOf = (axis: (typeof PRESET_AXES)[number]): AxisPreset =>
    AXIS_PRESETS.find((preset) => preset.axis === axis)!

  it('produces the same state whatever order the components are listed in', () => {
    // This is disjointness made observable. It cannot fail while the axes are
    // disjoint, which is exactly why it is worth asserting: if someone widens an
    // axis table and breaks the partition, this is what notices at the point it
    // actually matters rather than in the abstract.
    const camera = oneOf('camera')
    const stock = oneOf('stock')
    const grade = oneOf('grade')
    const orders = [
      [camera.id, stock.id, grade.id],
      [grade.id, camera.id, stock.id],
      [stock.id, grade.id, camera.id],
    ]
    const results = orders.map(
      (ids) => applyBundle(DEFAULT_EDIT_STATE, bundleOf(...ids), AXIS_PRESETS).next,
    )
    for (const state of results) {
      expect(editStatesEqual(state, results[0]!)).toBe(true)
    }
  })

  it('applies each component in full, so nothing is lost to composition', () => {
    const camera = oneOf('camera')
    const stock = oneOf('stock')
    const { next } = applyBundle(DEFAULT_EDIT_STATE, bundleOf(camera.id, stock.id), AXIS_PRESETS)
    const alone = (preset: AxisPreset): EditState => mergeEditState(DEFAULT_EDIT_STATE, preset.patch)
    const record = next as unknown as Record<string, unknown>
    for (const preset of [camera, stock]) {
      const solo = alone(preset) as unknown as Record<string, unknown>
      for (const key of Object.keys(preset.patch)) {
        expect(JSON.stringify(record[key]), `${preset.name} lost ${key} in the bundle`).toBe(
          JSON.stringify(solo[key]),
        )
      }
    }
  })

  it('lets the override win, and lets it cross axes', () => {
    // The one documented exception to the disjointness rule.
    const stock = oneOf('stock')
    const bundle: Bundle = {
      id: 'b',
      name: 'b',
      components: [stock.id],
      override: { filmStrength: 0.11, exposure: 0.25 },
    }
    const { next } = applyBundle(DEFAULT_EDIT_STATE, bundle, AXIS_PRESETS)
    expect(next.filmStrength).toBe(0.11)
    // Exposure is off every axis, and the override is allowed it.
    expect(next.exposure).toBe(0.25)
  })

  it('references its components rather than copying them', () => {
    // The point of A2. Edit a component and the bundle follows; if bundles were
    // flattened at definition time this would return the stale value and nothing
    // would ever say so.
    const stock = oneOf('stock')
    const edited: AxisPreset = { ...stock, patch: { ...stock.patch, filmStrength: 0.42 } }
    const library = AXIS_PRESETS.map((preset) => (preset.id === stock.id ? edited : preset))
    const { next } = applyBundle(DEFAULT_EDIT_STATE, bundleOf(stock.id), library)
    expect(next.filmStrength).toBe(0.42)
  })
})

describe('a bundle whose component has been deleted', () => {
  const stock = AXIS_PRESETS.find((preset) => preset.axis === 'stock')!
  const bundle: Bundle = {
    id: 'b',
    name: 'b',
    components: ['does-not-exist', stock.id],
    override: { contrast: 1.07 },
  }

  it('applies what survives instead of refusing the whole bundle', () => {
    // Two thirds of a look is a useful starting point. A user who deleted a
    // camera preset did not ask for the stock and grade to become unreachable.
    const { next, missing } = applyBundle(DEFAULT_EDIT_STATE, bundle, AXIS_PRESETS)
    expect(missing).toEqual(['does-not-exist'])
    expect(next.filmStrength).toBe(mergeEditState(DEFAULT_EDIT_STATE, stock.patch).filmStrength)
    expect(next.contrast).toBe(1.07)
  })

  it('reports what was missing rather than failing silently', () => {
    const { missing } = resolveBundle(bundle, AXIS_PRESETS)
    expect(missing).toEqual(['does-not-exist'])
  })

  it('keeps the dead reference, so a returning preset reconnects', () => {
    // The rejected alternative was repairing the bundle by dropping the id. That
    // is a permanent decision taken at read time, where the user cannot see it,
    // in exchange for tidiness — and the preset may well come back by import or
    // in a later build.
    expect(bundle.components).toContain('does-not-exist')
    const restored: AxisPreset = { ...stock, id: 'does-not-exist', name: 'restored' }
    const { missing } = resolveBundle(bundle, [...AXIS_PRESETS, restored])
    expect(missing).toEqual([])
  })

  it('treats a preset with no axis as missing rather than applying it blind', () => {
    // A bundle names axis presets. A plain preset with the same id has no axis
    // and no disjointness guarantee, so applying it could clobber a sibling.
    const untagged = { id: 'does-not-exist', name: 'untagged', patch: { contrast: 2 } }
    expect(isAxisPreset(untagged)).toBe(false)
    const { missing, patch } = resolveBundle(bundle, [...AXIS_PRESETS, untagged])
    expect(missing).toEqual(['does-not-exist'])
    expect(patch.contrast).toBe(1.07) // the override, not the untagged preset
  })
})

describe('the shipped bundles', () => {
  it('reference only presets that exist', () => {
    for (const bundle of BUNDLES) {
      const { missing } = resolveBundle(bundle, AXIS_PRESETS)
      expect(missing, `"${bundle.name}" references: ${missing.join(', ')}`).toEqual([])
    }
  })

  it('name at most one preset per axis, since a second would be dead weight', () => {
    // Not a correctness requirement — the later one would simply win — but a
    // bundle listing two stocks is a mistake, and silently applying the second
    // is the worst way to find out.
    for (const bundle of BUNDLES) {
      const { applied } = resolveBundle(bundle, AXIS_PRESETS)
      const axes = applied.map((preset) => preset.axis)
      expect(new Set(axes).size, `"${bundle.name}" lists two presets on one axis`).toBe(axes.length)
    }
  })

  it('changes the picture', () => {
    for (const bundle of BUNDLES) {
      const { next } = applyBundle(DEFAULT_EDIT_STATE, bundle, AXIS_PRESETS)
      expect(editStatesEqual(next, DEFAULT_EDIT_STATE), `"${bundle.name}" is a no-op`).toBe(false)
    }
  })
})

describe('applying a bundle is one undo step', () => {
  it('commits a single history entry however many parameters it moves', () => {
    // A bundle changes parameters across three presets plus an override — the
    // saturated slide combination below moves more than twenty. Committing per
    // parameter would make undo step back through a bundle one field at a time,
    // which is the same failure the drag path already solved by committing on
    // pointer-up rather than per change.
    const store = createEditorStore(DEFAULT_EDIT_STATE)
    const bundle = BUNDLES.find((b) => b.id === 'bundle-saturated-slide')!
    const { patch } = resolveBundle(bundle, AXIS_PRESETS)
    expect(Object.keys(patch).length, 'this bundle should move many parameters').toBeGreaterThan(10)

    store.getState().applyPatch(patch)

    expect(store.getState().past.length, 'more than one history entry').toBe(1)
    expect(editStatesEqual(store.getState().edit, DEFAULT_EDIT_STATE)).toBe(false)

    store.getState().undo()
    expect(
      editStatesEqual(store.getState().edit, DEFAULT_EDIT_STATE),
      'one undo did not return to where it started',
    ).toBe(true)
  })

  it('is one entry for a bundle with a missing component too', () => {
    // The partial application is still one decision from the user's side.
    const store = createEditorStore(DEFAULT_EDIT_STATE)
    const stock = AXIS_PRESETS.find((preset) => preset.axis === 'stock')!
    const { patch, missing } = resolveBundle(
      { id: 'x', name: 'x', components: ['gone', stock.id] },
      AXIS_PRESETS,
    )
    expect(missing).toEqual(['gone'])
    store.getState().applyPatch(patch)
    expect(store.getState().past.length).toBe(1)
    store.getState().undo()
    expect(editStatesEqual(store.getState().edit, DEFAULT_EDIT_STATE)).toBe(true)
  })
})

describe('switching between presets on the same axis', () => {
  /**
   * The hole a sparse patch leaves, and it is a real one.
   *
   * `sanitisePatch` drops any value equal to its default, so a preset cannot
   * say "explicitly the default" — the key vanishes on the way in. That is
   * harmless applying onto a fresh state and wrong the moment anyone switches:
   * if the incoming preset holds no opinion on a parameter the outgoing one
   * set, a merge leaves the outgoing value in place and it survives into a
   * camera that never asked for it.
   *
   * The plastic lens diffuses; the corrected medium format does not mention
   * diffusion at all, because not diffusing is the default. Merge the second
   * over the first and you get a corrected medium format with a plastic lens's
   * haze.
   */
  it('does not leave the previous preset on the axis', () => {
    const plastic = AXIS_PRESETS.find((p) => p.id === 'camera-plastic-lens')!
    const medium = AXIS_PRESETS.find((p) => p.id === 'camera-medium-format')!

    // The setup that makes this a real question rather than a hypothetical.
    expect(plastic.patch.diffusionStrength, 'the plastic lens should diffuse').toBeGreaterThan(0)
    expect(
      'diffusionStrength' in medium.patch,
      'medium format should hold no opinion on diffusion',
    ).toBe(false)

    const after = applyAxisPreset(applyAxisPreset(DEFAULT_EDIT_STATE, plastic), medium)

    expect(after.diffusionStrength, 'the plastic lens diffusion survived the switch').toBe(
      DEFAULT_EDIT_STATE.diffusionStrength,
    )
    // And the incoming preset's own values are of course present.
    expect(after.distortion).toBe(medium.patch.distortion)
    expect(after.vignette).toBe(medium.patch.vignette)
  })

  it('leaves the other two axes alone, which is the point of the split', () => {
    // Resetting an axis must not reset the others, or switching a camera would
    // throw away the stock and grade and composition would be pointless.
    const stock = AXIS_PRESETS.find((p) => p.axis === 'stock')!
    const grade = AXIS_PRESETS.find((p) => p.axis === 'grade')!
    const plastic = AXIS_PRESETS.find((p) => p.id === 'camera-plastic-lens')!
    const medium = AXIS_PRESETS.find((p) => p.id === 'camera-medium-format')!

    let state = applyAxisPreset(DEFAULT_EDIT_STATE, stock)
    state = applyAxisPreset(state, grade)
    state = applyAxisPreset(state, plastic)
    const after = applyAxisPreset(state, medium)

    for (const key of Object.keys(stock.patch)) {
      expect((after as unknown as Record<string, unknown>)[key], `stock lost ${key}`).toEqual(
        (applyAxisPreset(DEFAULT_EDIT_STATE, stock) as unknown as Record<string, unknown>)[key],
      )
    }
    for (const key of Object.keys(grade.patch)) {
      expect((after as unknown as Record<string, unknown>)[key], `grade lost ${key}`).toEqual(
        (applyAxisPreset(DEFAULT_EDIT_STATE, grade) as unknown as Record<string, unknown>)[key],
      )
    }
  })

  it('leaves the photograph alone: exposure and white balance survive any switch', () => {
    // The argument `presets.ts` makes for sparse patches. Resetting an axis must
    // not reach parameters that are on no axis.
    const plastic = AXIS_PRESETS.find((p) => p.id === 'camera-plastic-lens')!
    const medium = AXIS_PRESETS.find((p) => p.id === 'camera-medium-format')!
    const shot = mergeEditState(DEFAULT_EDIT_STATE, {
      exposure: 0.7,
      temperature: 5200,
      tint: 4,
    })
    const after = applyAxisPreset(applyAxisPreset(shot, plastic), medium)
    expect(after.exposure).toBe(0.7)
    expect(after.temperature).toBe(5200)
    expect(after.tint).toBe(4)
  })

  it('does the same for a bundle, on every axis the bundle addresses', () => {
    const toy = BUNDLES.find((b) => b.id === 'bundle-expired-toy')!
    const reportage = BUNDLES.find((b) => b.id === 'bundle-reportage')!
    const first = applyBundle(DEFAULT_EDIT_STATE, toy, AXIS_PRESETS).next
    const second = applyBundle(first, reportage, AXIS_PRESETS).next
    const fresh = applyBundle(DEFAULT_EDIT_STATE, reportage, AXIS_PRESETS).next
    expect(
      editStatesEqual(second, fresh),
      'a bundle applied over another did not produce the same picture as applied fresh',
    ).toBe(true)
  })
})

describe('the axis reset still holds with the new camera parameters', () => {
  /**
   * Re-run of the Part 0 check with two more parameters on the axis, because
   * that fix is only as good as the coverage of what it resets.
   *
   * The plastic lens leaks and the corrected medium format does not mention
   * leaking, because not leaking is the default and a sparse patch drops it.
   * The soft portrait lens says nothing about microcontrast for the same
   * reason — the control cannot subtract acutance, so a soft lens simply adds
   * none.
   */
  const camera = (id: string): AxisPreset => AXIS_PRESETS.find((p) => p.id === id)!

  it('clears a light leak when switching to a camera that does not leak', () => {
    const plastic = camera('camera-plastic-lens')
    const medium = camera('camera-medium-format')
    expect(plastic.patch.lightLeakStrength, 'the plastic lens should leak').toBeGreaterThan(0)
    expect('lightLeakStrength' in medium.patch, 'medium format should not mention leaking').toBe(
      false,
    )

    const after = applyAxisPreset(applyAxisPreset(DEFAULT_EDIT_STATE, plastic), medium)
    expect(after.lightLeakStrength, 'the leak survived into a sealed camera').toBe(0)
    expect(after.lightLeakPosition).toBe(DEFAULT_EDIT_STATE.lightLeakPosition)
  })

  it('clears microcontrast when switching to a lens that adds none', () => {
    const medium = camera('camera-medium-format')
    const soft = camera('camera-soft-portrait-lens')
    expect(medium.patch.microcontrast, 'medium format should be crisp').toBeGreaterThan(0)
    expect('microcontrast' in soft.patch, 'the soft lens should add no acutance').toBe(false)

    const after = applyAxisPreset(applyAxisPreset(DEFAULT_EDIT_STATE, medium), soft)
    expect(after.microcontrast, 'acutance survived onto a deliberately soft lens').toBe(0)
    // And the radius comes back too, which is the case that would otherwise
    // leave a soft lens sharpening at somebody else's radius if it ever did.
    expect(after.microcontrastRadius).toBe(DEFAULT_EDIT_STATE.microcontrastRadius)
  })

  it('still leaves the stock, the grade and the photograph alone', () => {
    const stock = AXIS_PRESETS.find((p) => p.axis === 'stock')!
    const grade = AXIS_PRESETS.find((p) => p.axis === 'grade')!
    const shot = mergeEditState(DEFAULT_EDIT_STATE, { exposure: 0.4, temperature: 5400 })
    let state = applyAxisPreset(applyAxisPreset(shot, stock), grade)
    state = applyAxisPreset(state, camera('camera-plastic-lens'))
    const after = applyAxisPreset(state, camera('camera-medium-format'))
    expect(after.exposure).toBe(0.4)
    expect(after.temperature).toBe(5400)
    expect(after.grainStrength).toBe(
      applyAxisPreset(DEFAULT_EDIT_STATE, stock).grainStrength,
    )
    expect(after.contrast).toBe(applyAxisPreset(DEFAULT_EDIT_STATE, grade).contrast)
  })
})
