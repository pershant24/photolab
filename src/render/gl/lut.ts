/**
 * A one-dimensional lookup texture, for curves the shader cannot evaluate.
 *
 * WebGL2 has no 1D textures, so this is an N by 1 `TEXTURE_2D`.
 *
 * ## Format and filtering, decided rather than defaulted
 *
 * **RGBA16F**, with the value in the red channel. Half float because that is the
 * precision the rest of the pipeline carries and a curve's output is not
 * confined to `[0, 1]` — a film characteristic curve's shoulder can exceed it,
 * and an 8-bit table would clip that as well as quantising the midtones far more
 * coarsely than the interpolation error the resolution was derived against.
 *
 * Four channels rather than one, which wastes three quarters of at most 32KB.
 * R16F was tried first and produced a constant sample in the shader with no GL
 * error reported at any step, so the single-channel path is not something this
 * renderer can rely on across drivers. RGBA16F is the format every other buffer
 * in the pipeline already uses and is proven by the capability probe.
 *
 * **LINEAR filtering**, which is the whole point: the hardware interpolates
 * between samples for free. That reintroduces piecewise-linear error between
 * texels, which is exactly why `curveLutResolution` derives the sample count
 * from the curve's second derivative rather than picking a round number.
 *
 * **CLAMP_TO_EDGE**, so that an input outside the control point range holds the
 * end value rather than wrapping to the other end of the curve — which is what
 * `REPEAT` would do, and it would turn a highlight into a shadow.
 */

/** A curve baked to the GPU, with the shape the shader needs to sample it. */
export interface CurveLut {
  readonly texture: WebGLTexture
  /** Sample count. The shader needs it to place texel centres. */
  readonly size: number
  /** The control point range the samples span: `[first x, last x]`. */
  readonly domain: readonly [number, number]
  dispose(): void
}

export function createCurveLut(
  gl: WebGL2RenderingContext,
  samples: Float32Array,
  domain: readonly [number, number],
): CurveLut {
  const size = samples.length
  if (size < 2) throw new RangeError(`createCurveLut: need at least 2 samples, got ${size}`)

  const texture = gl.createTexture()
  if (!texture) throw new Error('createCurveLut: gl.createTexture() returned null')

  gl.bindTexture(gl.TEXTURE_2D, texture)
  const rgba = new Float32Array(size * 4)
  for (let i = 0; i < size; i++) rgba[i * 4] = samples[i] ?? 0

  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, size, 1)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, 1, gl.RGBA, gl.FLOAT, rgba)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  return {
    texture,
    size,
    domain: [domain[0], domain[1]],
    dispose() {
      gl.deleteTexture(texture)
    },
  }
}
