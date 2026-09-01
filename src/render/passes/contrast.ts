/**
 * Contrast, in the grade stage.
 *
 * Grade, not scene. It is a colourist's interpretation of a developed image, so
 * it acts on what the film stage produced — which is why it is separated from
 * exposure by the lens and film stages even though the two sit next to each
 * other in the interface.
 */

import fragmentSource from '../shaders/contrast.frag'

import type { Pass } from './types'

export const contrastPass: Pass = {
  id: 'contrast',
  stage: 'grade',

  fragmentSource: () => fragmentSource,
  variantKey: () => 'default',

  /** A slope of 1 is the identity, so the pass is skipped there. */
  enabled: (input) => input.edit.contrast !== 1,

  bindUniforms(gl, locate, input) {
    const contrast = locate('uContrast')
    if (contrast) gl.uniform1f(contrast, input.edit.contrast)
  },
}
