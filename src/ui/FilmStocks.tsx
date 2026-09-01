/**
 * Film stock selection.
 *
 * A stock is applied as a **preset** — a `Partial<EditState>` merged in — rather
 * than stored as a "which stock is selected" parameter. That is what `CLAUDE.md`
 * already defines a preset to be, it keeps the three curves independently
 * editable afterwards, and it avoided adding a third kind of parameter to a
 * system that has two.
 *
 * The consequence, and it is the right one: there is no persistent notion of a
 * selected stock. Once the curves have been touched, the stock that seeded them
 * is history — which is exactly true, and pretending otherwise would mean
 * showing a label that no longer describes the image.
 */

import { useStore } from 'zustand'

import { FILM_STOCKS } from '../core/colour/filmStock'
import { DEFAULT_EDIT_STATE, filmStockPatch, isFilmStageIdentity } from '../core/state/editState'
import { editorStore } from '../core/state/editorStore'

export function FilmStocks() {
  const active = useStore(editorStore, (state) => !isFilmStageIdentity(state.edit))

  return (
    <div className="px-4 py-3 text-xs">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-ink">Film</span>
        <span className="text-ink-dim">{active ? 'applied' : 'none'}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FILM_STOCKS.map((stock) => (
          <button
            key={stock.id}
            type="button"
            data-testid={`stock-${stock.id}`}
            title={stock.description}
            onClick={() => editorStore.getState().applyPatch(filmStockPatch(stock))}
            className="rounded border border-hairline px-2 py-1 text-ink hover:bg-surface"
          >
            {stock.name}
          </button>
        ))}
        <button
          type="button"
          data-testid="stock-none"
          onClick={() =>
            editorStore.getState().applyPatch({
              filmCurveRed: [...DEFAULT_EDIT_STATE.filmCurveRed],
              filmCurveGreen: [...DEFAULT_EDIT_STATE.filmCurveGreen],
              filmCurveBlue: [...DEFAULT_EDIT_STATE.filmCurveBlue],
            })
          }
          className="rounded border border-hairline px-2 py-1 text-ink-dim hover:bg-surface"
        >
          None
        </button>
      </div>
    </div>
  )
}
