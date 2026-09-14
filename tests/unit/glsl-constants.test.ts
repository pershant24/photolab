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
import {
  DATE_STAMP_HEIGHT,
  DATE_STAMP_SLANT,
  DIGIT_SEGMENTS,
  SEGMENT_BOXES,
  TICK_CENTRE,
  TICK_HALF,
} from '../../src/core/colour/dateStamp'
import { GRADUATED_MIN_WIDTH } from '../../src/core/colour/graduated'
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

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/render/shaders/lib/${name}`, import.meta.url)), 'utf8')

const SOURCE = read('colour.glsl')
const GRADUATED_SOURCE = read('graduated.glsl')
const DATE_STAMP_SOURCE = read('dateStamp.glsl')

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

/**
 * The glyph geometry, checked the same way and for a slightly different reason.
 *
 * These are not values GLSL cannot compute — most of them it could. They are
 * transcribed because the shader needs them as compile-time constants in an
 * array initialiser, and `SEGMENT_BOXES` in particular is derived arithmetic
 * written out as forty-two literals.
 *
 * A wrong one there does not produce a wrong colour or a failed agreement test.
 * It produces a digit with a segment in the wrong place, which every test in the
 * suite passes happily and only a person looking at the picture would catch.
 * That is the worst kind of defect to leave to review, so it is checked.
 */
describe('the seven-segment geometry matches its TypeScript source', () => {
  const floatIn = (source: string, name: string): number => {
    const match = new RegExp(`const\\s+float\\s+${name}\\s*=\\s*(-?[0-9.eE+-]+)\\s*;`).exec(source)
    if (!match?.[1]) throw new Error(`dateStamp.glsl has no "const float ${name}"`)
    return Number(match[1])
  }

  const vecIn = (source: string, name: string): number[] => {
    const match = new RegExp(`const\\s+vec2\\s+${name}\\s*=\\s*vec2\\(([^)]*)\\)`).exec(source)
    if (!match?.[1]) throw new Error(`dateStamp.glsl has no "const vec2 ${name}"`)
    return match[1].split(',').map((part) => Number(part.trim()))
  }

  it.each([
    ['DATE_STAMP_HEIGHT', DATE_STAMP_HEIGHT],
    ['DATE_STAMP_SLANT', DATE_STAMP_SLANT],
  ])('%s', (name, expected) => {
    expect(floatIn(DATE_STAMP_SOURCE, name)).toBe(expected)
  })

  it.each([
    ['TICK_CENTRE', TICK_CENTRE],
    ['TICK_HALF', TICK_HALF],
  ])('%s', (name, expected: readonly [number, number]) => {
    expect(vecIn(DATE_STAMP_SOURCE, name)).toEqual([...expected])
  })

  it('every segment box, in order', () => {
    const body = /const\s+vec4\s+SEGMENT_BOXES\[7\]\s*=\s*vec4\[7\]\(([\s\S]*?)\n\);/.exec(
      DATE_STAMP_SOURCE,
    )
    expect(body?.[1], 'dateStamp.glsl has no SEGMENT_BOXES initialiser').toBeTruthy()
    const boxes = [...body![1]!.matchAll(/vec4\(([^)]*)\)/g)].map((m) =>
      m[1]!.split(',').map((part) => Number(part.trim())),
    )
    expect(boxes, 'seven segments, a through g').toHaveLength(7)
    for (let i = 0; i < 7; i++) {
      // Close, not exact, and this is the same case the computed constants above
      // are in rather than a relaxation. The TypeScript derives these — the top
      // bar's half-width is `(0.6 - 0.15) / 2 - 0.024`, which in binary is
      // 0.20099999999999998 — while the shader carries the short decimal anyone
      // would write. Demanding exact equality would fail on the representation
      // and not on any transcription. It is also moot at the far end: a GLSL
      // float is 32-bit, so neither value survives to the ninth place anyway.
      //
      // 1e-9 is still four orders tighter than the smallest mistake that could
      // be made here, which is a digit in the third place.
      for (let c = 0; c < 4; c++) {
        expect(boxes[i]![c], `segment ${'abcdefg'[i]} component ${c}`).toBeCloseTo(
          SEGMENT_BOXES[i]![c]!,
          9,
        )
      }
    }
  })

  it('every digit mask, in order', () => {
    const body = /const\s+int\s+DIGIT_SEGMENTS\[10\]\s*=\s*int\[10\]\(([\s\S]*?)\n\);/.exec(
      DATE_STAMP_SOURCE,
    )
    expect(body?.[1], 'dateStamp.glsl has no DIGIT_SEGMENTS initialiser').toBeTruthy()
    const masks = body![1]!
      .split(',')
      .map((part) => part.replace(/\/\/.*$/gm, '').trim())
      .filter((part) => part.length > 0)
      .map(Number)
    expect(masks).toEqual([...DIGIT_SEGMENTS])
  })
})

describe('the graduated filter shares its one constant', () => {
  it('GRADUATED_MIN_WIDTH', () => {
    // The rest of the filter's geometry is duplicated maths rather than
    // duplicated numbers — it is a function of position, so the shader has to
    // evaluate it — and `tests/golden/graduated.spec.ts` compares the two
    // implementations across a ramp. This is the one literal, and it decides
    // whether `smoothstep` is ever called with equal edges.
    const match = /const\s+float\s+GRADUATED_MIN_WIDTH\s*=\s*(-?[0-9.eE+-]+)\s*;/.exec(
      GRADUATED_SOURCE,
    )
    expect(match?.[1], 'graduated.glsl has no GRADUATED_MIN_WIDTH').toBeTruthy()
    expect(Number(match![1])).toBe(GRADUATED_MIN_WIDTH)
  })
})
