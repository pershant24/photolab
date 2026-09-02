/**
 * A fixed-length vector, drawn as one labelled slider per component.
 *
 * Deliberately not a colour wheel widget. A wheel is a two-dimensional control
 * over hue and magnitude that then has to be decomposed into three offsets, and
 * building one is a day of interaction work that would tell us nothing about the
 * pipeline. Three sliders address the same parameter exactly and can be read off
 * precisely, which is what the look sessions need.
 *
 * Gestures go through `beginInteraction` / `endInteraction`, so a drag is one
 * undo entry and engages the drag proxy, exactly as the scalar sliders do.
 */

import { useStore } from 'zustand'

import { withValue } from '../core/state/editState'
import type { VectorParameter } from '../core/state/editState'
import { editorStore } from '../core/state/editorStore'

export function VectorControl({ descriptor }: { descriptor: VectorParameter }) {
  const value = useStore(editorStore, (state) => state.edit[descriptor.key])

  const setComponent = (index: number, next: number): void => {
    const updated = [...value]
    updated[index] = next
    editorStore.setState((state) => ({ edit: withValue(state.edit, descriptor.key, updated) }))
  }

  return (
    <div className="border-b border-hairline px-4 py-3" data-testid={`vector-${descriptor.key}`}>
      <div className="mb-1.5 flex items-baseline justify-between text-xs">
        <span className="text-ink">{descriptor.label}</span>
        <button
          type="button"
          data-testid={`reset-${descriptor.key}`}
          onClick={() =>
            editorStore
              .getState()
              .applyPatch({ [descriptor.key]: [...descriptor.identityValue] })
          }
          className="text-ink-dim hover:text-ink"
        >
          Reset
        </button>
      </div>
      {descriptor.components.map((component, index) => (
        <label key={component} className="flex items-center gap-2 py-0.5 text-xs">
          <span className="w-10 shrink-0 text-ink-dim">{component}</span>
          <input
            type="range"
            className="min-w-0 flex-1"
            data-testid={`${descriptor.key}-${index}`}
            min={descriptor.min}
            max={descriptor.max}
            step={descriptor.step}
            value={value[index] ?? 0}
            onPointerDown={() => editorStore.getState().beginInteraction()}
            onPointerUp={() => editorStore.getState().endInteraction()}
            onChange={(event) => setComponent(index, Number(event.target.value))}
          />
          <span className="w-12 shrink-0 text-right tabular-nums text-ink-dim">
            {(value[index] ?? 0).toFixed(3)}
          </span>
        </label>
      ))}
    </div>
  )
}
