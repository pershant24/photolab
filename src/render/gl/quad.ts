/**
 * The one full-screen quad every pass draws.
 *
 * Every pass in this renderer is a fragment shader evaluated once per pixel over
 * the whole buffer, so the geometry is the same for all of them: four vertices
 * covering clip space, drawn as a triangle strip. One VBO and one VAO are built
 * at init and rebound for each pass.
 *
 * Only clip-space position is stored. The texture coordinate is derived in the
 * vertex shader as `position * 0.5 + 0.5`, which is exact and saves an attribute
 * — there is no case where a pass wants a UV that is not the position.
 */

export type QuadGL = Pick<
  WebGL2RenderingContext,
  | 'createVertexArray'
  | 'bindVertexArray'
  | 'deleteVertexArray'
  | 'createBuffer'
  | 'bindBuffer'
  | 'bufferData'
  | 'deleteBuffer'
  | 'enableVertexAttribArray'
  | 'vertexAttribPointer'
  | 'drawArrays'
  | 'ARRAY_BUFFER'
  | 'STATIC_DRAW'
  | 'FLOAT'
  | 'TRIANGLE_STRIP'
>

/** Clip-space corners, in triangle-strip order. */
const QUAD_VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])

/** Must match the `layout(location = 0)` on the position input in `quad.vert`. */
export const QUAD_POSITION_LOCATION = 0

export interface FullScreenQuad {
  bind(): void
  draw(): void
  dispose(): void
}

export function createFullScreenQuad(gl: QuadGL): FullScreenQuad {
  const vao = gl.createVertexArray()
  if (!vao) throw new Error('createFullScreenQuad: gl.createVertexArray() returned null')

  const buffer = gl.createBuffer()
  if (!buffer) {
    gl.deleteVertexArray(vao)
    throw new Error('createFullScreenQuad: gl.createBuffer() returned null')
  }

  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(QUAD_POSITION_LOCATION)
  gl.vertexAttribPointer(QUAD_POSITION_LOCATION, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  return {
    bind() {
      gl.bindVertexArray(vao)
    },
    draw() {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    dispose() {
      gl.deleteBuffer(buffer)
      gl.deleteVertexArray(vao)
    },
  }
}
