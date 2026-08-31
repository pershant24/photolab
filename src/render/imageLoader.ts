/**
 * Main-thread client for the decode worker.
 *
 * Requests are tagged so that a load started while an earlier one is still
 * decoding cannot deliver out of order — picking three files quickly would
 * otherwise leave whichever decoded last on screen rather than the one chosen
 * last, and a large file followed by a small one makes that likely rather than
 * theoretical.
 */

import type { DecodeRequest, DecodeResponse } from './decodeProtocol'

export interface DecodedImage {
  readonly bitmap: ImageBitmap
  readonly sourceWidth: number
  readonly sourceHeight: number
}

export class ImageLoader {
  #worker: Worker
  #nextId = 1
  #pending = new Map<number, { resolve: (v: DecodedImage) => void; reject: (e: Error) => void }>()
  /** Only the most recent request may deliver; earlier ones are abandoned. */
  #latestId = 0

  constructor() {
    this.#worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' })
    this.#worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
      const response = event.data
      const entry = this.#pending.get(response.id)
      this.#pending.delete(response.id)
      if (!entry) return

      if (response.id !== this.#latestId) {
        // Superseded. Close the bitmap rather than leaking it; a 2048px proxy is
        // 16MB and a user flicking through a folder produces a lot of them.
        if (response.ok) response.bitmap.close()
        entry.reject(new Error('superseded'))
        return
      }

      if (response.ok) {
        entry.resolve({
          bitmap: response.bitmap,
          sourceWidth: response.sourceWidth,
          sourceHeight: response.sourceHeight,
        })
      } else {
        entry.reject(new Error(response.message))
      }
    }
  }

  /** Rejects with `superseded` if another load starts before this one finishes. */
  load(blob: Blob): Promise<DecodedImage> {
    const id = this.#nextId++
    this.#latestId = id
    return new Promise<DecodedImage>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      const request: DecodeRequest = { id, blob }
      this.#worker.postMessage(request)
    })
  }

  dispose(): void {
    this.#worker.terminate()
    for (const entry of this.#pending.values()) entry.reject(new Error('disposed'))
    this.#pending.clear()
  }
}

export function isSupersededError(error: unknown): boolean {
  return error instanceof Error && error.message === 'superseded'
}
