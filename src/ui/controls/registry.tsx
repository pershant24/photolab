/**
 * Which control renders which kind of parameter.
 *
 * The presentation half of the parameter registry. `parameterKinds.ts` owns how a
 * kind validates, snapshots, compares and merges; this owns what it looks like,
 * and the two are keyed by the same `kind` string.
 *
 * Split in two rather than kept in one table because the core must not import
 * React. A `Partial<EditState>` is loaded and validated by code that never draws
 * anything — the preset importer, the undo stack, the render graph — and pulling
 * a component tree into that path would be the wrong dependency for the sake of
 * one table.
 *
 * The pairing is not left to trust: `tests/render/ui.spec.ts` asserts that every
 * registered kind has a control here, so adding a kind without one fails rather
 * than silently rendering an empty panel row.
 */

import type { JSX } from 'react'

import type { CurveParameter, ScalarParameter } from '../../core/state/editState'
import type { ParameterDescriptor } from '../../core/state/parameterKinds'
import { CurveEditor } from '../CurveEditor'
import { ParameterSlider } from '../ParameterSlider'

/** Every kind this build can draw. Keyed by the same string the core registry uses. */
const CONTROLS: Record<string, (descriptor: ParameterDescriptor) => JSX.Element | null> = {
  scalar: (descriptor) => <ParameterSlider descriptor={descriptor as ScalarParameter} />,
  curve: (descriptor) => <CurveEditor descriptor={descriptor as CurveParameter} />,
}

/** The kinds with a control, for the coverage assertion. */
export const CONTROLLED_KINDS: readonly string[] = Object.keys(CONTROLS)

/**
 * Render the control for a parameter, or nothing if it is not surfaced.
 *
 * A missing control is a hole in the interface rather than a crash: the panel
 * renders without that row and the coverage test says which kind is missing.
 */
export function ParameterControl({ descriptor }: { descriptor: ParameterDescriptor }) {
  if (descriptor.hidden) return null
  const render = CONTROLS[descriptor.kind]
  return render ? render(descriptor) : null
}
