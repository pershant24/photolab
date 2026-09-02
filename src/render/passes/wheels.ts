/**
 * The colour wheels, in the grade stage after the tone curve.
 *
 * Pointwise, so no overlap is declared and tiling needs no margin. It still
 * receives the full uniform contract, per the rule that every pass does.
 */

import wheelsSource from '../shaders/wheels.frag'

import { isWheelIdentity } from '../../core/colour/wheels'
import type { Pass, RenderInput } from './types'

const enabled = (input: RenderInput): boolean =>
  !isWheelIdentity(input.edit.lift) ||
  !isWheelIdentity(input.edit.gamma) ||
  !isWheelIdentity(input.edit.gain)

export const wheelsPass: Pass = {
  id: 'wheels',
  stage: 'grade',

  fragmentSource: () => wheelsSource,
  variantKey: () => 'default',
  enabled,

  bindUniforms(gl, locate, input) {
    const bind = (name: string, value: readonly number[]): void => {
      const location = locate(name)
      if (location) gl.uniform3f(location, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0)
    }
    bind('uLift', input.edit.lift)
    bind('uGamma', input.edit.gamma)
    bind('uGain', input.edit.gain)
  },
}
