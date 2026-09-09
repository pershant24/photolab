/**
 * The preset panel: apply, save, delete, import, export.
 *
 * Applying goes through `applyPatch`, which commits once — so a preset that
 * changes twenty parameters is one undo step, the same way a drag is. That is not
 * arranged here; it falls out of the store, and `tests/render/presets.spec.ts`
 * asserts it rather than trusting it.
 *
 * Deliberately unstyled beyond what makes it usable, like the rest of the panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { AXIS_PRESETS, BUNDLES } from '../core/presets/axisLibrary'
import { PRESET_AXES, axisResetPatch, resolveBundle } from '../core/state/axes'
import { editorStore } from '../core/state/editorStore'
import {
  PresetFormatError,
  isEmptyPatch,
  parsePresets,
  presetFromState,
  presetPatch,
  serialisePresets,
} from '../core/state/presets'
import type { Preset } from '../core/state/presets'
import type { EditState } from '../core/state/editState'
import { deletePreset, loadPresets, savePreset } from '../core/state/presetStore'

export function Presets() {
  const edit = useStore(editorStore, (state) => state.edit)
  const [saved, setSaved] = useState<Preset[]>([])
  const [name, setName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void loadPresets().then(setSaved)
  }, [])

  /** One history entry, whatever the patch touches. Shared by presets and bundles. */
  const applyPatch = useCallback((patch: Partial<EditState>) => {
    editorStore.getState().applyPatch(patch)
  }, [])

  const apply = useCallback((preset: Preset) => {
    // One history entry, however many parameters it touches.
    editorStore.getState().applyPatch(preset.patch)
  }, [])

  const save = useCallback(async () => {
    const trimmed = name.trim()
    if (trimmed === '') return
    const patch = presetPatch(editorStore.getState().edit)
    if (isEmptyPatch(patch)) {
      setMessage('Nothing to save: this is the default state.')
      return
    }
    const preset = presetFromState(`user-${Date.now()}`, trimmed, editorStore.getState().edit)
    const persisted = await savePreset(preset)
    setSaved((previous) => [...previous, preset])
    setName('')
    setMessage(persisted ? null : 'Saved for this session only: storage is unavailable.')
  }, [name])

  const remove = useCallback(async (preset: Preset) => {
    await deletePreset(preset.id)
    setSaved((previous) => previous.filter((p) => p.id !== preset.id))
  }, [])

  const exportAll = useCallback(() => {
    const blob = new Blob([serialisePresets(saved)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'photolab-presets.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }, [saved])

  const importFile = useCallback(async (file: File) => {
    try {
      const { presets, dropped } = parsePresets(await file.text())
      for (const preset of presets) await savePreset(preset)
      setSaved((previous) => [...previous, ...presets])
      setMessage(
        dropped.length > 0
          ? `Imported ${presets.length}; dropped ${dropped.length}: ${dropped.slice(0, 3).join(', ')}`
          : `Imported ${presets.length}.`,
      )
    } catch (error) {
      setMessage(error instanceof PresetFormatError ? error.message : 'Could not read that file.')
    }
  }, [])

  const row = (preset: Preset, deletable: boolean, patch?: Partial<EditState>) => (
    <li key={preset.id} className="flex items-center gap-2 py-0.5">
      <button
        type="button"
        data-testid={`apply-${preset.id}`}
        onClick={() => (patch ? applyPatch(patch) : apply(preset))}
        className="min-w-0 flex-1 truncate text-left text-ink hover:underline"
      >
        {preset.name}
      </button>
      <span className="shrink-0 text-ink-dim">{Object.keys(preset.patch).length}</span>
      {deletable && (
        <button
          type="button"
          data-testid={`delete-${preset.id}`}
          onClick={() => void remove(preset)}
          className="shrink-0 text-ink-dim hover:text-ink"
          aria-label={`Delete ${preset.name}`}
        >
          ×
        </button>
      )}
    </li>
  )

  return (
    <div className="border-b border-hairline px-4 py-3 text-xs" data-testid="presets">
      <div className="mb-1.5 text-ink">Presets</div>

      {/*
        Bundles first, then the axes. A bundle is what most people want — a
        finished starting point — and the axes are there for anyone who wants to
        swap one third of it. Grouping by axis is not decoration: it is what makes
        the composition legible, because a user who can see three lists
        understands they can take one from each.
      */}
      <ul className="mb-2" data-testid="bundle-list">
        {BUNDLES.map((bundle) => {
          const { patch, missing } = resolveBundle(bundle, AXIS_PRESETS)
          return (
            <li key={bundle.id} className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid={`apply-${bundle.id}`}
                onClick={() => applyPatch(patch)}
                className="grow truncate text-left text-ink-dim hover:text-ink"
              >
                {bundle.name}
                {missing.length > 0 && (
                  // Said out loud rather than repaired. The component may come
                  // back, and a bundle quietly applying two thirds of itself
                  // without saying so is worse than one that admits it.
                  <span className="ml-1 text-ink-dim" title={`missing: ${missing.join(', ')}`}>
                    (partial)
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      {PRESET_AXES.map((axis) => (
        <div key={axis} className="mb-2 border-t border-hairline pt-1.5">
          <div className="mb-1 text-ink-dim capitalize">{axis}</div>
          <ul data-testid={`${axis}-list`}>
            {AXIS_PRESETS.filter((preset) => preset.axis === axis).map((preset) =>
              // The axis is replaced rather than merged onto, so switching from
              // one camera to another cannot leave the first one's diffusion
              // behind. `applyAxisPreset` carries the reasoning; the same patch
              // is built here so it stays one history entry.
              row(preset, false, { ...axisResetPatch(axis), ...preset.patch }),
            )}
          </ul>
        </div>
      ))}
      {saved.length > 0 && (
        <ul className="mb-2 border-t border-hairline pt-1.5">
          {saved.map((preset) => row(preset, true))}
        </ul>
      )}

      <div className="flex gap-1.5">
        <input
          type="text"
          value={name}
          data-testid="preset-name"
          placeholder="Name this look"
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded border border-hairline bg-transparent px-1.5 py-1 text-ink"
        />
        <button
          type="button"
          data-testid="preset-save"
          onClick={() => void save()}
          disabled={name.trim() === ''}
          className="shrink-0 rounded border border-hairline px-2 py-1 text-ink disabled:opacity-40"
        >
          Save
        </button>
      </div>

      <div className="mt-1.5 flex gap-1.5">
        <button
          type="button"
          data-testid="preset-export"
          onClick={exportAll}
          disabled={saved.length === 0}
          className="rounded border border-hairline px-2 py-1 text-ink disabled:opacity-40"
        >
          Export
        </button>
        <button
          type="button"
          data-testid="preset-import"
          onClick={() => fileRef.current?.click()}
          className="rounded border border-hairline px-2 py-1 text-ink"
        >
          Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          data-testid="preset-file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importFile(file)
            event.target.value = ''
          }}
        />
      </div>

      {message && (
        <p className="mt-1.5 text-ink-dim" data-testid="preset-message">
          {message}
        </p>
      )}

      {/* Unused here, but it keeps the panel re-rendering as the edit changes so
          the saved-parameter counts stay honest. */}
      <span className="hidden">{Object.keys(edit).length}</span>
    </div>
  )
}
