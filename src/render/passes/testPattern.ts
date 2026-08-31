/**
 * The source pass: generates the test pattern instead of sampling an image.
 *
 * It occupies the ingest stage's input position, which is where the decoded
 * image texture goes in Part C. Everything downstream is unaware of the
 * difference, because what it produces is what a decoded image is: encoded sRGB.
 */

import fragmentSource from '../shaders/testPattern.frag'

import { PATCH_COUNT, patchUniformArray } from '../testPattern'
import type { Pass } from './types'

const PATCHES = patchUniformArray()

export const testPatternPass: Pass = {
  id: 'testPattern',
  stage: 'ingest',
  isSource: true,

  fragmentSource: () => fragmentSource,

  // Nothing about this pass's source varies, so every state shares one program.
  variantKey: () => 'default',

  enabled: () => true,

  bindUniforms(gl, locate, state) {
    const patches = locate(`uPatches[0]`)
    if (patches) gl.uniform3fv(patches, PATCHES, 0, PATCH_COUNT * 3)

    const phase = locate('uPatternPhase')
    if (phase) gl.uniform1f(phase, state.patternPhase)
  },
}
