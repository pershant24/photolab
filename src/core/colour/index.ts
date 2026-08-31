/**
 * Colour maths, in pure TypeScript.
 *
 * This module is the reference implementation the shaders are checked against.
 * A shader test that compares a shader only to itself measures nothing; these
 * functions are what give it something independent to disagree with, so two
 * rules hold throughout:
 *
 *  - **No WebGL, no DOM, no imports from either.** Everything here runs in Node
 *    under Vitest.
 *  - **Signatures stay shader-translatable**: plain numbers and fixed-length
 *    tuples, no objects as arguments, no closures, no classes. The two
 *    exceptions are documented where they occur — matrix *construction* in
 *    `types.ts` and `adaptation.ts` runs on the CPU to produce uniforms, and
 *    `curve.ts` bakes a lookup texture rather than evaluating per pixel.
 */

export * from './types'
export * from './transfer'
export * from './primaries'
export * from './adaptation'
export * from './matrices'
export * from './curve'
export * from './grade'
