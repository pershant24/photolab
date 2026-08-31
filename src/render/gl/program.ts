/**
 * Shader compilation and the program cache.
 *
 * ## The rule this file exists to enforce
 *
 * **Changing a parameter must never compile a shader.** Recompilation happens
 * only when the *structure* of the pass graph changes — an effect toggled on or
 * off, or a pass switching to a different compile-time variant.
 *
 * The reason is that a shader compile is tens of milliseconds and it lands in
 * the middle of a pointer drag, where it reads as the interface locking up. The
 * failure is also easy to introduce by accident: a cache key built by
 * stringifying more state than it needs will include a slider value, and then
 * every frame of a drag compiles a new program. That is why the cache exposes
 * {@link ProgramCache.compileCount} and why a test asserts the exact number of
 * compiles rather than merely that it did not grow.
 */

/** The subset of WebGL2 this module uses, so a test can supply a counting stub. */
export type ProgramGL = Pick<
  WebGL2RenderingContext,
  | 'createShader'
  | 'shaderSource'
  | 'compileShader'
  | 'getShaderParameter'
  | 'getShaderInfoLog'
  | 'deleteShader'
  | 'createProgram'
  | 'attachShader'
  | 'linkProgram'
  | 'getProgramParameter'
  | 'getProgramInfoLog'
  | 'deleteProgram'
  | 'getUniformLocation'
  | 'VERTEX_SHADER'
  | 'FRAGMENT_SHADER'
  | 'COMPILE_STATUS'
  | 'LINK_STATUS'
>

export class ShaderCompileError extends Error {
  override readonly name = 'ShaderCompileError'
}

export interface CompiledProgram {
  readonly program: WebGLProgram
  /**
   * Uniform locations are looked up once and memoised. `getUniformLocation` is a
   * synchronous driver round trip, and a pass that resolved its locations every
   * frame would pay for it on every frame.
   *
   * A `null` result is not an error: the GLSL compiler removes uniforms that do
   * not affect the output, so a pass which declares the full uniform contract
   * but uses only part of it has real nulls. Binding skips them.
   */
  uniformLocation(name: string): WebGLUniformLocation | null
}

/**
 * `#version 300 es` must be the first line of the source, before any comment or
 * blank line, so it is prepended here rather than written into every shader
 * where one stray leading newline would break the build.
 */
const GLSL_VERSION = '#version 300 es\n'

function compileShader(gl: ProgramGL, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new ShaderCompileError(`${label}: gl.createShader returned null`)

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!(gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)'
    gl.deleteShader(shader)
    throw new ShaderCompileError(`${label} failed to compile:\n${log}\n\n${numberLines(source)}`)
  }
  return shader
}

/** Shader logs cite line numbers, and a source dump without them is unusable. */
function numberLines(source: string): string {
  return source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
    .join('\n')
}

export function linkProgram(
  gl: ProgramGL,
  vertexSource: string,
  fragmentSource: string,
  label: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, GLSL_VERSION + vertexSource, `${label} vertex`)
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    GLSL_VERSION + fragmentSource,
    `${label} fragment`,
  )

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new ShaderCompileError(`${label}: gl.createProgram returned null`)
  }

  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)

  // Safe once linked: the program holds its own reference until it is deleted.
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)

  if (!(gl.getProgramParameter(program, gl.LINK_STATUS) as boolean)) {
    const log = gl.getProgramInfoLog(program) ?? '(no log)'
    gl.deleteProgram(program)
    throw new ShaderCompileError(`${label} failed to link:\n${log}`)
  }

  return program
}

/**
 * Programs keyed by pass identity plus compile-time variant.
 *
 * The variant key must contain **only** things that change the generated source:
 * a `#define`, a toggled branch, a loop bound baked in as a constant. It must
 * never contain a parameter value. If a value can change while the shader source
 * stays byte-identical, it is a uniform, and putting it in the key means
 * recompiling to set it.
 */
export class ProgramCache {
  #gl: ProgramGL
  #vertexSource: string
  #programs = new Map<string, CompiledProgram>()
  #compileCount = 0

  constructor(gl: ProgramGL, vertexSource: string) {
    this.#gl = gl
    this.#vertexSource = vertexSource
  }

  /** Programs actually built. Asserted exactly, not just for non-growth. */
  get compileCount(): number {
    return this.#compileCount
  }

  get size(): number {
    return this.#programs.size
  }

  get(passId: string, variantKey: string, fragmentSource: string): CompiledProgram {
    const key = `${passId}#${variantKey}`
    const existing = this.#programs.get(key)
    if (existing) return existing

    const program = linkProgram(this.#gl, this.#vertexSource, fragmentSource, key)
    this.#compileCount += 1

    const locations = new Map<string, WebGLUniformLocation | null>()
    const gl = this.#gl
    const compiled: CompiledProgram = {
      program,
      uniformLocation(name) {
        if (locations.has(name)) return locations.get(name) ?? null
        const location = gl.getUniformLocation(program, name)
        locations.set(name, location)
        return location
      },
    }

    this.#programs.set(key, compiled)
    return compiled
  }

  dispose(): void {
    for (const compiled of this.#programs.values()) this.#gl.deleteProgram(compiled.program)
    this.#programs.clear()
  }
}
