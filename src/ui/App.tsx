import { useStore } from 'zustand'

import { PARAMETERS } from '../core/state/editState'
import { editorStore } from '../core/state/editorStore'
import { ParameterControl } from './controls/registry'
import { FilmStocks } from './FilmStocks'
import { Viewport } from './Viewport'

/**
 * Application shell. Owns layout only and holds no editor state.
 */
export function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-hairline px-4 py-2.5">
        <h1 className="text-sm font-semibold tracking-tight">photolab</h1>
        <span className="text-xs text-ink-dim">ACEScg · WebGL2</span>
      </header>

      <main className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1" aria-label="Image viewport">
          <Viewport />
        </section>

        <Adjustments />
      </main>
    </div>
  )
}

/**
 * Deliberately unstyled beyond what makes it usable. The point of this stage is
 * to drag a slider and look at a photograph, and any effort spent on the panel
 * is effort not spent on the pipeline.
 */
function Adjustments() {
  const canUndo = useStore(editorStore, (state) => state.past.length > 0)
  const canRedo = useStore(editorStore, (state) => state.future.length > 0)

  return (
    <aside
      className="flex w-80 shrink-0 flex-col border-l border-hairline bg-surface-raised"
      aria-label="Adjustments"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/*
          One loop over one table, in the table's own order. Which control a row
          gets is the registry's business, so adding a colour wheel is registering
          a component rather than editing this file — and the panel does not
          branch on kind, which is the property the conversion was for.
        */}
        {PARAMETERS.map((descriptor) => (
          <ParameterControl key={descriptor.key} descriptor={descriptor} />
        ))}

        {/* Not a parameter: a preset picker that writes several of them. */}
        <FilmStocks />
      </div>

      <div className="mt-auto flex gap-2 border-t border-hairline px-4 py-3 text-xs">
        <button
          type="button"
          data-testid="undo"
          disabled={!canUndo}
          onClick={() => editorStore.getState().undo()}
          className="rounded border border-hairline px-2 py-1 text-ink disabled:opacity-40"
        >
          Undo
        </button>
        <button
          type="button"
          data-testid="redo"
          disabled={!canRedo}
          onClick={() => editorStore.getState().redo()}
          className="rounded border border-hairline px-2 py-1 text-ink disabled:opacity-40"
        >
          Redo
        </button>
        <button
          type="button"
          data-testid="reset"
          onClick={() => editorStore.getState().reset()}
          className="ml-auto rounded border border-hairline px-2 py-1 text-ink"
        >
          Reset
        </button>
      </div>
    </aside>
  )
}
