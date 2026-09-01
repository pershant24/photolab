import { describe, expect, it } from 'vitest'

import { DEFAULT_EDIT_STATE, editStatesEqual } from '../../src/core/state/editState'
import type { EditState } from '../../src/core/state/editState'
import { HISTORY_LIMIT, createEditorStore } from '../../src/core/state/editorStore'
import type { EditorStore } from '../../src/core/state/editorStore'

/** A store per test: a module-level singleton would leak history between them. */
function store(initial?: EditState): EditorStore {
  return initial ? createEditorStore(initial) : createEditorStore()
}

/** One drag: press, some number of moves, release. */
function drag(s: EditorStore, values: readonly number[], key: 'exposure' | 'contrast' = 'exposure') {
  s.getState().beginInteraction()
  for (const value of values) s.getState().setParameter(key, value)
  s.getState().endInteraction()
}

describe('editing', () => {
  it('starts from the default state with no history', () => {
    const s = store()
    expect(s.getState().edit).toEqual(DEFAULT_EDIT_STATE)
    expect(s.getState().past).toEqual([])
    expect(s.getState().future).toEqual([])
  })

  it('validates values on the way in', () => {
    const s = store()
    s.getState().setParameter('exposure', 1000)
    expect(s.getState().edit.exposure).toBe(5)
    s.getState().setParameter('contrast', Number.NaN)
    expect(Number.isFinite(s.getState().edit.contrast)).toBe(true)
  })

  it('ignores a change that does not change anything', () => {
    const s = store()
    s.getState().setParameter('exposure', 0)
    expect(s.getState().past).toEqual([])
  })
})

describe('a drag is one history entry', () => {
  it('records one entry for sixty state changes', () => {
    // The assertion this whole design exists for. A drag emits changes at frame
    // rate; one entry each would make undo step back through the drag a frame at
    // a time, and it gets worse the longer the drag.
    const s = store()
    const frames = Array.from({ length: 60 }, (_, i) => -3 + (6 * i) / 60)
    drag(s, frames)

    expect(s.getState().past).toHaveLength(1)
    expect(s.getState().edit.exposure).toBeCloseTo(frames[59] ?? Number.NaN, 12)
  })

  it('returns to the state before the drag, not to a frame inside it', () => {
    const s = store({ exposure: -1, contrast: 1 })
    drag(s, [0, 0.5, 1, 1.5, 2])
    s.getState().undo()
    expect(s.getState().edit.exposure).toBe(-1)
  })

  it('records nothing for a click that does not move', () => {
    // Pressing a slider and releasing without moving is not an undoable event.
    // Treating it as one fills the stack with entries that appear to do nothing.
    const s = store()
    s.getState().beginInteraction()
    s.getState().endInteraction()
    expect(s.getState().past).toEqual([])
  })

  it('records nothing for a drag that ends where it began', () => {
    const s = store({ exposure: 1, contrast: 1 })
    drag(s, [2, 3, 2, 1])
    expect(s.getState().past).toEqual([])
    expect(s.getState().edit.exposure).toBe(1)
  })

  it('commits immediately when there is no interaction', () => {
    // A keyboard nudge or a typed value is already one discrete action.
    const s = store()
    s.getState().setParameter('exposure', 1)
    s.getState().setParameter('exposure', 2)
    expect(s.getState().past).toHaveLength(2)
  })

  it('treats a second begin as part of the same gesture', () => {
    // Overwriting the baseline would make undo return to the middle of a drag.
    const s = store({ exposure: 0, contrast: 1 })
    s.getState().beginInteraction()
    s.getState().setParameter('exposure', 1)
    s.getState().beginInteraction()
    s.getState().setParameter('exposure', 2)
    s.getState().endInteraction()

    expect(s.getState().past).toHaveLength(1)
    s.getState().undo()
    expect(s.getState().edit.exposure).toBe(0)
  })

  it('ignores an end without a begin', () => {
    const s = store()
    s.getState().setParameter('exposure', 1)
    const before = s.getState().past.length
    s.getState().endInteraction()
    expect(s.getState().past).toHaveLength(before)
  })

  it('separates consecutive drags', () => {
    const s = store()
    drag(s, [1, 2])
    drag(s, [3, 4])
    expect(s.getState().past).toHaveLength(2)
    s.getState().undo()
    expect(s.getState().edit.exposure).toBe(2)
    s.getState().undo()
    expect(s.getState().edit.exposure).toBe(0)
  })
})

describe('undo and redo', () => {
  it('steps back and forward through discrete changes', () => {
    const s = store()
    s.getState().setParameter('exposure', 1)
    s.getState().setParameter('exposure', 2)

    s.getState().undo()
    expect(s.getState().edit.exposure).toBe(1)
    s.getState().undo()
    expect(s.getState().edit.exposure).toBe(0)
    s.getState().redo()
    expect(s.getState().edit.exposure).toBe(1)
    s.getState().redo()
    expect(s.getState().edit.exposure).toBe(2)
  })

  it('does nothing at either end of the history', () => {
    const s = store()
    s.getState().undo()
    s.getState().redo()
    expect(s.getState().edit).toEqual(DEFAULT_EDIT_STATE)
    expect(s.getState().past).toEqual([])
    expect(s.getState().future).toEqual([])
  })

  it('abandons the redo branch on a new change', () => {
    const s = store()
    s.getState().setParameter('exposure', 1)
    s.getState().setParameter('exposure', 2)
    s.getState().undo()
    s.getState().setParameter('exposure', 3)

    expect(s.getState().future).toEqual([])
    s.getState().redo()
    expect(s.getState().edit.exposure).toBe(3)
  })

  it('abandons the redo branch as soon as a drag starts moving', () => {
    // Not at pointer-up. A redo that survived halfway through a drag would jump
    // the image to an unrelated state on release.
    const s = store()
    s.getState().setParameter('exposure', 1)
    s.getState().undo()
    expect(s.getState().future).toHaveLength(1)

    s.getState().beginInteraction()
    s.getState().setParameter('exposure', 2)
    expect(s.getState().future).toEqual([])
  })

  it('cancels an in-flight drag rather than stepping past it', () => {
    // Undo mid-drag. Popping history here would jump the value from wherever the
    // pointer is to two states back, losing the position the drag started from
    // with no way to return to it — that position was never committed, so it is
    // not in the history to step back to.
    const s = store()
    s.getState().setParameter('exposure', 1)
    s.getState().beginInteraction()
    s.getState().setParameter('exposure', 4)

    s.getState().undo()
    expect(s.getState().edit.exposure, 'returns to where the drag began').toBe(1)
    expect(s.getState().past, 'history is untouched').toHaveLength(1)

    // The eventual pointer-up must not commit the abandoned baseline.
    s.getState().endInteraction()
    expect(s.getState().edit.exposure).toBe(1)
    expect(s.getState().past).toHaveLength(1)

    // A second undo then steps back normally.
    s.getState().undo()
    expect(s.getState().edit.exposure).toBe(0)
  })

  it('ignores a redo while a drag is in flight', () => {
    // The drag cleared the redo branch when it first moved, so there is nothing
    // coherent to redo; guessing would jump the image mid-gesture.
    const s = store()
    s.getState().setParameter('exposure', 1)
    s.getState().undo()
    s.getState().beginInteraction()
    s.getState().setParameter('exposure', 3)
    s.getState().redo()
    expect(s.getState().edit.exposure).toBe(3)
  })

  it('bounds history rather than growing without limit', () => {
    const s = store()
    for (let i = 0; i < HISTORY_LIMIT + 50; i++) {
      s.getState().setParameter('exposure', -5 + (10 * i) / (HISTORY_LIMIT + 50))
    }
    expect(s.getState().past).toHaveLength(HISTORY_LIMIT)
  })
})

describe('reset and presets', () => {
  it('returns to the default state as one undoable change', () => {
    const s = store()
    s.getState().setParameter('exposure', 3)
    s.getState().reset()
    expect(s.getState().edit).toEqual(DEFAULT_EDIT_STATE)
    s.getState().undo()
    expect(s.getState().edit.exposure).toBe(3)
  })

  it('does nothing when already at the defaults', () => {
    const s = store()
    s.getState().reset()
    expect(s.getState().past).toEqual([])
  })

  it('applies a partial patch as one entry', () => {
    const s = store()
    s.getState().applyPatch({ exposure: 1.5, contrast: 1.2 })
    expect(s.getState().edit).toEqual({ exposure: 1.5, contrast: 1.2 })
    expect(s.getState().past).toHaveLength(1)
  })
})

describe('the path taken to a state does not change the state', () => {
  // The purity invariant at the level this part can test it: the renderer is a
  // pure function of EditState, so if two paths reach the same EditState they
  // must render identically. The renderer-level half of this arrives with the
  // exposure and contrast passes, which have nothing to act on yet.
  const target: EditState = { exposure: 1.75, contrast: 1.4 }

  const paths: readonly [string, (s: EditorStore) => void][] = [
    [
      'set directly',
      (s) => {
        s.getState().setParameter('exposure', target.exposure)
        s.getState().setParameter('contrast', target.contrast)
      },
    ],
    [
      'dragged there',
      (s) => {
        drag(s, [-2, -1, 0, 1, target.exposure], 'exposure')
        drag(s, [0.5, 0.8, 1.9, target.contrast], 'contrast')
      },
    ],
    [
      'overshot, then dragged back',
      (s) => {
        drag(s, [5, 4, 3, target.exposure], 'exposure')
        drag(s, [0, 2, target.contrast], 'contrast')
      },
    ],
    [
      'reached, undone, redone',
      (s) => {
        s.getState().setParameter('exposure', target.exposure)
        s.getState().setParameter('contrast', target.contrast)
        s.getState().undo()
        s.getState().undo()
        s.getState().redo()
        s.getState().redo()
      },
    ],
    [
      'reached via a preset',
      (s) => {
        s.getState().applyPatch(target)
      },
    ],
    [
      'clamped in from outside the range',
      (s) => {
        s.getState().setParameter('exposure', target.exposure)
        s.getState().setParameter('contrast', target.contrast)
        // A no-op: clamping returns the same value, so no entry is recorded.
        s.getState().setParameter('exposure', target.exposure)
      },
    ],
  ]

  it.each(paths)('reaches an identical state: %s', (_name, follow) => {
    const s = store()
    follow(s)
    expect(editStatesEqual(s.getState().edit, target)).toBe(true)
    expect(s.getState().edit).toEqual(target)
  })

  it('produces states that are equal by value, not merely by reference', () => {
    // Snapshots are shared by reference across history, so an accidental mutation
    // would rewrite the past rather than adding to it.
    const a = store()
    const b = store()
    drag(a, [1, 2, 3])
    b.getState().setParameter('exposure', 3)

    expect(a.getState().edit).toEqual(b.getState().edit)
    a.getState().setParameter('exposure', -1)
    expect(b.getState().edit.exposure).toBe(3)
  })

  it('leaves earlier snapshots untouched as the edit moves on', () => {
    const s = store()
    s.getState().setParameter('exposure', 1)
    const snapshot = s.getState().past[0]
    s.getState().setParameter('exposure', 2)
    s.getState().setParameter('contrast', 1.9)
    expect(snapshot).toEqual(DEFAULT_EDIT_STATE)
  })
})
