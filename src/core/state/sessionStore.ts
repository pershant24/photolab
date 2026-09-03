/**
 * Work in progress, per image, across reloads.
 *
 * Presets already persist; this is the rest of the session. An edit is a
 * `Partial<EditState>` keyed to the file it was made against, so reopening the
 * application and then reopening the photograph restores where you were.
 *
 * # What is stored, and what identifies an image
 *
 * The key is the file's name, byte length and modification time. Not a content
 * hash: hashing 60MP of pixels on every open costs more than the feature is
 * worth, and the three together are stable for the same file and different for
 * a different one in every case that matters. Two distinct files agreeing on all
 * three is possible and the consequence is that one photograph opens with
 * another's edit, which is visible immediately and undone by one press of reset.
 *
 * The **patch**, not the whole state, for the same reason presets store a patch:
 * a record written by an older build should contribute what it knows and let
 * this build's defaults supply the rest, rather than pinning fields it has never
 * heard of to values it invented.
 *
 * # Source images are not stored
 *
 * They are re-opened from disk. A photo editor that quietly copies every
 * photograph you open into browser storage is doing something the user did not
 * ask for, and `CLAUDE.md` is explicit that images never leave the machine —
 * writing them to IndexedDB is not leaving the machine, but it is still keeping
 * something nobody asked to keep, at 60MP a time.
 *
 * # Reopening without the source
 *
 * The edit exists and has nothing to apply to, and the decision is that it
 * **waits**. It is not applied to whatever photograph is opened next: one
 * photograph's exposure and white balance are decisions about the light in
 * *that* scene, and applying them to another is not restoring work, it is
 * corrupting a new file with an old one's edit.
 *
 * So the record stays keyed, the application opens with defaults and no image,
 * and the edit reattaches when a file matching its key is opened. The rejected
 * alternative — restore the most recent edit regardless — is the one that looks
 * more helpful in a demo and is wrong on the second photograph.
 */

import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'

import type { EditState } from './editState'
import { presetPatch, sanitisePatch } from './presets'

const DATABASE = 'photolab-session'
const STORE = 'edits'
const VERSION = 1

/** How many images' edits to keep. Oldest touched are dropped past this. */
export const SESSION_LIMIT = 200

interface SessionSchema extends DBSchema {
  edits: {
    key: string
    value: { key: string; patch: Record<string, unknown>; touchedAt: number; label: string }
  }
}

export interface StoredEdit {
  readonly key: string
  readonly patch: Partial<EditState>
  readonly touchedAt: number
  readonly label: string
}

let connection: Promise<IDBPDatabase<SessionSchema> | null> | null = null

function connect(): Promise<IDBPDatabase<SessionSchema> | null> {
  connection ??= openDB<SessionSchema>(DATABASE, VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    },
  }).catch(() => null)
  return connection
}

/** Forget the cached connection. For tests, and after deleting the database. */
export function resetSessionStore(): void {
  connection = null
}

/**
 * How a file is identified.
 *
 * Exported so a test can construct one without a `File`, and so the shape of the
 * key is a stated decision rather than an implementation detail buried in a
 * template literal.
 */
export function imageKey(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

/**
 * Store the edit for an image, unless it is the default state.
 *
 * An unedited photograph writes nothing: a record whose patch is empty restores
 * nothing and would only take a slot from an image that has real work in it.
 */
export async function saveEdit(key: string, label: string, edit: EditState): Promise<boolean> {
  const db = await connect()
  if (!db) return false
  const patch = presetPatch(edit)
  try {
    if (Object.keys(patch).length === 0) {
      await db.delete(STORE, key)
      return true
    }
    await db.put(STORE, {
      key,
      label,
      patch: patch,
      touchedAt: Date.now(),
    })
    await prune(db)
    return true
  } catch {
    return false
  }
}

/**
 * The stored edit for an image, validated.
 *
 * Sanitised on the way out as well as in, like presets and for the same reason:
 * a record may have been written by a different build against a different
 * parameter table, and it is as untrusted as anything else that has been to disk
 * and back.
 */
export async function loadEdit(key: string): Promise<Partial<EditState> | null> {
  const db = await connect()
  if (!db) return null
  try {
    const row = await db.get(STORE, key)
    if (!row) return null
    return sanitisePatch(row.patch).patch
  } catch {
    return null
  }
}

/** Every stored edit, most recently touched first. */
export async function listEdits(): Promise<StoredEdit[]> {
  const db = await connect()
  if (!db) return []
  try {
    const rows = await db.getAll(STORE)
    return rows
      .map((row) => ({
        key: row.key,
        label: row.label,
        patch: sanitisePatch(row.patch).patch,
        touchedAt: row.touchedAt,
      }))
      .sort((a, b) => b.touchedAt - a.touchedAt)
  } catch {
    return []
  }
}

export async function forgetEdit(key: string): Promise<void> {
  const db = await connect()
  if (!db) return
  try {
    await db.delete(STORE, key)
  } catch {
    // Storage is unavailable. Nothing to report: the caller asked to forget
    // something and it is, as far as anything can tell, forgotten.
  }
}

/** Drop the least recently touched records past the limit. */
async function prune(db: IDBPDatabase<SessionSchema>): Promise<void> {
  const rows = await db.getAll(STORE)
  if (rows.length <= SESSION_LIMIT) return
  const doomed = rows
    .sort((a, b) => a.touchedAt - b.touchedAt)
    .slice(0, rows.length - SESSION_LIMIT)
  for (const row of doomed) await db.delete(STORE, row.key)
}
