/**
 * Halation: three passes that together isolate the highlights, scatter them and
 * add them back, tinted red.
 *
 * Registered in the **film** stage, **before** the characteristic curves.
 * Halation is an exposure effect — light reaching the emulsion in addition to
 * what formed the image — so it happens before the curves turn exposure into
 * density, not after.
 *
 * Three passes rather than one because the blur is **separable**: two
 * one-dimensional kernels cost O(r) taps per pixel where a two-dimensional one
 * costs O(r²), for an identical result. The composite then needs the image as it
 * was *before* the highlights were isolated, which the straight chain no longer
 * holds — hence `retainInputAs` on the first pass and `auxiliaryInput` on the
 * last.
 */

import thresholdSource from '../shaders/halationThreshold.frag'
import blurSource from '../shaders/halationBlur.frag'
import compositeSource from '../shaders/halationComposite.frag'

import { HALATION_TINT, halationThresholdLinear } from '../../core/colour/halation'
import type { Pass, RenderInput } from './types'

/** The key the pre-halation image is retained under. */
const ORIGINAL = 'halationSource'

/** Texture unit for the retained original. Above the curve units. */
const ORIGINAL_UNIT = 6

const enabled = (input: RenderInput): boolean =>
  input.edit.halationStrength > 0 && input.edit.halationRadius > 0

/**
 * Tile overlap, in **source pixels**: the full extent of the kernel.
 *
 * The blur reaches `radius` in each direction and its taps stop there, so a tile
 * must carry that much margin or the kernel reads past the edge of what it has
 * and the seam shows. A **function of the radius** rather than a constant,
 * because the extent is the radius — a constant would be wrong at large radii
 * and wasteful at small ones.
 *
 * Taken from the source's own dimensions rather than from the buffer being
 * rendered, because overlap is a property of the tiling of the source image and
 * has to mean the same thing whatever resolution a tile happens to be drawn at.
 *
 * One pixel of margin covers the rounding when a fractional radius meets an
 * integer tile boundary.
 */
function kernelOverlap(input: RenderInput): number {
  if (!enabled(input)) return 0
  if (input.source.kind !== 'image') return 0
  const sourceLongEdge = Math.max(input.source.sourceWidth, input.source.sourceHeight)
  return Math.ceil(input.edit.halationRadius * sourceLongEdge) + 1
}

export const halationThresholdPass: Pass = {
  id: 'halationThreshold',
  stage: 'film',
  // The image as it stands now is what the composite has to add the halo back
  // to, and by then it is three passes upstream.
  retainInputAs: ORIGINAL,

  fragmentSource: () => thresholdSource,
  variantKey: () => 'default',
  enabled,

  bindUniforms(gl, locate, input) {
    const threshold = locate('uHalationThreshold')
    if (threshold) gl.uniform1f(threshold, halationThresholdLinear(input.edit.halationThreshold))
  },
}

/** One program, two draws, differing by a direction vector. */
function blurPass(id: string, direction: readonly [number, number]): Pass {
  return {
    id,
    stage: 'film',
    fragmentSource: () => blurSource,
    variantKey: () => 'default',
    enabled,

    overlap: kernelOverlap,

    bindUniforms(gl, locate, input) {
      const radius = locate('uHalationRadius')
      if (radius) gl.uniform1f(radius, input.edit.halationRadius)

      const directionUniform = locate('uBlurDirection')
      if (directionUniform) gl.uniform2f(directionUniform, direction[0], direction[1])
    },
  }
}

export const halationBlurHorizontalPass = blurPass('halationBlurH', [1, 0])
export const halationBlurVerticalPass = blurPass('halationBlurV', [0, 1])

export const halationCompositePass: Pass = {
  id: 'halationComposite',
  stage: 'film',
  auxiliaryInput: { key: ORIGINAL, sampler: 'uOriginal', unit: ORIGINAL_UNIT },

  fragmentSource: () => compositeSource,
  variantKey: () => 'default',
  enabled,

  bindUniforms(gl, locate, input) {
    const strength = locate('uHalationStrength')
    if (strength) gl.uniform1f(strength, input.edit.halationStrength)

    const tint = locate('uHalationTint')
    if (tint) gl.uniform3f(tint, HALATION_TINT[0], HALATION_TINT[1], HALATION_TINT[2])
  },
}

export const HALATION_PASSES: readonly Pass[] = [
  halationThresholdPass,
  halationBlurHorizontalPass,
  halationBlurVerticalPass,
  halationCompositePass,
]
