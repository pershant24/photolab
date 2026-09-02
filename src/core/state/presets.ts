/**
 * Presets: a `Partial<EditState>` and a name.
 *
 * The engineering is nearly free, because `EditState` was built to make it so.
 * It is flat, serialisable, and merged through a table that iterates parameters
 * rather than the incoming patch — so a preset is a partial state, applying one
 * is `mergeEditState`, and unknown keys are dropped by the direction of that
 * loop rather than by a filter someone has to remember to write.
 *
 * # A preset stores only what differs from the default
 *
 * The choice matters more than the code. A preset that stored the complete state
 * would reset exposure and white balance every time it was applied, and those are
 * decisions about *this photograph* — how much light there was, what colour the
 * light was — not about the look. Wiping them is the opposite of what a starting
 * point should do.
 *
 * `docs/ARCHITECTURE.md` records the editing model as presets you apply and then
 * tune, and a sparse preset is the form that supports it: apply a grade preset to
 * work already in progress and the exposure survives.
 *
 * The honest cost, since this is a real trade rather than an obvious win: a
 * sparse preset **is not a complete description of a look**. Applied to two
 * different edits it gives two different results, so "the same preset" does not
 * mean "the same picture". A user who wants exact reproduction has a route —
 * reset, then apply — and that route works precisely *because* the stored form is
 * a difference from the default, which is a known state. A complete-state preset
 * would have made the common case wrong to make the rare case automatic.
 */

import {
  DEFAULT_EDIT_STATE,
  PARAMETERS,
  descriptorFor,
  isKnownParameter,
  mergeEditState,
} from './editState'
import type { EditState } from './editState'
import {
  defaultParameter,
  parametersEqual,
  sanitiseParameter,
  snapshotParameter,
} from './parameterKinds'
import type { ParameterValue } from './parameterKinds'

export interface Preset {
  readonly id: string
  readonly name: string
  /** Only the parameters that differ from the default. */
  readonly patch: Partial<EditState>
  /** Milliseconds since the epoch. Absent on the ones that ship with the app. */
  readonly savedAt?: number
  /** True for the presets that ship, which cannot be deleted or overwritten. */
  readonly builtIn?: boolean
}

/** The JSON envelope, versioned so a future format can be recognised. */
export interface PresetFile {
  readonly format: 'photolab-preset'
  readonly version: 1
  readonly presets: readonly { readonly name: string; readonly patch: Record<string, unknown> }[]
}

export const PRESET_FORMAT = 'photolab-preset'
export const PRESET_VERSION = 1

/**
 * The difference between a state and the default, as a patch.
 *
 * Compared through the registry, so a curve or a wheel is compared by value.
 * A reference compare would call every array different and store the whole
 * state every time.
 */
export function presetPatch(state: EditState): Partial<EditState> {
  const source = state as unknown as Record<string, ParameterValue>
  const patch: Record<string, ParameterValue> = {}
  for (const descriptor of PARAMETERS) {
    const value = source[descriptor.key]
    if (value === undefined) continue
    if (parametersEqual(descriptor, value, defaultParameter(descriptor))) continue
    patch[descriptor.key] = snapshotParameter(descriptor, value)
  }
  return patch
}

/** Whether a patch would change anything at all. */
export function isEmptyPatch(patch: Partial<EditState>): boolean {
  return Object.keys(patch).length === 0
}

/** A preset built from the current state. */
export function presetFromState(id: string, name: string, state: EditState): Preset {
  return { id, name, patch: presetPatch(state), savedAt: Date.now() }
}

/** Apply a preset over a state. A thin wrapper, kept so callers name the intent. */
export function applyPreset(state: EditState, preset: Preset): EditState {
  return mergeEditState(state, preset.patch)
}

/**
 * Validate an untrusted patch, dropping what this build does not understand.
 *
 * `mergeEditState` already refuses to carry unknown keys into a state. This runs
 * earlier, so that a preset *stored* on disk or shown in a list does not carry
 * fields that would silently vanish later — and so an import can say what it
 * dropped rather than appearing to have succeeded.
 */
export function sanitisePatch(raw: unknown): {
  patch: Partial<EditState>
  dropped: string[]
} {
  const dropped: string[] = []
  const patch: Record<string, ParameterValue> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { patch: {}, dropped }
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKnownParameter(key)) {
      dropped.push(key)
      continue
    }
    const descriptor = descriptorFor(key)
    const fallback = (DEFAULT_EDIT_STATE as unknown as Record<string, ParameterValue>)[key]
    const clean = sanitiseParameter(descriptor, value, fallback ?? defaultParameter(descriptor))
    // A value that sanitised all the way back to the default carried nothing.
    if (parametersEqual(descriptor, clean, defaultParameter(descriptor))) continue
    patch[key] = clean
  }
  return { patch: patch, dropped }
}

export class PresetFormatError extends Error {}

/** Serialise presets to the JSON envelope. */
export function serialisePresets(presets: readonly Preset[]): string {
  const file: PresetFile = {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    presets: presets.map((preset) => ({
      name: preset.name,
      patch: preset.patch,
    })),
  }
  return JSON.stringify(file, null, 2)
}

/**
 * Parse a preset file.
 *
 * Throws only when the envelope is unrecognisable. Anything wrong *inside* a
 * preset is dropped rather than fatal: one bad field should cost that field, not
 * the import, and the caller is told what went.
 */
export function parsePresets(text: string): { presets: Preset[]; dropped: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PresetFormatError('That file is not JSON.')
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new PresetFormatError('That file does not contain a preset.')
  }
  const file = raw as Partial<PresetFile>
  if (file.format !== PRESET_FORMAT) {
    throw new PresetFormatError('That file is not a photolab preset file.')
  }
  if (file.version !== PRESET_VERSION) {
    throw new PresetFormatError(
      `That file is version ${String(file.version)}; this build reads version ${PRESET_VERSION}.`,
    )
  }
  if (!Array.isArray(file.presets)) {
    throw new PresetFormatError('That file has no presets in it.')
  }

  const presets: Preset[] = []
  const dropped: string[] = []
  for (const [index, entry] of file.presets.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      dropped.push(`preset ${index}`)
      continue
    }
    const candidate = entry as { name?: unknown; patch?: unknown }
    const name = typeof candidate.name === 'string' && candidate.name.trim() !== ''
      ? candidate.name.trim()
      : null
    if (name === null) {
      dropped.push(`preset ${index} (no name)`)
      continue
    }
    const { patch, dropped: lost } = sanitisePatch(candidate.patch)
    for (const key of lost) dropped.push(`${name}: ${key}`)
    presets.push({ id: `imported-${Date.now()}-${index}`, name, patch, savedAt: Date.now() })
  }
  return { presets, dropped }
}
