/**
 * The image source pass: samples the decoded proxy texture.
 *
 * It sits in the same position as the test pattern and produces the same thing —
 * encoded sRGB, as the decoder handed it over — so ingest and everything after
 * it are unaware of which source ran.
 *
 * The texture is RGBA8, not RGBA16F. Uploading 8-bit JPEG or PNG data as half
 * float doubles VRAM for no precision gain: the values are 8-bit whatever they
 * are stored in, and the ingest shader linearises them into a 16F target
 * immediately afterwards, which is where the precision is actually needed.
 */

import fragmentSource from '../shaders/imageSource.frag'

import type { Pass } from './types'

export const imageSourcePass: Pass = {
  id: 'imageSource',
  stage: 'ingest',
  isSource: true,

  fragmentSource: () => fragmentSource,
  variantKey: () => 'default',

  enabled: (_state, source) => source.kind === 'image',

  bindUniforms(gl, locate, _state, _context, source) {
    if (source.kind !== 'image') return
    const image = locate('uImage')
    if (!image) return
    // Unit 1: unit 0 belongs to the contract's uSource, and a source pass having
    // no input does not make it safe to reuse — a later pass in the same frame
    // would find the wrong texture bound.
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, source.texture)
    gl.uniform1i(image, 1)
    gl.activeTexture(gl.TEXTURE0)
  },
}
