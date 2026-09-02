/**
 * Banded hue, saturation and luminance, in the grade stage after the wheels.
 *
 * Pointwise, so no overlap and no tiling margin.
 */

import hslSource from '../shaders/hsl.frag'

import { HSL_BAND_COUNT, isHslIdentity } from '../../core/colour/hsl'
import type { Pass, RenderInput } from './types'

const enabled = (input: RenderInput): boolean =>
  !isHslIdentity(input.edit.hslHue) ||
  !isHslIdentity(input.edit.hslSaturation) ||
  !isHslIdentity(input.edit.hslLuminance)

export const hslPass: Pass = {
  id: 'hsl',
  stage: 'grade',

  fragmentSource: () => hslSource,
  variantKey: () => 'default',
  enabled,

  bindUniforms(gl, locate, input) {
    const bind = (name: string, value: readonly number[]): void => {
      const location = locate(name)
      if (!location) return
      const padded = new Float32Array(HSL_BAND_COUNT)
      for (let i = 0; i < HSL_BAND_COUNT; i++) padded[i] = value[i] ?? 0
      gl.uniform1fv(location, padded)
    }
    bind('uHslHue', input.edit.hslHue)
    bind('uHslSaturation', input.edit.hslSaturation)
    bind('uHslLuminance', input.edit.hslLuminance)
  },
}
