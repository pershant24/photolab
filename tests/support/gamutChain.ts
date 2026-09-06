/**
 * The pointwise pass chain, composed in TypeScript.
 *
 * This is the chain the Part E gamut census runs, and the reason it lives in
 * the repository rather than in a scratch directory is that the census's
 * conclusions depend on it being the *same* chain the renderer runs.
 * `tests/render/gamut-chain-agreement.spec.ts` is what checks that, and a check
 * that cannot run checks nothing — which this repository has now been caught by
 * twice.
 *
 * Every function is imported from `src/core/colour/`, the reference
 * implementation the shaders are already asserted against. Nothing is
 * transcribed. What this file contributes is the *composition*: the order the
 * passes run in, and the encode/decode boundary each one sits inside. That
 * composition is not otherwise asserted anywhere, and a reordering of
 * `src/render/passes/registry.ts` would silently invalidate the census without
 * it.
 *
 * Order is taken from that registry and each pass's declared `stage`, not from
 * the prose in the project instructions:
 *
 *   ingest    sRGB EOTF -> SRGB_TO_ACESCG
 *   scene     white balance, exposure
 *   lens      EXCLUDED (spatial)
 *   film      halation EXCLUDED (spatial), film curves, grain EXCLUDED (spatial)
 *   grade     tone curve, contrast, wheels, hsl, split tone
 *   display   ACESCG_TO_SRGB -> gamut compress -> tone map -> clamp -> OETF
 *
 * The excluded passes are exactly the three with a spatial kernel. They have no
 * pointwise form to compose, and the agreement spec disables them on both sides
 * so the exclusion is a stated scope rather than a hidden difference.
 */

import { srgbEotf, encodeACEScct, decodeACEScct } from '../../src/core/colour/transfer'
import { SRGB_TO_ACESCG } from '../../src/core/colour/matrices'
import { mat3MulVec3 } from '../../src/core/colour/types'
import type { Vec3 } from '../../src/core/colour/types'
import { applyExposureRgb, applyContrastRgb } from '../../src/core/colour/grade'
import { applyHsl } from '../../src/core/colour/hsl'
import { applyWheelsEncoded } from '../../src/core/colour/wheels'
import { applySplitToneEncoded } from '../../src/core/colour/splitTone'
import { evaluateCurve } from '../../src/core/colour/curve'
import { whiteBalanceMatrix, isNeutralWhiteBalance } from '../../src/core/colour/whiteBalance'
import { splitControlPoints } from '../../src/core/state/editState'
import type { EditState } from '../../src/core/state/editState'
import { findFilmStock } from '../../src/core/colour/filmStock'
import { filmStockPatch } from '../../src/core/state/editState'
import { BUILT_IN_PRESETS } from '../../src/core/presets/library'

/** ingest: one 8-bit sRGB triple to linear ACEScg. */
export function ingest(r8: number, g8: number, b8: number): Vec3 {
  return mat3MulVec3(SRGB_TO_ACESCG, [srgbEotf(r8 / 255), srgbEotf(g8 / 255), srgbEotf(b8 / 255)])
}

/** One curve applied to one channel inside an ACEScct encode, as the shaders do. */
function curveChannel(
  linear: number,
  xs: readonly number[],
  ys: readonly number[],
  strength: number,
): number {
  const encoded = encodeACEScct(linear)
  const curved = evaluateCurve(xs, ys, encoded)
  return decodeACEScct(encoded + (curved - encoded) * strength)
}

export type Chain = (acescg: Vec3) => Vec3

/**
 * Build the pointwise chain for one `EditState`.
 *
 * Returns a function from linear ACEScg to linear ACEScg that stops *before*
 * the display transform, because what the display transform is handed is
 * exactly the quantity the census is about.
 */
export function buildChain(state: EditState): Chain {
  const wb = isNeutralWhiteBalance(state.temperature, state.tint)
    ? null
    : whiteBalanceMatrix(state.temperature, state.tint)
  const { exposure, contrast, filmStrength } = state

  const film = (['filmCurveRed', 'filmCurveGreen', 'filmCurveBlue'] as const).map((key) =>
    splitControlPoints(state[key]),
  )
  const filmActive = filmStrength !== 0 && film.every((c) => c.xs.length > 2)

  const curve = splitControlPoints(state.toneCurve)
  const curveActive = curve.xs.length > 2 && !isIdentityPoints(curve.xs, curve.ys)

  const { lift, gamma, gain, splitBalance } = state
  const wheelsActive = [lift, gamma, gain].some((w) => w.some((v) => v !== 0))
  const hslActive = [state.hslHue, state.hslSaturation, state.hslLuminance].some((b) =>
    b.some((v) => v !== 0),
  )
  const splitActive = [state.splitShadowTint, state.splitHighlightTint].some((t) =>
    t.some((v) => v !== 0),
  )

  return (acescg: Vec3): Vec3 => {
    // scene
    let c: Vec3 = wb ? mat3MulVec3(wb, acescg) : acescg
    if (exposure !== 0) c = applyExposureRgb(c, exposure)

    // film, pointwise part only
    if (filmActive) {
      c = [
        curveChannel(c[0], film[0]!.xs, film[0]!.ys, filmStrength),
        curveChannel(c[1], film[1]!.xs, film[1]!.ys, filmStrength),
        curveChannel(c[2], film[2]!.xs, film[2]!.ys, filmStrength),
      ]
    }

    // grade, in registration order: tone curve, contrast, wheels, hsl, split tone
    if (curveActive) {
      c = [
        curveChannel(c[0], curve.xs, curve.ys, 1),
        curveChannel(c[1], curve.xs, curve.ys, 1),
        curveChannel(c[2], curve.xs, curve.ys, 1),
      ]
    }
    if (contrast !== 1) c = applyContrastRgb(c, contrast)
    if (wheelsActive) {
      c = [
        decodeACEScct(applyWheelsEncoded(encodeACEScct(c[0]), lift[0]!, gamma[0]!, gain[0]!)),
        decodeACEScct(applyWheelsEncoded(encodeACEScct(c[1]), lift[1]!, gamma[1]!, gain[1]!)),
        decodeACEScct(applyWheelsEncoded(encodeACEScct(c[2]), lift[2]!, gamma[2]!, gain[2]!)),
      ]
    }
    if (hslActive) {
      c = applyHsl(c, state.hslHue, state.hslSaturation, state.hslLuminance)
    }
    if (splitActive) {
      const s = state.splitShadowTint
      const h = state.splitHighlightTint
      c = [
        decodeACEScct(applySplitToneEncoded(encodeACEScct(c[0]), s[0]!, h[0]!, splitBalance)),
        decodeACEScct(applySplitToneEncoded(encodeACEScct(c[1]), s[1]!, h[1]!, splitBalance)),
        decodeACEScct(applySplitToneEncoded(encodeACEScct(c[2]), s[2]!, h[2]!, splitBalance)),
      ]
    }
    return c
  }
}

function isIdentityPoints(xs: readonly number[], ys: readonly number[]): boolean {
  return xs.length === ys.length && xs.every((x, i) => x === ys[i])
}

// ---------------------------------------------------------------------------

/** Everything with a spatial kernel, off. The census does not model these. */
export const SPATIAL_OFF: Record<string, number> = {
  distortion: 0,
  aberration: 0,
  diffusionStrength: 0,
  vignette: 0,
  halationStrength: 0,
  grainStrength: 0,
}

const ALL = (v: number): number[] => [v, v, v, v, v, v]

function stock(id: string): Partial<EditState> {
  const found = findFilmStock(id)
  if (!found) throw new RangeError(`no film stock "${id}"`)
  return filmStockPatch(found)
}

function preset(id: string): Partial<EditState> {
  const found = BUILT_IN_PRESETS.find((p) => p.id === id)
  if (!found) throw new RangeError(`no preset "${id}"`)
  return found.patch
}

function addSaturation(patch: Partial<EditState>, delta: number): Partial<EditState> {
  const base = (patch.hslSaturation as number[] | undefined) ?? ALL(0)
  return { ...patch, hslSaturation: base.map((v) => Math.min(1, v + delta)) }
}

export interface Grade {
  readonly name: string
  readonly patch: Partial<EditState>
}

/**
 * The grades the census measures, and why this set rather than just the presets.
 *
 * The four built-in presets are what ships, so they have to be here. They are
 * also a bad set to measure this on alone: the Stage 6 finding was triggered by
 * HSL saturation *pushes*, where `mix(luma, rgb, 1 + s)` drives a channel
 * negative, and no built-in preset pushes saturation hard positive — the
 * strongest is +0.12 on one band and one preset is negative across the board.
 * Measuring only those would report a small number that is a fact about the
 * preset library rather than about the compressor.
 *
 * So: every preset as it ships, the two that push saturation at all with a
 * realistic further push on top, saturation alone at three strengths to isolate
 * it, and one hard tone grade with no saturation move to see whether tone
 * shaping alone reaches the region. Saturation is stored as the delta directly
 * and `HSL_SATURATION_RANGE` is 1, so +1.0 is the maximum the control offers.
 */
export const CENSUS_GRADES: readonly Grade[] = [
  { name: 'neutral', patch: {} },
  { name: 'preset soft-portrait', patch: preset('builtin-soft-portrait') },
  { name: 'preset teal-orange', patch: preset('builtin-teal-and-orange') },
  { name: 'preset faded-document', patch: preset('builtin-faded-document') },
  { name: 'preset night-push', patch: preset('builtin-night-push') },
  { name: 'teal-orange +0.3 sat', patch: addSaturation(preset('builtin-teal-and-orange'), 0.3) },
  { name: 'soft-portrait +0.3 sat', patch: addSaturation(preset('builtin-soft-portrait'), 0.3) },
  { name: 'sat +0.3 only', patch: { hslSaturation: ALL(0.3) } },
  { name: 'sat +0.5 only', patch: { hslSaturation: ALL(0.5) } },
  { name: 'sat +1.0 only (max)', patch: { hslSaturation: ALL(1) } },
  {
    name: 'punchy +1.0 sat (max)',
    patch: { ...stock('punchy-reversal'), filmStrength: 0.8, hslSaturation: ALL(1) },
  },
  { name: 'exposure +1.5 contrast 1.4', patch: { exposure: 1.5, contrast: 1.4 } },
]

/**
 * The grades the agreement spec renders, chosen to cover every pointwise pass.
 *
 * Between them they exercise white balance, exposure, the film curves, the tone
 * curve, contrast, all three wheels, HSL and split tone — so a pass reordered in
 * the registry cannot slip past all three.
 */
export const AGREEMENT_GRADES: readonly Grade[] = [
  { name: 'teal-orange', patch: preset('builtin-teal-and-orange') },
  { name: 'faded-document', patch: preset('builtin-faded-document') },
  {
    name: 'white balance, exposure, wheels, split tone',
    patch: {
      temperature: 4200,
      tint: 0.03,
      exposure: -0.4,
      toneCurve: [-0.3584, -0.3584, 0.3, 0.34, 0.7, 0.66, 1, 1],
      splitShadowTint: [-0.006, 0.004, 0.011],
      splitHighlightTint: [0.009, 0.003, -0.005],
      splitBalance: -0.8,
      lift: [0.01, -0.004, 0.006],
      gamma: [-0.003, 0.005, 0.002],
      gain: [0.007, 0.001, -0.008],
    },
  },
]
