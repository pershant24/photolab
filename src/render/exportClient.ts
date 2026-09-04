/**
 * Main-thread client for the export worker.
 *
 * One export at a time. A second request while one is running would contend for
 * nothing — the worker has a single GL context — and the interface has no way to
 * present two progress counts, so starting one cancels the other rather than
 * queueing behind it.
 */

import type {
  ExportDoneMessage,
  ExportRequest,
  ExportResponse,
} from './exportProtocol'
import type { EditState } from '../core/state/editState'
import type { ViewState } from './passes/types'

export class ExportCancelled extends Error {}
export class ExportUnsupported extends Error {}

export interface ExportJob {
  readonly blob: Blob
  readonly edit: EditState
  readonly view: ViewState
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly format: 'image/jpeg' | 'image/png'
  readonly quality?: number
  readonly measureMemory?: boolean
  readonly onProgress?: (done: number, total: number) => void
}

export class ExportClient {
  #worker: Worker
  #nextId = 1
  #pending: {
    id: number
    resolve: (v: ExportDoneMessage) => void
    reject: (e: Error) => void
    onProgress?: (done: number, total: number) => void
  } | null = null

  constructor() {
    this.#worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })
    this.#worker.onmessage = (event: MessageEvent<ExportResponse>) => {
      const message = event.data
      const pending = this.#pending
      // A message for an export that has already been abandoned. Dropped rather
      // than delivered: the caller has moved on and the blob is a large thing to
      // hand to code that is no longer expecting it.
      if (!pending || pending.id !== message.id) return

      switch (message.kind) {
        case 'progress':
          pending.onProgress?.(message.done, message.total)
          return
        case 'done':
          this.#pending = null
          pending.resolve(message)
          return
        case 'cancelled':
          this.#pending = null
          pending.reject(new ExportCancelled('Export cancelled.'))
          return
        case 'failed':
          this.#pending = null
          pending.reject(
            message.unsupported
              ? new ExportUnsupported(message.message)
              : new Error(message.message),
          )
          return
      }
    }
  }

  get busy(): boolean {
    return this.#pending !== null
  }

  run(job: ExportJob): Promise<ExportDoneMessage> {
    this.cancel()
    const id = this.#nextId++
    return new Promise<ExportDoneMessage>((resolve, reject) => {
      const entry = job.onProgress
        ? { id, resolve, reject, onProgress: job.onProgress }
        : { id, resolve, reject }
      this.#pending = entry
      const request: ExportRequest = {
        kind: 'start',
        id,
        blob: job.blob,
        edit: job.edit,
        view: job.view,
        sourceWidth: job.sourceWidth,
        sourceHeight: job.sourceHeight,
        format: job.format,
        ...(job.quality === undefined ? {} : { quality: job.quality }),
        ...(job.measureMemory === undefined ? {} : { measureMemory: job.measureMemory }),
      }
      this.#worker.postMessage(request)
    })
  }

  /** Ask the worker to stop. It checks between tiles, so this is not instant. */
  cancel(): void {
    const pending = this.#pending
    if (!pending) return
    this.#worker.postMessage({ kind: 'cancel', id: pending.id } satisfies ExportRequest)
  }

  dispose(): void {
    this.#worker.terminate()
    this.#pending?.reject(new Error('disposed'))
    this.#pending = null
  }
}
