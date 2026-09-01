/**
 * Uploading a decoded image as the source texture.
 */

import type { RenderCapabilities } from './context'
import { onScratchUnit } from './textureUnits'

export class SourceTooLargeError extends Error {
  override readonly name = 'SourceTooLargeError'
}

/**
 * Upload an `ImageBitmap` as an immutable RGBA8 texture.
 *
 * RGBA8, not RGBA16F: the data is 8-bit whatever it is stored in, so half float
 * would double VRAM for no precision gain. Linearisation happens in the ingest
 * shader, whose target *is* 16F, which is where the precision is needed.
 *
 * The vertical flip is **not** done here with `UNPACK_FLIP_Y_WEBGL`, and that is
 * a correction rather than a preference. An `ImageBitmap`'s origin is top-left
 * while a GL texture's is bottom-left, so something must flip; but WebGL2
 * specifies that `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL` do
 * not apply to an `ImageBitmap` source, and setting it here was watched to have
 * no effect — the image simply rendered upside down, with `gl.getError()`
 * reporting nothing. The flip is therefore done in `imageSource.frag`, where it
 * is one line and cannot be silently ignored. Only that pass samples this
 * texture, so the correction has exactly one site.
 *
 * The size guard should be unreachable for the interactive path, because the
 * decoder resizes to roughly 2048px on the long edge before this is ever called.
 * It stays because "should be unreachable" and "is unreachable" differ by one
 * refactor, and the failure it prevents is an incomplete texture that renders
 * black with no error.
 */
export function uploadImageTexture(
  gl: WebGL2RenderingContext,
  capabilities: RenderCapabilities,
  bitmap: ImageBitmap,
): WebGLTexture {
  const limit = capabilities.maxTextureSize
  if (bitmap.width > limit || bitmap.height > limit) {
    throw new SourceTooLargeError(
      `That image is ${bitmap.width}x${bitmap.height}, and this device cannot hold a ` +
        `texture larger than ${limit}x${limit}.`,
    )
  }

  // On the scratch unit: uploading binds, and binding on a sampled unit would
  // silently replace whatever a pass was about to read. See textureUnits.ts.
  return onScratchUnit(gl, () => {
    const texture = gl.createTexture()
    if (!texture) throw new Error('uploadImageTexture: gl.createTexture() returned null')

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, bitmap.width, bitmap.height)
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, bitmap.width, bitmap.height, gl.RGBA, gl.UNSIGNED_BYTE, bitmap,
    )

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)

    return texture
  })
}
