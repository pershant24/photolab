import { describe, expect, it } from 'vitest'

import { ProgramCache, ShaderCompileError } from '../../src/render/gl/program'
import type { ProgramGL } from '../../src/render/gl/program'
import { contrastPass } from '../../src/render/passes/contrast'
import { displayPass } from '../../src/render/passes/display'
import { exposurePass } from '../../src/render/passes/exposure'
import { ingestPass } from '../../src/render/passes/ingest'
import { testPatternPass } from '../../src/render/passes/testPattern'
import type { RenderInput } from '../../src/render/passes/types'
import { DEFAULT_VIEW_STATE } from '../../src/render/passes/types'

/**
 * A counting stand-in for the parts of WebGL2 the cache touches.
 *
 * Using a stub rather than a browser is deliberate: the assertion is about how
 * many times `compileShader` is called for a given sequence of state changes,
 * and that is a property of the cache's keying, not of any driver. A stub makes
 * it exact and makes it run in milliseconds.
 */
function stubGL(options: { linkFails?: boolean; compileFails?: boolean } = {}): ProgramGL & {
  compiles: number
  links: number
  sources: string[]
} {
  let compiles = 0
  let links = 0
  const sources: string[] = []

  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,

    createShader: () => ({}) as WebGLShader,
    shaderSource: (_shader: WebGLShader, source: string) => {
      sources.push(source)
    },
    compileShader: () => {
      compiles += 1
    },
    getShaderParameter: () => !options.compileFails,
    getShaderInfoLog: () => 'stub compile log',
    deleteShader: () => undefined,

    createProgram: () => ({}) as WebGLProgram,
    attachShader: () => undefined,
    linkProgram: () => {
      links += 1
    },
    getProgramParameter: () => !options.linkFails,
    getProgramInfoLog: () => 'stub link log',
    deleteProgram: () => undefined,

    getUniformLocation: (_program: WebGLProgram, name: string) =>
      ({ name }) as unknown as WebGLUniformLocation,

    get compiles() {
      return compiles
    },
    get links() {
      return links
    },
    sources,
  }

  return gl as unknown as ProgramGL & { compiles: number; links: number; sources: string[] }
}

const VERTEX = 'void main() { gl_Position = vec4(0.0); }'

function input(
  overrides: { displayMode?: 'sdr' | 'identity'; exposure?: number; contrast?: number } = {},
): RenderInput {
  return {
    source: { kind: 'pattern' },
    edit: { exposure: overrides.exposure ?? 0, contrast: overrides.contrast ?? 1 },
    view: { ...DEFAULT_VIEW_STATE, displayMode: overrides.displayMode ?? 'sdr' },
  }
}

describe('program cache', () => {
  it('compiles a program once and returns the same one afterwards', () => {
    const gl = stubGL()
    const cache = new ProgramCache(gl, VERTEX)

    const first = cache.get('display', 'sdr', 'frag')
    const second = cache.get('display', 'sdr', 'frag')

    expect(cache.compileCount).toBe(1)
    expect(second).toBe(first)
    // One program, two shaders.
    expect(gl.links).toBe(1)
    expect(gl.compiles).toBe(2)
  })

  it('prepends the GLSL version directive as the very first line', () => {
    // `#version` must precede everything, comments and blank lines included. It
    // is added here rather than in each shader file, where one stray leading
    // newline would break the build in a way whose error message does not say so.
    const gl = stubGL()
    new ProgramCache(gl, VERTEX).get('display', 'sdr', '// a leading comment\nvoid main() {}')

    for (const source of gl.sources) {
      expect(source.startsWith('#version 300 es\n')).toBe(true)
    }
  })

  it('compiles once per distinct variant, and only for variants actually used', () => {
    const gl = stubGL()
    const cache = new ProgramCache(gl, VERTEX)

    cache.get('display', 'sdr', 'a')
    cache.get('display', 'identity', 'b')
    cache.get('display', 'sdr', 'a')
    cache.get('display', 'identity', 'b')

    expect(cache.compileCount).toBe(2)
  })

  it('keys by pass identity as well as variant', () => {
    const gl = stubGL()
    const cache = new ProgramCache(gl, VERTEX)

    cache.get('ingest', 'default', 'a')
    cache.get('display', 'default', 'b')

    expect(cache.compileCount).toBe(2)
  })

  it('memoises uniform locations rather than asking the driver each frame', () => {
    let lookups = 0
    const base = stubGL()
    const gl: ProgramGL = {
      ...base,
      getUniformLocation: (_program: WebGLProgram, name: string) => {
        lookups += 1
        return { name }
      },
    }

    const compiled = new ProgramCache(gl, VERTEX).get('display', 'sdr', 'frag')
    for (let i = 0; i < 50; i++) compiled.uniformLocation('uResolution')

    expect(lookups).toBe(1)
  })

  it('reports the failing source with line numbers when compilation fails', () => {
    const gl = stubGL({ compileFails: true })
    const cache = new ProgramCache(gl, VERTEX)

    // A shader log cites line numbers, and a message without the numbered source
    // sends the reader to count lines by hand.
    expect(() => cache.get('display', 'sdr', 'void main() {}')).toThrow(ShaderCompileError)
    expect(() => cache.get('display', 'sdr', 'void main() {}')).toThrow(/ 1 \| #version 300 es/)
  })

  it('surfaces a link failure distinctly from a compile failure', () => {
    const gl = stubGL({ linkFails: true })
    const cache = new ProgramCache(gl, VERTEX)
    expect(() => cache.get('display', 'sdr', 'frag')).toThrow(/failed to link/)
  })
})

describe('the recompile boundary the real passes sit on', () => {
  // The rule: changing a parameter updates uniforms; only a change in graph
  // structure compiles anything. The realistic way to break it is not malice but
  // a variantKey that quietly includes a continuous value — a key built by
  // stringifying a whole state object, say — so these assert the exact compile
  // count rather than merely that it did not grow.
  //
  // Both parameters driven here are consumed by a pass, so the assertion covers
  // the real path from a slider to a program rather than an inert value.
  const PASSES = [testPatternPass, ingestPass, exposurePass, contrastPass, displayPass]

  it('compiles nothing extra across a drag of a runtime parameter', () => {
    const gl = stubGL()
    const cache = new ProgramCache(gl, VERTEX)

    for (let frame = 0; frame < 120; frame++) {
      const current = input({
        exposure: -5 + (10 * frame) / 120,
        contrast: 0.5 + frame / 120,
      })
      for (const pass of PASSES) {
        cache.get(pass.id, pass.variantKey(current), pass.fragmentSource(current))
      }
    }

    // Exactly one program per pass, for 120 frames of two moving parameters that
    // passes actually read.
    expect(cache.compileCount).toBe(PASSES.length)
  })

  it('compiles exactly once more when a compile-time variant is first used', () => {
    const gl = stubGL()
    const cache = new ProgramCache(gl, VERTEX)

    const build = (current: RenderInput): void => {
      for (const pass of PASSES) {
        cache.get(pass.id, pass.variantKey(current), pass.fragmentSource(current))
      }
    }

    build(input({ displayMode: 'sdr' }))
    expect(cache.compileCount).toBe(PASSES.length)

    build(input({ displayMode: 'identity' }))
    expect(cache.compileCount).toBe(PASSES.length + 1)

    // Returning to a variant already built compiles nothing.
    build(input({ displayMode: 'sdr' }))
    build(input({ displayMode: 'identity' }))
    expect(cache.compileCount).toBe(PASSES.length + 1)
  })

  it('gives the two display variants genuinely different source', () => {
    // If the variant key changed but the source did not, the cache would hold
    // two identical programs and the mode toggle would do nothing visible.
    const sdr = displayPass.fragmentSource(input({ displayMode: 'sdr' }))
    const identity = displayPass.fragmentSource(input({ displayMode: 'identity' }))

    expect(sdr).not.toBe(identity)
    expect(identity).toContain('#define DISPLAY_IDENTITY')
    expect(sdr).not.toContain('#define DISPLAY_IDENTITY')
  })

  it('has no pass whose variant key varies with a runtime parameter', () => {
    // Stated as a property over the whole pass list rather than as three
    // separate assertions, so a pass added later is covered without anyone
    // remembering to extend this file.
    for (const pass of PASSES) {
      const keys = new Set<string>()
      for (let i = 0; i < 50; i++) {
        keys.add(pass.variantKey(input({ exposure: -5 + (10 * i) / 50, contrast: i / 25 })))
      }
      expect(keys.size, `${pass.id} varies its variant key with an EditState value`).toBe(1)
    }
  })
})
