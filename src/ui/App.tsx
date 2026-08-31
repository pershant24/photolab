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

        <aside
          className="w-72 shrink-0 border-l border-hairline bg-surface-raised"
          aria-label="Adjustments"
        />
      </main>
    </div>
  )
}
