/**
 * The pass graph: stage ordering, ping-pong buffering, and the uniform contract.
 *
 * Three things happen here that deliberately do not happen in individual passes,
 * because each is a rule that must hold for every pass rather than a choice each
 * one makes:
 *
 * 1. **Ordering is by physical stage, not by registration.** A pass declares its
 *    stage and the graph sorts by {@link STAGES}. Registering a pass late cannot
 *    put it late in the chain.
 * 2. **All four contract uniforms are bound for every pass**, whether or not it
 *    uses them. See the note on {@link bindContractUniforms}.
 * 3. **Buffers come from a pool and ping-pong.** A chain of any length uses two
 *    targets, allocated on resize and never per frame.
 */

import type { RenderContext } from './gl/context'
import type { RenderTarget } from './gl/target'
import { TargetPool } from './gl/target'
import { ProgramCache } from './gl/program'
import type { FullScreenQuad } from './gl/quad'
import { createFullScreenQuad } from './gl/quad'
import quadVertexSource from './shaders/quad.vert'
import type { Pass, PassContext, RenderState } from './passes/types'
import { STAGES } from './passes/types'

export class RenderGraphError extends Error {
  override readonly name = 'RenderGraphError'
}

/** Sort into physical stage order, stable within a stage. */
export function orderPasses(passes: readonly Pass[]): Pass[] {
  const stageIndex = new Map(STAGES.map((stage, index) => [stage, index]))
  return [...passes]
    .map((pass, registrationIndex) => {
      const index = stageIndex.get(pass.stage)
      if (index === undefined) {
        throw new RenderGraphError(`pass "${pass.id}" declares unknown stage "${pass.stage}"`)
      }
      return { pass, index, registrationIndex }
    })
    .sort((a, b) => a.index - b.index || a.registrationIndex - b.registrationIndex)
    .map((entry) => entry.pass)
}

/**
 * Scaling between a buffer and the source region it covers is isotropic, and
 * every spatial parameter in the project relies on it: shaders derive their
 * scale from `uResolution.x / uSourceRect.z` on the x axis alone.
 *
 * That holds for a proxy downscale and for an export tile, but nothing in the
 * type system enforces it, and an anisotropic mismatch would be wrong in exactly
 * the silent way that made the two-uniform form of this contract wrong. Checked
 * once per pass on the CPU, where it costs nothing.
 */
function assertIsotropic(context: PassContext, passId: string): void {
  const [width, height] = context.resolution
  const rectWidth = context.sourceRect[2]
  const rectHeight = context.sourceRect[3]

  if (rectWidth <= 0 || rectHeight <= 0) {
    throw new RenderGraphError(
      `pass "${passId}": uSourceRect has non-positive extent ${rectWidth}x${rectHeight}`,
    )
  }

  const scaleX = width / rectWidth
  const scaleY = height / rectHeight
  // One buffer pixel of slack across the smaller axis. Tighter than that and
  // integer rounding of proxy dimensions trips it; looser and a real anisotropy
  // slips through.
  const tolerance = 1 / Math.min(rectWidth, rectHeight)

  if (Math.abs(scaleX - scaleY) > tolerance) {
    throw new RenderGraphError(
      `pass "${passId}": buffer-to-source scaling is anisotropic ` +
        `(x ${scaleX.toFixed(6)}, y ${scaleY.toFixed(6)}). ` +
        `Shaders derive scale from the x axis alone; see docs/SHADER_CONVENTIONS.md §2.`,
    )
  }
}

/**
 * Per-frame hooks.
 *
 * `onPassComplete` fires immediately after each pass draws, while its target is
 * still bound, and receives `null` for the final pass because that one draws to
 * the canvas. It exists so that a test can measure an **intermediate** buffer
 * rather than only the end of the chain.
 *
 * That distinction is not a convenience. The chain applies `SRGB_TO_ACESCG` and
 * then `ACESCG_TO_SRGB`, so an error in either matrix largely cancels in the
 * final image: a 1% error in one forward coefficient was measured to move the
 * canvas by at most **one 8-bit code value**, and to move it not at all on every
 * saturated patch, because the display clamp removes the residual exactly where
 * it is largest. The same error is 0.0093 in the ACEScg intermediate, roughly
 * nineteen times the half-float noise floor. Anything asserting that the shader
 * agrees with `src/core/colour/` has to look here.
 */
export interface RenderOptions {
  onPassComplete?: (passId: string, target: RenderTarget | null) => void
}

export class RenderGraph {
  #context: RenderContext
  #passes: Pass[]
  #pool: TargetPool
  #programs: ProgramCache
  #quad: FullScreenQuad

  constructor(context: RenderContext, passes: readonly Pass[]) {
    this.#context = context
    this.#passes = orderPasses(passes)
    this.#pool = new TargetPool(context.gl)
    this.#programs = new ProgramCache(context.gl, quadVertexSource)
    this.#quad = createFullScreenQuad(context.gl)

    const first = this.#passes[0]
    if (!first?.isSource) {
      throw new RenderGraphError(
        'the first pass in stage order must be a source pass (isSource: true); ' +
          'nothing else has an input to read',
      )
    }
  }

  /** Exposed so a test can assert the exact number of compiles, not just growth. */
  get compileCount(): number {
    return this.#programs.compileCount
  }

  get allocationCount(): number {
    return this.#pool.allocationCount
  }

  get passIds(): string[] {
    return this.#passes.map((pass) => pass.id)
  }

  /**
   * Render one frame into the canvas.
   *
   * The chain ping-pongs between two pooled targets; the last enabled pass draws
   * straight to the default framebuffer rather than into a target that would
   * then have to be blitted.
   */
  render(state: RenderState, context: PassContext, options: RenderOptions = {}): void {
    const { gl } = this.#context
    if (this.#context.status() === 'lost') return

    const active = this.#passes.filter((pass) => pass.enabled(state))
    if (active.length === 0) return

    const [width, height] = context.resolution
    this.#quad.bind()

    let input: RenderTarget | null = null

    for (let i = 0; i < active.length; i++) {
      const pass = active[i]
      if (!pass) continue
      const isLast = i === active.length - 1

      assertIsotropic(context, pass.id)

      const output = isLast ? null : this.#pool.acquire(width, height)

      gl.bindFramebuffer(gl.FRAMEBUFFER, output ? output.framebuffer : null)
      gl.viewport(0, 0, width, height)

      const compiled = this.#programs.get(
        pass.id,
        pass.variantKey(state),
        pass.fragmentSource(state),
      )
      gl.useProgram(compiled.program)

      this.#bindContractUniforms(compiled.uniformLocation.bind(compiled), context, input, pass)
      pass.bindUniforms(gl, compiled.uniformLocation.bind(compiled), state, context)

      this.#quad.draw()

      // The pass's target is still bound here, which is the only moment its
      // contents can be read before the next pass overwrites them or the pool
      // hands the buffer back out.
      options.onPassComplete?.(pass.id, output)

      // Released only after the draw that reads it has been issued.
      if (input) this.#pool.release(input)
      input = output
    }

    if (input) this.#pool.release(input)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindVertexArray(null)

    // Free targets from a previous size. Called with the size in use, so a
    // steady state prunes nothing and a resize reallocates exactly once.
    this.#pool.prune(width, height)
  }

  /**
   * Bind `uSource`, `uResolution`, `uImageSize` and `uSourceRect` for every pass,
   * unconditionally.
   *
   * Unconditionally is the point. A pass that bound only what it needs today
   * forces whoever adds a spatial parameter tomorrow to also change binding
   * code, and the version that compiles without `uSourceRect` is the version
   * that reconstructs the scale factor from the wrong pair of uniforms. Binding
   * all four here is what makes the resolution rule hold by default instead of
   * by discipline.
   *
   * A `null` location is not an error: the GLSL compiler removes uniforms that
   * do not affect the output, so a pass declaring the full contract and using
   * half of it has real nulls.
   */
  #bindContractUniforms(
    locate: (name: string) => WebGLUniformLocation | null,
    context: PassContext,
    input: RenderTarget | null,
    pass: Pass,
  ): void {
    const { gl } = this.#context

    const resolution = locate('uResolution')
    if (resolution) gl.uniform2f(resolution, context.resolution[0], context.resolution[1])

    const imageSize = locate('uImageSize')
    if (imageSize) gl.uniform2f(imageSize, context.imageSize[0], context.imageSize[1])

    const sourceRect = locate('uSourceRect')
    if (sourceRect) {
      gl.uniform4f(
        sourceRect,
        context.sourceRect[0],
        context.sourceRect[1],
        context.sourceRect[2],
        context.sourceRect[3],
      )
    }

    const source = locate('uSource')
    if (source) {
      if (!input) {
        throw new RenderGraphError(
          `pass "${pass.id}" declares uSource but is first in the chain and has no input`,
        )
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, input.texture)
      gl.uniform1i(source, 0)
    }
  }

  dispose(): void {
    this.#quad.dispose()
    this.#programs.dispose()
    this.#pool.disposeAll()
  }
}
