/**
 * Messages between the main thread and the export worker.
 *
 * Kept in its own module so both ends compile against one definition rather than
 * two that agree by convention — the same reason `decodeProtocol.ts` exists.
 */

import type { EditState } from '../core/state/editState'
import type { ViewState } from './passes/types'

export interface ExportStartMessage {
  readonly kind: 'start'
  readonly id: number
  /** The original file. Transferring is not possible; a Blob is cloned cheaply. */
  readonly blob: Blob
  readonly edit: EditState
  readonly view: ViewState
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly format: 'image/jpeg' | 'image/png'
  readonly quality?: number
  /** Measure peak memory around the export. Costs a pause, so it is opt-in. */
  readonly measureMemory?: boolean
}

export interface ExportCancelMessage {
  readonly kind: 'cancel'
  readonly id: number
}

export type ExportRequest = ExportStartMessage | ExportCancelMessage

export interface ExportProgressMessage {
  readonly kind: 'progress'
  readonly id: number
  readonly done: number
  readonly total: number
}

export interface ExportDoneMessage {
  readonly kind: 'done'
  readonly id: number
  readonly blob: Blob
  readonly width: number
  readonly height: number
  readonly tiles: number
  readonly overlap: number
  readonly milliseconds: number
  readonly uploadPath: 'pixel-store' | 'crop-rectangle'
  /** Bytes the agent attributes to the worker, when it could be measured. */
  readonly memory: MemoryReport
}

export interface ExportFailedMessage {
  readonly kind: 'failed'
  readonly id: number
  readonly message: string
  /** True when the worker could not start at all, per the standing loud-failure rule. */
  readonly unsupported: boolean
}

export interface ExportCancelledMessage {
  readonly kind: 'cancelled'
  readonly id: number
}

export type ExportResponse =
  | ExportProgressMessage
  | ExportDoneMessage
  | ExportFailedMessage
  | ExportCancelledMessage

/**
 * What a memory measurement produced, including why it did not.
 *
 * A discriminated result rather than `number | null`, because "the API is absent"
 * and "the page is not cross-origin isolated" and "it measured 500MB" are three
 * different findings and the first two are worth reporting as such. This project
 * has already reported arithmetic as measurement once.
 */
export type MemoryReport =
  | { readonly kind: 'measured'; readonly beforeBytes: number; readonly peakBytes: number }
  | { readonly kind: 'unavailable'; readonly reason: string }
