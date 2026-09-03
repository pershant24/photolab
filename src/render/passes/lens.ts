/**
 * The lens stage: distortion, chromatic aberration, diffusion, vignette.
 *
 * In that physical order. Light is bent by the glass before it is split by
 * wavelength, scattered on the way through, and finally falls off toward the
 * corners because of where the aperture is — so distortion and aberration are
 * geometry, diffusion is scattering, and the vignette is illumination.
 *
 * Three of the four declare overlap, and they declare it for two different
 * reasons. Distortion and aberration MOVE pixels, so a tile reads from a position
 * that may lie outside itself and the offset grows with radius. Diffusion has a
 * kernel, like halation. The vignette declares none and is still not position
 * independent, which is the distinction the worked example in ARCHITECTURE.md
 * section 11 exists to make.
 */

import aberrationSource from '../shaders/aberration.frag'
import diffusionBlurSource from '../shaders/diffusionBlur.frag'
import diffusionCompositeSource from '../shaders/diffusionComposite.frag'
import distortionSource from '../shaders/distortion.frag'
import vignetteSource from '../shaders/vignette.frag'

import {
  VIGNETTE_REACH,
  aberrationOverlap,
  distortionOverlap,
} from '../../core/colour/lens'
import type { Pass, RenderInput } from './types'

/** The source's dimensions, or null when there is no image to measure against. */
function sourceSize(input: RenderInput): { width: number; height: number } | null {
  if (input.source.kind !== 'image') return null
  return { width: input.source.sourceWidth, height: input.source.sourceHeight }
}

export const distortionPass: Pass = {
  id: 'distortion',
  stage: 'lens',
  fragmentSource: () => distortionSource,
  variantKey: () => 'default',
  enabled: (input) => input.edit.distortion !== 0,
  overlap(input) {
    const size = sourceSize(input)
    if (!size || input.edit.distortion === 0) return 0
    return distortionOverlap(input.edit.distortion, size.width, size.height)
  },
  bindUniforms(gl, locate, input) {
    const location = locate('uDistortion')
    if (location) gl.uniform1f(location, input.edit.distortion)
  },
}

export const aberrationPass: Pass = {
  id: 'aberration',
  stage: 'lens',
  fragmentSource: () => aberrationSource,
  variantKey: () => 'default',
  enabled: (input) => input.edit.aberration !== 0,
  overlap(input) {
    const size = sourceSize(input)
    if (!size || input.edit.aberration === 0) return 0
    return aberrationOverlap(input.edit.aberration, size.width, size.height)
  },
  bindUniforms(gl, locate, input) {
    const location = locate('uAberration')
    if (location) gl.uniform1f(location, input.edit.aberration)
  },
}

const DIFFUSION_ORIGINAL = 'diffusionSource'
const DIFFUSION_ORIGINAL_UNIT = 5

const diffusionEnabled = (input: RenderInput): boolean =>
  input.edit.diffusionStrength > 0 && input.edit.diffusionRadius > 0

function diffusionKernelOverlap(input: RenderInput): number {
  if (!diffusionEnabled(input)) return 0
  const size = sourceSize(input)
  if (!size) return 0
  const longEdge = Math.max(size.width, size.height)
  return Math.ceil(input.edit.diffusionRadius * longEdge) + 1
}

function diffusionBlurPass(id: string, direction: readonly [number, number]): Pass {
  return {
    id,
    stage: 'lens',
    fragmentSource: () => diffusionBlurSource,
    variantKey: () => 'default',
    enabled: diffusionEnabled,
    overlap: diffusionKernelOverlap,
    bindUniforms(gl, locate, input) {
      const radius = locate('uDiffusionRadius')
      if (radius) gl.uniform1f(radius, input.edit.diffusionRadius)
      const directionUniform = locate('uBlurDirection')
      if (directionUniform) gl.uniform2f(directionUniform, direction[0], direction[1])
    },
  }
}

/** The image as it stands before the blur, which the composite adds back to. */
export const diffusionBlurHorizontalPass: Pass = {
  ...diffusionBlurPass('diffusionBlurH', [1, 0]),
  retainInputAs: DIFFUSION_ORIGINAL,
}
export const diffusionBlurVerticalPass = diffusionBlurPass('diffusionBlurV', [0, 1])

export const diffusionCompositePass: Pass = {
  id: 'diffusionComposite',
  stage: 'lens',
  auxiliaryInput: {
    key: DIFFUSION_ORIGINAL,
    sampler: 'uOriginal',
    unit: DIFFUSION_ORIGINAL_UNIT,
  },
  fragmentSource: () => diffusionCompositeSource,
  variantKey: () => 'default',
  enabled: diffusionEnabled,
  bindUniforms(gl, locate, input) {
    const strength = locate('uDiffusionStrength')
    if (strength) gl.uniform1f(strength, input.edit.diffusionStrength)
  },
}

export const vignettePass: Pass = {
  id: 'vignette',
  stage: 'lens',
  fragmentSource: () => vignetteSource,
  variantKey: () => 'default',
  // Zero at the identity, and the identity is exact: mix(1, f, 0) is 1.
  enabled: (input) => input.edit.vignette !== 0,
  // No overlap. It reads no neighbouring pixel — and it is still not position
  // independent, because it needs to know where the tile sits in the frame.
  bindUniforms(gl, locate, input) {
    const amount = locate('uVignetteAmount')
    if (amount) gl.uniform1f(amount, input.edit.vignette)
    const reach = locate('uVignetteReach')
    if (reach) gl.uniform1f(reach, VIGNETTE_REACH)
  },
}

/** In physical order: glass bends, then splits, then scatters, then falls off. */
export const LENS_PASSES: readonly Pass[] = [
  distortionPass,
  aberrationPass,
  diffusionBlurHorizontalPass,
  diffusionBlurVerticalPass,
  diffusionCompositePass,
  vignettePass,
]
