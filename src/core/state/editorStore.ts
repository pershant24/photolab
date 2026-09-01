/**
 * The editor store: current `EditState`, and undo as an array of snapshots.
 *
 * ## Snapshots, not commands
 *
 * `EditState` is a handful of numbers, so a snapshot costs tens of bytes and a
 * whole history costs less than a single texture row. A command pattern would
 * buy nothing and would require every parameter to also describe how to invert
 * itself — a second implementation of every operator, kept in step by hand.
 *
 * ## A drag is one history entry, not sixty
 *
 * This is the part worth getting right before there are ten sliders rather than
 * two. A pointer drag emits state changes at frame rate; committing one history
 * entry per change makes undo step back through a drag one frame at a time,
 * which is unusable and gets worse the longer the drag.
 *
 * So history is committed on **pointer-up**, not per change:
 *
 * - {@link EditorStoreState.beginInteraction} records a *baseline* — the state
 *   as it was before the drag started.
 * - {@link EditorStoreState.setParameter} during the drag updates the current
 *   state only.
 * - {@link EditorStoreState.endInteraction} pushes the baseline as the single
 *   entry, if anything actually changed.
 *
 * A change made outside an interaction — a keyboard nudge, a typed value, a
 * preset — commits immediately, because each of those is already one discrete
 * action.
 *
 * The consequence worth noting: a drag that ends where it began adds nothing to
 * history. Clicking a slider without moving it is not an undoable event, and
 * treating it as one is how undo stacks fill with entries that appear to do
 * nothing when replayed.
 */

import { createStore } from 'zustand/vanilla'
import type { StoreApi } from 'zustand/vanilla'

import type { EditState, NumericEditKey } from './editState'
import {
  DEFAULT_EDIT_STATE,
  editStatesEqual,
  mergeEditState,
  withParameter,
} from './editState'

/**
 * Snapshots are tens of bytes, so this is not a memory limit. It bounds a
 * pathological session — a scripted drag, a stuck key — rather than a realistic
 * one, and the oldest entries are the ones nobody reaches for.
 */
export const HISTORY_LIMIT = 200

export interface EditorStoreState {
  readonly edit: EditState
  /** Oldest first. The entry at the end is what one undo returns to. */
  readonly past: readonly EditState[]
  /** Nearest first. The entry at the front is what one redo returns to. */
  readonly future: readonly EditState[]
  /**
   * The state as it was when the current drag began, or `null` when no drag is
   * in flight. This is what gets pushed to `past` on pointer-up.
   */
  readonly interactionBaseline: EditState | null

  setParameter(key: NumericEditKey, value: number): void
  /** Apply a `Partial<EditState>` — a preset — as one history entry. */
  applyPatch(patch: Partial<EditState>): void
  beginInteraction(): void
  endInteraction(): void
  undo(): void
  redo(): void
  reset(): void
}

export type EditorStore = StoreApi<EditorStoreState>

function pushHistory(
  past: readonly EditState[],
  entry: EditState,
): readonly EditState[] {
  const next = [...past, entry]
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
}

export function createEditorStore(initial: EditState = DEFAULT_EDIT_STATE): EditorStore {
  return createStore<EditorStoreState>()((set, get) => {
    /** Commit `next` as a discrete, immediately-undoable change. */
    const commit = (next: EditState): void => {
      const { edit, past } = get()
      if (editStatesEqual(next, edit)) return
      // Any redo branch is abandoned: the future was reachable only from the
      // state just departed from.
      set({ edit: next, past: pushHistory(past, edit), future: [], interactionBaseline: null })
    }

    return {
      edit: initial,
      past: [],
      future: [],
      interactionBaseline: null,

      setParameter(key, value) {
        const { edit, interactionBaseline } = get()
        const next = withParameter(edit, key, value)
        if (editStatesEqual(next, edit)) return

        if (interactionBaseline !== null) {
          // Mid-drag: the value moves, history does not. `future` is cleared at
          // the first change rather than at pointer-up, so a redo cannot survive
          // a drag that is still in progress.
          set({ edit: next, future: [] })
          return
        }
        commit(next)
      },

      applyPatch(patch) {
        commit(mergeEditState(get().edit, patch))
      },

      beginInteraction() {
        // A second begin without an end is ignored rather than overwriting: the
        // first baseline is the state the whole gesture started from, and that
        // is what undo should return to.
        if (get().interactionBaseline !== null) return
        set({ interactionBaseline: get().edit })
      },

      endInteraction() {
        const { edit, interactionBaseline, past } = get()
        if (interactionBaseline === null) return

        if (editStatesEqual(edit, interactionBaseline)) {
          // A click with no movement. Not an undoable event.
          set({ interactionBaseline: null })
          return
        }
        set({ interactionBaseline: null, past: pushHistory(past, interactionBaseline) })
      },

      undo() {
        const { past, future, edit, interactionBaseline } = get()

        // An undo while a drag is in flight **cancels the drag** rather than
        // stepping through history. The drag has not been committed, so popping
        // history would skip straight past the state the drag started from —
        // the value would jump from wherever the pointer is to two states back,
        // and the position the user was dragging from would be lost with no way
        // to return to it. Cancelling restores that position, and a second undo
        // then steps back normally.
        if (interactionBaseline !== null) {
          set({ edit: interactionBaseline, interactionBaseline: null })
          return
        }

        const previous = past[past.length - 1]
        if (previous === undefined) return
        set({ edit: previous, past: past.slice(0, -1), future: [edit, ...future] })
      },

      redo() {
        const { past, future, edit, interactionBaseline } = get()
        // Mid-gesture there is no coherent thing to redo: the drag cleared the
        // redo branch the moment it moved. Ignored rather than guessed at.
        if (interactionBaseline !== null) return

        const next = future[0]
        if (next === undefined) return
        set({ edit: next, past: pushHistory(past, edit), future: future.slice(1) })
      },

      reset() {
        commit(DEFAULT_EDIT_STATE)
      },
    }
  })
}

/** The application's store. Tests build their own with {@link createEditorStore}. */
export const editorStore = createEditorStore()
