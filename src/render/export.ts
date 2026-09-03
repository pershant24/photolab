/**
 * Full-resolution export, in tiles.
 *
 * The first time tiling is real rather than a harness. Every spatial pass
 * declares an overlap and every one has been tested, but always against a
 * fixture chosen to exercise it; here grain determinism across boundaries, the
 * vignette's frame position, distortion's radial overlap and two Gaussian
 * kernels all have to hold simultaneously, at full resolution, on a source that
 * may exceed `MAX_TEXTURE_SIZE`.
 *
 * # Why a tile is not just a small render
 *
 * Three things distinguish an export tile from the interactive path, and each is
 * a place the pipeline could be wrong without preview showing it:
 *
 * - **The buffer covers a region, not the frame.** `uSourceRect` says which, and
 *   every spatial parameter converts through it. On a full-frame render the
 *   correct conversion and several incorrect ones coincide exactly.
 * - **The texture holds a region too, and a different one.** A tile is rendered
 *   from a texture containing that tile plus its overlap, so `textureRect` and
 *   `uSourceRect` are both needed and are not equal.
 * - **The source may not fit on the GPU at all.** `MAX_TEXTURE_SIZE` is 8192 on
 *   the software rasteriser, and a 60MP frame is 9600 across.
 */

import type { RenderContext } from './gl/context'
import type { RenderGraph } from './graph'
import type { EditState } from '../core/state/editState'
import type { RenderInput, ViewState } from './passes/types'

export interface ExportOptions {
  readonly format: 'image/jpeg' | 'image/png'
  /** JPEG only; ignored for PNG, which is lossless. */
  readonly quality?: number
  /** Called after each tile. `total` is fixed before the first call. */
  readonly onProgress?: (done: number, total: number) => void
  /**
   * Force an overlap instead of asking the graph for one.
   *
   * Exists so the tiling can be tested against a deliberately wrong value: a
   * tiling test that cannot produce a seam proves only that the code ran. Not a
   * user-facing control, and there is no setting for which a wrong overlap is a
   * reasonable trade.
   */
  readonly overlap?: number
  /**
   * Force a tile size instead of deriving one from `MAX_TEXTURE_SIZE`.
   *
   * Exists so a source too large to render whole can still be checked: two
   * exports at different tile sizes put their seams in different places, so
   * agreement between them is evidence no seam exists. There is no whole-frame
   * reference to compare against when the frame does not fit on the GPU.
   */
  readonly tileSize?: number
}

export interface ExportResult {
  readonly blob: Blob
  readonly width: number
  readonly height: number
  readonly tiles: number
  readonly overlap: number
  readonly milliseconds: number
  /** Which upload path was used. See `tests/probe/texture-size.spec.ts`. */
  readonly uploadPath: 'pixel-store' | 'crop-rectangle'
}

export class ExportError extends Error {}

/**
 * The largest tile worth using, given the device and the memory it implies.
 *
 * Bounded by `MAX_TEXTURE_SIZE` rather than being a constant, because that is
 * the actual limit and it varies by a factor of two across the two devices
 * measured. Halved from it because a tile needs a *texture* of `tile + 2 *
 * overlap` and several RGBA16F intermediates of the tile's own size — at 8192
 * with a large overlap the texture alone would exceed the limit it was derived
 * from.
 *
 * Floored so that a pathological overlap cannot drive the tile size to nothing
 * and the tile count to the millions.
 */
export function tileSizeFor(maxTextureSize: number, overlap: number): number {
  const usable = Math.floor(maxTextureSize / 2) - 2 * overlap
  return Math.max(512, Math.min(2048, usable))
}

/** The tiles covering an image, each with its own expanded read region. */
export function planTiles(
  width: number,
  height: number,
  tile: number,
  overlap: number,
): { output: [number, number, number, number]; read: [number, number, number, number] }[] {
  const plan: {
    output: [number, number, number, number]
    read: [number, number, number, number]
  }[] = []
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) {
      const w = Math.min(tile, width - x)
      const h = Math.min(tile, height - y)
      // The read region is the output region grown by the overlap and clamped to
      // the image. Clamped rather than padded: outside the frame there is no
      // data, and `CLAMP_TO_EDGE` is what the whole-frame render does there too,
      // so clamping is what makes a tile agree with it rather than differ.
      const rx = Math.max(0, x - overlap)
      const ry = Math.max(0, y - overlap)
      const rw = Math.min(width, x + w + overlap) - rx
      const rh = Math.min(height, y + h + overlap) - ry
      plan.push({ output: [x, y, w, h], read: [rx, ry, rw, rh] })
    }
  }
  return plan
}

/** Upload a sub-rect of `bitmap` using pixel store parameters. No re-decode. */
function uploadSubRect(
  gl: WebGL2RenderingContext,
  bitmap: ImageBitmap,
  rect: readonly [number, number, number, number],
): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) throw new ExportError('could not create a tile texture')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, bitmap.width)
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, rect[0])
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, rect[1])
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rect[2], rect[3], 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
  return texture
}

/** Upload a sub-rect by decoding it. Slower, and needs no full-resolution bitmap. */
async function uploadCrop(
  gl: WebGL2RenderingContext,
  blob: Blob,
  rect: readonly [number, number, number, number],
): Promise<WebGLTexture> {
  const bitmap = await createImageBitmap(blob, rect[0], rect[1], rect[2], rect[3], {
    imageOrientation: 'from-image',
    colorSpaceConversion: 'none',
  })
  const texture = gl.createTexture()
  if (!texture) throw new ExportError('could not create a tile texture')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
  bitmap.close()
  return texture
}

/**
 * An RGBA8 target the export owns, reused across every tile.
 *
 * Its own allocation rather than a format parameter on the shared pool. The pool
 * keys on size alone and every existing caller expects RGBA16F from it; adding a
 * format would make every target it hands out format-ambiguous, and the failure
 * — a 16F target used where 8-bit was wanted — is exactly the kind that produces
 * plausible pixels.
 *
 * RGBA8 because `readPixels` cannot portably return `UNSIGNED_BYTE` from a
 * RGBA16F framebuffer: its implementation-defined read type is `HALF_FLOAT`.
 */
interface ResolveTarget {
  readonly framebuffer: WebGLFramebuffer
  readonly texture: WebGLTexture
  readonly width: number
  readonly height: number
}

function createResolveTarget(gl: WebGL2RenderingContext, width: number, height: number): ResolveTarget {
  const texture = gl.createTexture()
  const framebuffer = gl.createFramebuffer()
  if (!texture || !framebuffer) throw new ExportError('could not allocate the resolve target')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new ExportError(`RGBA8 resolve target incomplete (0x${status.toString(16)})`)
  }
  return { framebuffer, texture, width, height }
}

/**
 * Render an image at full resolution and encode it.
 *
 * The overlap is the **maximum over the passes that are actually enabled at
 * these parameters**, asked of the graph rather than assumed. A constant would
 * be wrong in both directions: too small for a wide diffusion and absurd for a
 * frame with every effect off.
 */
export async function exportImage(
  context: RenderContext,
  graph: RenderGraph,
  blob: Blob,
  edit: EditState,
  view: ViewState,
  sourceWidth: number,
  sourceHeight: number,
  options: ExportOptions,
): Promise<ExportResult> {
  const started = performance.now()
  const gl = context.gl
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number

  // The overlap has to be known before the tile size, because the tile's texture
  // is the tile plus twice the overlap and that is what must fit.
  const probeInput: RenderInput = {
    source: {
      kind: 'image',
      texture: null as unknown as WebGLTexture,
      width: sourceWidth,
      height: sourceHeight,
      sourceWidth,
      sourceHeight,
      textureRect: [0, 0, sourceWidth, sourceHeight],
    },
    edit,
    view,
  }
  const overlap = options.overlap ?? graph.requiredOverlap(probeInput)
  const tile = options.tileSize ?? tileSizeFor(maxTextureSize, overlap)
  const plan = planTiles(sourceWidth, sourceHeight, tile, overlap)

  // The fast path needs the whole image resident, about 246MB for 60MP. If that
  // decode throws there is nothing to fall back on but decoding per tile, which
  // is the honest trigger: memory pressure is not observable, this failure is.
  let full: ImageBitmap | null = null
  let uploadPath: ExportResult['uploadPath'] = 'pixel-store'
  try {
    full = await createImageBitmap(blob, {
      imageOrientation: 'from-image',
      colorSpaceConversion: 'none',
    })
  } catch {
    uploadPath = 'crop-rectangle'
  }

  const canvas = new OffscreenCanvas(sourceWidth, sourceHeight)
  const canvasContext = canvas.getContext('2d')
  if (!canvasContext) throw new ExportError('could not create an output canvas')

  // Sized for the largest expanded region any tile will need, since the buffer
  // now covers the overlap rather than just the tile.
  const resolveSize = Math.min(maxTextureSize, tile + 2 * overlap)
  const resolve = createResolveTarget(gl, resolveSize, resolveSize)
  const pixels = new Uint8ClampedArray(tile * tile * 4)

  try {
    options.onProgress?.(0, plan.length)
    for (const [index, { output, read }] of plan.entries()) {
      const texture =
        full !== null
          ? uploadSubRect(gl, full, read)
          : await uploadCrop(gl, blob, read)

      const input: RenderInput = {
        source: {
          kind: 'image',
          texture,
          width: read[2],
          height: read[3],
          sourceWidth,
          sourceHeight,
          // What the texture holds — the expanded region, not the output region.
          textureRect: read,
        },
        edit,
        view,
      }

      // The buffer covers the EXPANDED region, not the tile's own.
      //
      // This is the point of the overlap and it was originally wrong here: the
      // buffer was sized to the output, so the margin existed only in the source
      // texture and only `imageSource` could benefit from it. Every pass after
      // it read a buffer that stopped at the tile edge and clamped, which is
      // exactly the seam the overlap is for.
      graph.render(
        input,
        {
          resolution: [read[2], read[3]],
          imageSize: [sourceWidth, sourceHeight],
          sourceRect: read,
        },
        { finalTarget: resolve },
      )

      // Read back only the tile's own region from inside the expanded render.
      // `readPixels` is bottom-up, so the output's bottom edge sits at
      // `readHeight - (offsetFromReadTop + outputHeight)` in buffer rows.
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolve.framebuffer)
      const insetX = output[0] - read[0]
      const insetY = read[3] - (output[1] - read[1]) - output[3]
      const view8 = pixels.subarray(0, output[2] * output[3] * 4)
      gl.readPixels(insetX, insetY, output[2], output[3], gl.RGBA, gl.UNSIGNED_BYTE, view8)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteTexture(texture)

      // readPixels is bottom-up; the canvas is top-down. Flipped row by row here
      // rather than by the caller, so no consumer of an export ever has to know.
      const flipped = new Uint8ClampedArray(output[2] * output[3] * 4)
      const stride = output[2] * 4
      for (let row = 0; row < output[3]; row++) {
        flipped.set(
          view8.subarray((output[3] - 1 - row) * stride, (output[3] - row) * stride),
          row * stride,
        )
      }
      canvasContext.putImageData(new ImageData(flipped, output[2], output[3]), output[0], output[1])
      options.onProgress?.(index + 1, plan.length)
    }
  } finally {
    full?.close()
    gl.deleteFramebuffer(resolve.framebuffer)
    gl.deleteTexture(resolve.texture)
  }

  const encoded = await canvas.convertToBlob({
    type: options.format,
    ...(options.format === 'image/jpeg' ? { quality: options.quality ?? 0.92 } : {}),
  })

  return {
    blob: encoded,
    width: sourceWidth,
    height: sourceHeight,
    tiles: plan.length,
    overlap,
    milliseconds: performance.now() - started,
    uploadPath,
  }
}
