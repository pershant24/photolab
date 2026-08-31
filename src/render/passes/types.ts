/**
 * The pass contract, and the stage ordering every pass is placed into.
 */

import type { RenderTarget } from '../gl/target'

/**
 * The physical stages, in the order the phenomena occur. Light leaves the scene,
 * passes through a lens, lands on film, and the developed result is interpreted
 * by a colourist and shown on a display.
 *
 * This array *is* the execution order. A pass declares which stage it belongs to
 * and the graph sorts by this list, so a pass cannot be appended to the end of
 * the chain by accident — the failure that puts a vignette after the grade,
 * where it darkens an already-graded image and behaves like a post effect rather
 * than an aperture.
 *
 * Every stage exists from the start even while most hold no passes. Adding an
 * effect later is registering it against a stage that is already there, not
 * introducing a new position in a chain that has to be reasoned about again.
 *
 * The rationale for the ordering is in docs/COLOUR_PIPELINE.md.
 */
export const STAGES = ['ingest', 'scene', 'lens', 'film', 'grade', 'display'] as const

export type Stage = (typeof STAGES)[number]

/**
 * The image being edited: the `sourceImage` half of
 * `render(sourceImage, EditState)`.
 *
 * Kept as its own argument rather than folded into {@link RenderState}, because
 * it is not a parameter and will never belong in `EditState`. `EditState` has to
 * be flat, serialisable and snapshot-able for undo; a GPU texture is none of
 * those.
 *
 * `pattern` is the generated pattern from Part B. It remains after image loading
 * lands, because it is what the agreement tests measure and it needs no fixture
 * file to exist.
 */
export type RenderSource =
  | { readonly kind: 'pattern' }
  | {
      readonly kind: 'image'
      readonly texture: WebGLTexture
      /** Proxy dimensions — what was actually uploaded. */
      readonly width: number
      readonly height: number
      /** True source dimensions, orientation-corrected. Drives `uImageSize`. */
      readonly sourceWidth: number
      readonly sourceHeight: number
    }

/**
 * Placeholder editor state for the plumbing.
 *
 * `EditState` proper lands in `src/core/state/` with the first real adjustment.
 * These two fields exist because they are the two sides of the boundary that
 * `ProgramCache` enforces, and a test needs both to assert it:
 *
 * - `displayMode` is **compile-time**. It selects a different fragment source,
 *   so changing it is a legitimate recompile.
 * - `patternPhase` is **runtime**. It is a uniform, so changing it must never
 *   compile anything, however many times it changes during a drag.
 */
export interface RenderState {
  readonly displayMode: DisplayMode
  readonly patternPhase: number
}

/**
 * `sdr` is the real display transform. `identity` skips it entirely and is a
 * debug path only — it exists because an sRGB round-trip check is impossible
 * against a clamped, transformed output, and it must never be reachable from
 * ordinary interface controls.
 */
export type DisplayMode = 'sdr' | 'identity'

/**
 * What a pass is told about the buffer it is rendering into. The three spatial
 * members are the uniform contract; see docs/SHADER_CONVENTIONS.md §1.
 */
export interface PassContext {
  /** Dimensions of the buffer being rendered. */
  readonly resolution: readonly [number, number]
  /** Dimensions of the full source image, orientation-corrected. */
  readonly imageSize: readonly [number, number]
  /** `(x, y, width, height)` of the source region this buffer covers. */
  readonly sourceRect: readonly [number, number, number, number]
}

export interface Pass {
  readonly id: string
  readonly stage: Stage

  /**
   * `true` when this pass is the start of the chain and reads no input. The
   * graph binds no `uSource` for it and gives it no input target.
   */
  readonly isSource?: boolean

  /** Fragment source for the given state. May differ between variants. */
  fragmentSource(state: RenderState): string

  /**
   * A key covering **only** what changes the generated source. Never a parameter
   * value: if something can change while the source stays byte-identical it is a
   * uniform, and putting it here means recompiling in order to set it.
   */
  variantKey(state: RenderState): string

  /** Whether this pass runs at all. Changing this changes the graph structure. */
  enabled(state: RenderState, source: RenderSource): boolean

  /**
   * Bind everything beyond the four contract uniforms, which the graph has
   * already bound. Locations that resolve to `null` are skipped by the caller,
   * so a pass need not know which of its uniforms the compiler kept.
   */
  bindUniforms(
    gl: WebGL2RenderingContext,
    locate: (name: string) => WebGLUniformLocation | null,
    state: RenderState,
    context: PassContext,
    source: RenderSource,
  ): void
}

/** Where a pass writes: the canvas, or a pooled offscreen target. */
export type PassOutput = { kind: 'canvas' } | { kind: 'target'; target: RenderTarget }
