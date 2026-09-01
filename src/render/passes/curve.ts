/**
 * Tone curve, in the grade stage.
 *
 * This is the first pass that carries state between frames, and the reason is
 * the architectural constraint in `docs/ARCHITECTURE.md` §6: the shader samples a
 * lookup texture and never evaluates a spline, so something has to hold the
 * baked texture and rebake it when the control points change.
 *
 * A **rebake happens once per control point change, never per frame.** That is
 * what makes the exception affordable — the variable-length loop over control
 * points and the throwing bounds check in `curve.ts` run on a slider drag at
 * most, off the hot path by construction rather than by anyone remembering to
 * keep them there.
 *
 * The pass is therefore built by a factory rather than exported as a constant:
 * its texture belongs to one GL context, and a module-level singleton would
 * outlive a lost context and hand a dead handle to the next one.
 */

import fragmentSource from '../shaders/curve.frag'

import { LUT_TOLERANCE, curveLutResolution, sampleCurveLut } from '../../core/colour/curve'
import { isIdentityCurve, splitControlPoints } from '../../core/state/editState'
import type { CurveLut } from '../gl/lut'
import { createCurveLut } from '../gl/lut'
import type { Pass, RenderInput } from './types'

import { CURVE_LUT_UNITS } from '../gl/textureUnits'

/** The grade's single tone curve uses the first of the curve units. */
const CURVE_LUT_UNIT = CURVE_LUT_UNITS[0]

export interface CurvePass extends Pass {
  /** Bakes performed. Asserted against, so a rebake per frame is a test failure. */
  readonly bakeCount: number
}

export function createCurvePass(): CurvePass {
  let lut: CurveLut | null = null
  let bakedFrom: string | null = null
  let bakes = 0

  /** Rebake only when the control points themselves changed. */
  const ensureLut = (gl: WebGL2RenderingContext, points: readonly number[]): CurveLut => {
    const signature = points.join(',')
    if (lut && bakedFrom === signature) return lut

    const { xs, ys } = splitControlPoints(points)
    // Resolution derived from the curve's own second derivative, not chosen: a
    // sharp knee needs an order of magnitude more samples than a gentle S, and
    // one fixed number is either wasteful for the first or wrong for the second.
    const size = curveLutResolution(xs, ys, LUT_TOLERANCE)
    const samples = sampleCurveLut(xs, ys, size)
    const domain: [number, number] = [xs[0] ?? 0, xs[xs.length - 1] ?? 1]

    lut?.dispose()
    lut = createCurveLut(gl, samples, domain)
    bakedFrom = signature
    bakes += 1
    return lut
  }

  return {
    id: 'toneCurve',
    stage: 'grade',

    fragmentSource: () => fragmentSource,
    variantKey: () => 'default',

    // Skipped at the identity, which is the default. The control points are not
    // in the variant key: changing them rebakes a texture, which is a uniform
    // update from the program cache's point of view and must never compile.
    enabled: (input: RenderInput) => !isIdentityCurve('toneCurve', input.edit.toneCurve),

    bindUniforms(gl, locate, input) {
      // No unit juggling here: baking happens on the reserved scratch unit
      // inside `createCurveLut`, which is what stops it disturbing `uSource`.
      const baked = ensureLut(gl, input.edit.toneCurve)

      const sampler = locate('uCurveLut')
      if (sampler) {
        gl.activeTexture(gl.TEXTURE0 + CURVE_LUT_UNIT)
        gl.bindTexture(gl.TEXTURE_2D, baked.texture)
        gl.uniform1i(sampler, CURVE_LUT_UNIT)
        gl.activeTexture(gl.TEXTURE0)
      }

      const domain = locate('uCurveDomain')
      if (domain) gl.uniform2f(domain, baked.domain[0], baked.domain[1])

      const size = locate('uCurveLutSize')
      if (size) gl.uniform1f(size, baked.size)
    },

    dispose() {
      lut?.dispose()
      lut = null
      bakedFrom = null
    },

    get bakeCount() {
      return bakes
    },
  }
}
