/**
 * Display transform. The last pass, and the only one that knows what the output
 * device is.
 *
 * This pass is where the `displayMode` compile-time variant lives, and it is the
 * example the program cache is built around: switching mode changes the
 * generated source and legitimately compiles, while every runtime parameter in
 * the graph updates a uniform and compiles nothing.
 */

import fragmentSource from '../shaders/display.frag'

import type { DisplayMode, Pass, RenderState } from './types'

/**
 * Prepended after `#version`, which the program cache adds. A `#define` is the
 * correct mechanism here rather than a uniform branch: the identity path is a
 * different transform, not a different value, and baking it out keeps the
 * shipping shader free of a branch that exists only for tests.
 */
function defines(mode: DisplayMode): string {
  return mode === 'identity' ? '#define DISPLAY_IDENTITY\n' : ''
}

export const displayPass: Pass = {
  id: 'display',
  stage: 'display',

  fragmentSource: (state: RenderState) => defines(state.displayMode) + fragmentSource,

  // The one thing that changes the source, and therefore the only thing in the
  // key. If a value can change while the source stays byte-identical it belongs
  // in a uniform, and putting it here would mean recompiling to set it.
  variantKey: (state: RenderState) => state.displayMode,

  enabled: () => true,

  bindUniforms() {
    // Nothing beyond the contract yet. Tone map and gamut compression parameters
    // arrive here.
  },
}
