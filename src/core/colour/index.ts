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
 *
 * Two conventions that bind anything added here, both stated in full at their
 * source because both fail silently when broken:
 *
 *  - **White points are derived from chromaticities, never taken from tabulated
 *    XYZ triples**, and any imported matrix must be checked for which D65 it
 *    assumes before use. See `primaries.ts`.
 *  - **Curves are baked to a 1D LUT on the CPU and sampled by the shader; the
 *    shader never evaluates a spline.** This is what lets `curve.ts` be the one
 *    module that does not transliterate into GLSL. See `curve.ts` and
 *    `docs/ARCHITECTURE.md`.
 */

export * from './types'
export * from './transfer'
export * from './primaries'
export * from './adaptation'
export * from './matrices'
export * from './curve'
export * from './grade'
