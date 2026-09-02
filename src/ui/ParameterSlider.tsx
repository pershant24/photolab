/**
 * One parameter, one slider.
 *
 * ## Bracketing the gesture, for the pointer *and* the keyboard
 *
 * The store coalesces a drag into one undo entry by being told when a gesture
 * starts and ends. Wiring that to `pointerdown`/`pointerup` alone is the obvious
 * thing and it is half a solution: a focused range input is also driven by the
 * arrow keys, and holding an arrow emits a change per key repeat with no pointer
 * event anywhere. Every repeat would become its own undo entry, so holding Left
 * for a second would leave thirty entries to step back through — the exact
 * failure the coalescing exists to prevent, arriving through the other input
 * method.
 *
 * So a gesture is bracketed by whichever device started it:
 *
 * - `pointerdown` … `pointerup` (listened for on the window, because the pointer
 *   is released wherever the user happens to have dragged to, which is often
 *   outside the element).
 * - `keydown` … `keyup`. Key *repeat* fires `keydown` over and over and `keyup`
 *   exactly once, so a held arrow is one gesture and one entry.
 * - `blur` ends any gesture still open, so a control that loses focus mid-drag
 *   cannot leave the store believing a gesture is in progress — which would
 *   suppress history and keep the drag proxy engaged indefinitely.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useStore } from 'zustand'

import { editorStore } from '../core/state/editorStore'
import type { ScalarParameter } from '../core/state/editState'

/** Keys a range input responds to by changing its value. */
const VALUE_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

export function ParameterSlider({ descriptor }: { descriptor: ScalarParameter }) {
  const value = useStore(editorStore, (state) => state.edit[descriptor.key])
  const gestureOpen = useRef(false)

  const begin = useCallback(() => {
    if (gestureOpen.current) return
    gestureOpen.current = true
    editorStore.getState().beginInteraction()
  }, [])

  const end = useCallback(() => {
    if (!gestureOpen.current) return
    gestureOpen.current = false
    editorStore.getState().endInteraction()
  }, [])

  // The pointer is released wherever it ends up, which is usually not over the
  // slider. Listening on the window is the only way to see it.
  useEffect(() => {
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [end])

  const formatted =
    descriptor.key === 'exposure' && value > 0
      ? `+${value.toFixed(2)}`
      : value.toFixed(2)

  return (
    <label className="block px-4 py-3 text-xs">
      <span className="flex items-baseline justify-between">
        <span className="text-ink">{descriptor.label}</span>
        <span className="tabular-nums text-ink-dim">
          {formatted}
          {descriptor.unit ? ` ${descriptor.unit}` : ''}
        </span>
      </span>

      <input
        type="range"
        className="mt-2 w-full"
        data-testid={`slider-${descriptor.key}`}
        min={descriptor.min}
        max={descriptor.max}
        step={descriptor.step}
        value={value}
        onPointerDown={begin}
        onKeyDown={(event) => {
          if (VALUE_KEYS.has(event.key)) begin()
        }}
        onKeyUp={end}
        onBlur={end}
        onChange={(event) => {
          editorStore.getState().setParameter(descriptor.key, event.target.valueAsNumber)
        }}
        onDoubleClick={() => {
          // Double click resets to the default, which is the one gesture every
          // slider in every editor has.
          editorStore.getState().setParameter(descriptor.key, descriptor.defaultValue)
        }}
      />
    </label>
  )
}
