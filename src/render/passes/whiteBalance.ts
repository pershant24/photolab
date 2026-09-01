/**
 * White balance, in the scene stage, before exposure.
 *
 * The matrix is rebuilt from temperature and tint on every frame the parameters
 * change, which is a few matrix multiplies on the CPU rather than anything the
 * shader has to do per pixel.
 */

import fragmentSource from '../shaders/whiteBalance.frag'

import { isNeutralWhiteBalance, whiteBalanceMatrix } from '../../core/colour/whiteBalance'
import type { Pass, RenderInput } from './types'

export const whiteBalancePass: Pass = {
  id: 'whiteBalance',
  stage: 'scene',

  fragmentSource: () => fragmentSource,
  variantKey: () => 'default',

  // Skipped at the neutral setting, which is what makes "neutral is an exact
  // identity" true rather than nearly true: the pass does not run, so there is
  // no arithmetic to be almost right.
  enabled: (input: RenderInput) =>
    !isNeutralWhiteBalance(input.edit.temperature, input.edit.tint),

  bindUniforms(gl, locate, input) {
    const location = locate('uWhiteBalance')
    if (!location) return

    const matrix = whiteBalanceMatrix(input.edit.temperature, input.edit.tint)
    // `transpose = true` because `Mat3` is row-major and GLSL's `mat3` is
    // column-major. WebGL2 permits the transpose flag; WebGL1 did not, which is
    // why so much code transposes by hand and why getting it wrong produces a
    // plausible image with wrong colour. See src/core/colour/types.ts.
    gl.uniformMatrix3fv(location, true, new Float32Array(matrix))
  },
}
