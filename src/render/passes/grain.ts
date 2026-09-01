/**
 * Grain, registered in the **film** stage **after** the characteristic curves.
 *
 * The ordering is the effect. Grain magnitude depends on developed density, and
 * density is what the curves produce — before them there is exposure, which is a
 * different quantity and modulating against it would put grain in the wrong
 * places. That is why this is the last pass of the film stage rather than an
 * overlay near the end of the chain, which is where most implementations put it
 * and why theirs reads as digital noise.
 *
 * No `overlap`: grain is per-pixel with no kernel, so a tile needs no margin. It
 * still depends on `uSourceRect`, and for a different reason — the noise is a
 * function of the *source* coordinate, so that a tile computes the same value at
 * a given source pixel as the whole frame does.
 */

import grainSource from '../shaders/grain.frag'

import { GRAIN_CHANNEL_SIZES } from '../../core/colour/grain'
import type { Pass, RenderInput } from './types'

const enabled = (input: RenderInput): boolean =>
  input.edit.grainStrength > 0 && input.edit.grainSize > 0

export const grainPass: Pass = {
  id: 'grain',
  stage: 'film',

  fragmentSource: () => grainSource,
  variantKey: () => 'default',
  enabled,

  bindUniforms(gl, locate, input) {
    const strength = locate('uGrainStrength')
    if (strength) gl.uniform1f(strength, input.edit.grainStrength)

    const size = locate('uGrainSize')
    if (size) gl.uniform1f(size, input.edit.grainSize)

    const channelSizes = locate('uGrainChannelSizes')
    if (channelSizes) {
      gl.uniform3f(
        channelSizes,
        GRAIN_CHANNEL_SIZES[0],
        GRAIN_CHANNEL_SIZES[1],
        GRAIN_CHANNEL_SIZES[2],
      )
    }
  },
}
