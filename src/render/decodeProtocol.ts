/**
 * The decode protocol and proxy sizing: everything about decoding that is not
 * the worker itself.
 *
 * Split out because `decode.worker.ts` installs an `onmessage` handler on the
 * worker global at module load, so importing it anywhere else — a unit test in
 * Node, a Playwright spec — throws on `self`. The sizing rule is the part worth
 * testing directly, and it is pure arithmetic.
 */

/** Roughly 2048px on the long edge, per the memory budget in CLAUDE.md. */
export const PROXY_LONG_EDGE = 2048

export interface DecodeRequest {
  readonly id: number
  readonly blob: Blob
}

export interface DecodeSuccess {
  readonly id: number
  readonly ok: true
  readonly bitmap: ImageBitmap
  /** True source dimensions, orientation-corrected. */
  readonly sourceWidth: number
  readonly sourceHeight: number
}

export interface DecodeFailure {
  readonly id: number
  readonly ok: false
  readonly message: string
}

export type DecodeResponse = DecodeSuccess | DecodeFailure

export function proxySize(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= PROXY_LONG_EDGE) return { width, height }
  const scale = PROXY_LONG_EDGE / longEdge
  // At least one pixel on each axis: a panorama can otherwise round its short
  // edge to zero, and createImageBitmap rejects a zero dimension.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

