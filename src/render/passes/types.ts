/**
 * The pass contract, and the stage ordering every pass is placed into.
 */

import type { EditState } from '../../core/state/editState'
import { GAMUT_COMPRESS_THRESHOLD } from '../../core/colour/display'
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
 * Settings that describe how the edit is being *viewed*, not what it is.
 *
 * Deliberately separate from `EditState`. These do not describe the photograph,
 * so they must not enter undo history — stepping back through view changes is
 * not what anyone means by undo — and they must not enter a preset, which would
 * carry one machine's debug switch onto another's edit.
 *
 * `displayMode` is also the project's one **compile-time** parameter: it selects
 * a different fragment source, so changing it legitimately compiles. That
 * boundary is real and the program cache depends on it, which is why the
 * distinction survives even though the placeholder that used to demonstrate it
 * is gone. Everything in `EditState` is a uniform.
 */
export interface ViewState {
  readonly displayMode: DisplayMode

  /**
   * The display transform's two stages, individually switchable.
   *
   * Compile-time, because each changes the generated source. They are separate
   * switches rather than one because they fix different problems — compression
   * handles colours too saturated for the display, tone mapping values too
   * bright — and because the agreement harness needs to address the matrix
   * without either in the way.
   */
  readonly toneMap: boolean
  readonly gamutCompress: boolean

  /**
   * A technical parameter rather than a creative one, so it stays here. The
   * roll-off knee moved to `EditState`, because it is a choice about the
   * photograph and belongs in undo and in presets.
   */
  readonly gamutThreshold: number
}

export const DEFAULT_VIEW_STATE: ViewState = {
  displayMode: 'sdr',
  toneMap: true,
  gamutCompress: true,
  gamutThreshold: GAMUT_COMPRESS_THRESHOLD,
}

/**
 * Everything a frame is rendered from.
 *
 * The three members are kept apart rather than merged into one bag because they
 * have three different lifetimes and three different rules. `source` is a GPU
 * texture and can never be serialised; `edit` is snapshotted into undo history
 * and must always be serialisable; `view` is neither. This is
 * `render(sourceImage, EditState)` with the viewing settings made explicit
 * instead of hidden.
 */
export interface RenderInput {
  readonly source: RenderSource
  readonly edit: EditState
  readonly view: ViewState
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

  /** Fragment source for the given input. May differ between variants. */
  fragmentSource(input: RenderInput): string

  /**
   * A key covering **only** what changes the generated source. Never a parameter
   * value: if something can change while the source stays byte-identical it is a
   * uniform, and putting it here means recompiling in order to set it.
   */
  variantKey(input: RenderInput): string

  /**
   * Whether this pass runs at all.
   *
   * This is the one thing `EditState` legitimately changes about graph
   * *structure*: a pass whose parameter sits at its identity value is skipped
   * entirely rather than running as an expensive no-op. The first time it is
   * enabled its program compiles; after that the cache serves it, so toggling
   * across the identity value during a drag costs one compile in total.
   */
  enabled(input: RenderInput): boolean

  /**
   * Bind everything beyond the four contract uniforms, which the graph has
   * already bound. Locations that resolve to `null` are skipped by the caller,
   * so a pass need not know which of its uniforms the compiler kept.
   */
  bindUniforms(
    gl: WebGL2RenderingContext,
    locate: (name: string) => WebGLUniformLocation | null,
    input: RenderInput,
    context: PassContext,
  ): void

  /**
   * Release anything the pass owns on the GPU.
   *
   * Most passes own nothing and omit this. A pass that caches a texture between
   * frames — the curve pass and its baked lookup table — must implement it, or
   * the texture outlives the context it belongs to.
   */
  dispose?(): void
}

/** Where a pass writes: the canvas, or a pooled offscreen target. */
export type PassOutput = { kind: 'canvas' } | { kind: 'target'; target: RenderTarget }
