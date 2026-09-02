/**
 * Presets on disk, in IndexedDB.
 *
 * IndexedDB rather than `localStorage` because a preset is structured data and
 * `localStorage` stores strings — which would mean serialising on every write and
 * parsing on every read, and a quota measured in a few megabytes shared with
 * everything else the origin stores. `idb` is already a dependency for exactly
 * this.
 *
 * Every operation resolves rather than throwing when storage is unavailable.
 * IndexedDB is absent in a private window in some browsers and blocked by
 * policy in others, and a photo editor that will not open because it cannot save
 * a preset is worse than one whose presets do not persist. The failure is
 * reported to the caller so the interface can say so.
 */

import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'

import type { Preset } from './presets'
import { sanitisePatch } from './presets'

const DATABASE = 'photolab'
const STORE = 'presets'
const VERSION = 1

interface PresetSchema extends DBSchema {
  presets: {
    key: string
    value: { id: string; name: string; patch: Record<string, unknown>; savedAt: number }
  }
}

let connection: Promise<IDBPDatabase<PresetSchema> | null> | null = null

function connect(): Promise<IDBPDatabase<PresetSchema> | null> {
  connection ??= openDB<PresetSchema>(DATABASE, VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    },
  }).catch(() => null)
  return connection
}

/** Forget the cached connection. For tests, and after a delete of the database. */
export function resetPresetStore(): void {
  connection = null
}

/**
 * Every stored preset, oldest first.
 *
 * Patches are re-validated on the way out, not only on the way in. A stored
 * preset is as untrusted as an imported one: it may have been written by an older
 * build, or by a newer one through a shared origin, and the parameter table it
 * was written against is not this one.
 */
export async function loadPresets(): Promise<Preset[]> {
  const db = await connect()
  if (!db) return []
  try {
    const rows = await db.getAll(STORE)
    return rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        patch: sanitisePatch(row.patch).patch,
        savedAt: row.savedAt,
      }))
      .sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0))
  } catch {
    return []
  }
}

/** Store a preset, replacing any with the same id. Returns whether it persisted. */
export async function savePreset(preset: Preset): Promise<boolean> {
  const db = await connect()
  if (!db) return false
  try {
    await db.put(STORE, {
      id: preset.id,
      name: preset.name,
      patch: preset.patch,
      savedAt: preset.savedAt ?? Date.now(),
    })
    return true
  } catch {
    return false
  }
}

export async function deletePreset(id: string): Promise<boolean> {
  const db = await connect()
  if (!db) return false
  try {
    await db.delete(STORE, id)
    return true
  } catch {
    return false
  }
}
