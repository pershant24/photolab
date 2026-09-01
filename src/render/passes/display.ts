/**
 * Display transform. The last pass, and the only one that knows what the output
 * device is.
 *
 * Its two operator stages are compile-time variants and their parameters are
 * uniforms, which is the recompile boundary in miniature: switching a stage on
 * changes the generated source and legitimately compiles, while dragging the
 * knee updates a uniform and compiles nothing.
 */

import fragmentSource from '../shaders/display.frag'

import type { Pass, RenderInput, ViewState } from './types'

/**
 * Prepended after `#version`, which the program cache adds.
 *
 * `#define` rather than a uniform branch: each of these is a different transform
 * rather than a different value, and baking them out keeps the shipping shader
 * free of branches that exist only so a test can turn them off.
 */
function defines(view: ViewState): string {
  if (view.displayMode === 'identity') return '#define DISPLAY_IDENTITY\n'
  return (
    (view.gamutCompress ? '#define GAMUT_COMPRESS\n' : '') +
    (view.toneMap ? '#define TONE_MAP\n' : '')
  )
}

export const displayPass: Pass = {
  id: 'display',
  stage: 'display',

  fragmentSource: (input: RenderInput) => defines(input.view) + fragmentSource,

  // Only the things that change the source. The knee and the threshold are
  // values, not structure, so they stay out of the key and in uniforms.
  variantKey: (input: RenderInput) =>
    input.view.displayMode === 'identity'
      ? 'identity'
      : `sdr:${input.view.gamutCompress ? 'g' : '-'}${input.view.toneMap ? 't' : '-'}`,

  enabled: () => true,

  bindUniforms(gl, locate, input) {
    const knee = locate('uToneMapKnee')
    if (knee) gl.uniform1f(knee, input.view.toneMapKnee)

    const threshold = locate('uGamutThreshold')
    if (threshold) gl.uniform1f(threshold, input.view.gamutThreshold)
  },
}
