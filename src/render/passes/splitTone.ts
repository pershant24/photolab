/** Split toning, in the grade stage after the HSL bands. Pointwise. */

import splitToneSource from '../shaders/splitTone.frag'

import { isSplitToneIdentity } from '../../core/colour/splitTone'
import type { Pass, RenderInput } from './types'

const enabled = (input: RenderInput): boolean =>
  !isSplitToneIdentity(input.edit.splitShadowTint, input.edit.splitHighlightTint)

export const splitTonePass: Pass = {
  id: 'splitTone',
  stage: 'grade',

  fragmentSource: () => splitToneSource,
  variantKey: () => 'default',
  enabled,

  bindUniforms(gl, locate, input) {
    const bind = (name: string, value: readonly number[]): void => {
      const location = locate(name)
      if (location) gl.uniform3f(location, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0)
    }
    bind('uSplitShadowTint', input.edit.splitShadowTint)
    bind('uSplitHighlightTint', input.edit.splitHighlightTint)
    const balance = locate('uSplitBalance')
    if (balance) gl.uniform1f(balance, input.edit.splitBalance)
  },
}
