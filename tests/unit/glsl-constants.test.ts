import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CONTRAST_PIVOT_ACESCCT } from '../../src/core/colour/grade'
import { ACESCG_TO_SRGB, SRGB_TO_ACESCG } from '../../src/core/colour/matrices'
import {
  ACESCCT_A,
  ACESCCT_B,
  ACESCCT_LOG_OFFSET,
  ACESCCT_LOG_SCALE,
  ACESCCT_MAX_ENCODED,
  ACESCCT_MAX_LINEAR,
  ACESCCT_X_BRK,
  ACESCCT_Y_BRK,
  SRGB_ALPHA,
  SRGB_ENCODED_BREAK,
  SRGB_GAMMA,
  SRGB_LINEAR_BREAK,
  SRGB_SLOPE,
} from '../../src/core/colour/transfer'
import type { Mat3 } from '../../src/core/colour/types'

/**
 * Every numeric constant in the shared shader library, checked against the
 * TypeScript it was generated from.
 *
 * GLSL cannot compute these: a `const` initialiser must be a constant
 * expression, so `log2(65504.0)` and `encodeACEScct(0.18)` have to be written as
 * literals. That makes them the one category of transcribed value the project
 * cannot design away, so it is guarded directly instead.
 *
 * The agreement tests do catch a wrong literal, but only obliquely: a shader
 * would disagree with the reference somewhere, and the failure would name a
 * patch and a channel rather than a constant. This names the constant.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/render/shaders/lib/colour.glsl', import.meta.url)),
  'utf8',
)

function glslFloat(name: string): number {
  const match = new RegExp(`const\\s+float\\s+${name}\\s*=\\s*(-?[0-9.eE+-]+)\\s*;`).exec(SOURCE)
  if (!match?.[1]) throw new Error(`colour.glsl has no "const float ${name}"`)
  return Number(match[1])
}

function glslMat3(name: string): number[] {
  const match = new RegExp(`const\\s+mat3\\s+${name}\\s*=\\s*mat3\\(([^)]*)\\)`, 's').exec(SOURCE)
  if (!match?.[1]) throw new Error(`colour.glsl has no "const mat3 ${name}"`)
  return match[1]
    .split(',')
    .map((part) => part.replace(/\/\/.*$/gm, '').trim())
    .filter((part) => part.length > 0)
    .map(Number)
}

describe('shader constants match their TypeScript source', () => {
  it.each([
    ['SRGB_ENCODED_BREAK', SRGB_ENCODED_BREAK],
    ['SRGB_LINEAR_BREAK', SRGB_LINEAR_BREAK],
    ['SRGB_SLOPE', SRGB_SLOPE],
    ['SRGB_ALPHA', SRGB_ALPHA],
    ['SRGB_GAMMA', SRGB_GAMMA],
    ['ACESCCT_X_BRK', ACESCCT_X_BRK],
    ['ACESCCT_Y_BRK', ACESCCT_Y_BRK],
    ['ACESCCT_A', ACESCCT_A],
    ['ACESCCT_B', ACESCCT_B],
    ['ACESCCT_LOG_OFFSET', ACESCCT_LOG_OFFSET],
    ['ACESCCT_LOG_SCALE', ACESCCT_LOG_SCALE],
    ['ACESCCT_MAX_LINEAR', ACESCCT_MAX_LINEAR],
  ])('%s', (name, expected) => {
    expect(glslFloat(name)).toBe(expected)
  })

  it.each([
    // Computed values, which GLSL cannot evaluate at compile time. These are the
    // ones that can silently drift, and the two that matter most: the pivot
    // decides where contrast turns, and the clamp decides where the encoding
    // saturates.
    ['ACESCCT_MAX_ENCODED', ACESCCT_MAX_ENCODED],
    ['CONTRAST_PIVOT_ACESCCT', CONTRAST_PIVOT_ACESCCT],
  ])('%s, to the precision it is written at', (name, expected) => {
    // Written to ten decimal places, so the comparison is at that precision
    // rather than exact.
    expect(glslFloat(name)).toBeCloseTo(expected, 9)
  })

  it.each([
    ['SRGB_TO_ACESCG', SRGB_TO_ACESCG],
    ['ACESCG_TO_SRGB', ACESCG_TO_SRGB],
  ])('%s, transposed into GLSL column-major order', (name, expected: Mat3) => {
    // GLSL's mat3() fills columns; the TypeScript stores rows. The literal in
    // the shader is therefore the transpose, and getting that wrong produces a
    // plausible image with wrong colour — the exact defect the round trip cannot
    // see, so it is worth catching here as well as through the two legs.
    const columnMajor = glslMat3(name)
    expect(columnMajor).toHaveLength(9)
    for (let column = 0; column < 3; column++) {
      for (let row = 0; row < 3; row++) {
        expect(
          columnMajor[column * 3 + row],
          `${name} column ${column} row ${row}`,
        ).toBeCloseTo(expected[row * 3 + column] ?? Number.NaN, 9)
      }
    }
  })
})
