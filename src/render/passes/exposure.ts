/**
 * Exposure, in the scene stage.
 *
 * Scene, not grade: exposure describes the light arriving at the lens, so it
 * must happen before anything the lens does to it. See the stage ordering in
 * docs/COLOUR_PIPELINE.md.
 */

import fragmentSource from '../shaders/exposure.frag'

import type { Pass } from './types'

export const exposurePass: Pass = {
  id: 'exposure',
  stage: 'scene',

  fragmentSource: () => fragmentSource,
  variantKey: () => 'default',

  // Zero stops is a multiply by one. Skipping the pass entirely saves a
  // full-screen draw and a buffer, and it is the only thing `EditState`
  // legitimately changes about graph structure. The program is compiled the
  // first time the slider leaves zero and cached from then on, so crossing zero
  // repeatedly during a drag costs one compile in total.
  enabled: (input) => input.edit.exposure !== 0,

  bindUniforms(gl, locate, input) {
    const exposure = locate('uExposure')
    if (exposure) gl.uniform1f(exposure, input.edit.exposure)
  },
}
