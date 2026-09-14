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

import {
  GRAIN_CHANNEL_SEEDS,
  GRAIN_CHANNEL_SIZES,
  MONOCHROME_GRAIN_SEEDS,
  MONOCHROME_GRAIN_SIZES,
} from '../../core/colour/grain'
import { isMonochrome } from '../../core/colour/monochrome'
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

    /*
     * One layer or three, decided by the stock rather than by the grain
     * parameters.
     *
     * Colour film has three emulsion layers that develop independently, and
     * that independence is what makes film grain coloured instead of the
     * luminance noise a sensor produces. A black and white film has ONE layer,
     * so equal seeds and equal crystal sizes are not a simplification here —
     * they are the physics, and three independent fields would put colour into a
     * photograph that has none.
     *
     * Not a foreseen case: it shipped, at a relative channel spread of 1.6e-1
     * against a tolerance of 1e-3. See `src/core/colour/grain.ts`.
     */
    const mono = isMonochrome(input.edit.monochromeMix)
    const sizes = mono ? MONOCHROME_GRAIN_SIZES : GRAIN_CHANNEL_SIZES
    const seeds = mono ? MONOCHROME_GRAIN_SEEDS : GRAIN_CHANNEL_SEEDS

    const channelSizes = locate('uGrainChannelSizes')
    if (channelSizes) gl.uniform3f(channelSizes, sizes[0], sizes[1], sizes[2])

    const channelSeeds = locate('uGrainSeeds')
    if (channelSeeds) gl.uniform3f(channelSeeds, seeds[0], seeds[1], seeds[2])
  },
}
