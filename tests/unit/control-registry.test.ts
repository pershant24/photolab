import { describe, expect, it } from 'vitest'

import { CONTROLLED_KINDS } from '../../src/ui/controls/registry'
import { REGISTERED_KINDS } from '../../src/core/state/parameterKinds'
import { PARAMETERS } from '../../src/core/state/editState'

/**
 * The two halves of the registry are keyed by the same string, and this is what
 * holds them together.
 *
 * `parameterKinds.ts` says how a kind behaves; `ui/controls/registry.tsx` says
 * what it looks like. They are separate modules because the core must not import
 * React, and separate modules drift. Without this, adding a kind and forgetting
 * its control produces a panel row that silently renders nothing — which looks
 * like a layout bug and is a registration bug.
 */
describe('every parameter kind can be both stored and drawn', () => {
  it('has a control for every kind a visible parameter declares', () => {
    const visible = PARAMETERS.filter((descriptor) => !descriptor.hidden)
    const needed = [...new Set(visible.map((descriptor) => descriptor.kind))].sort()
    for (const kind of needed) {
      expect(CONTROLLED_KINDS, `kind "${kind}" has no control`).toContain(kind)
    }
  })

  it('has no control for a kind the core does not know about', () => {
    // The other direction. A control for an unregistered kind is dead code that
    // looks like a feature.
    for (const kind of CONTROLLED_KINDS) {
      expect(REGISTERED_KINDS, `control "${kind}" has no registered behaviour`).toContain(kind)
    }
  })

  it('surfaces every parameter that is not deliberately hidden', () => {
    // A parameter with no control and no `hidden` flag is unreachable in the
    // interface, which is a different failure from an unregistered kind and just
    // as quiet.
    const hidden = PARAMETERS.filter((descriptor) => descriptor.hidden).map((d) => d.key)
    // The three film curves are driven by picking a stock, deliberately.
    expect(hidden.sort()).toEqual(['filmCurveBlue', 'filmCurveGreen', 'filmCurveRed'])
  })
})
