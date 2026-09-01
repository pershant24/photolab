import { describe, expect, it } from 'vitest'

import { evaluateCurve, fitControlPoints } from '../../src/core/colour/curve'
import {
  DISPLAY_WHITE_ACESCCT,
  FILM_DOMAIN,
  FILM_STOCKS,
  MIDDLE_GREY_ACESCCT,
  stopsFromGrey,
  IDENTITY_CHANNEL,
  channelFromSamples,
  findFilmStock,
  isIdentityChannel,
} from '../../src/core/colour/filmStock'
import { hueDifference, labChroma, labHueAngle, linearSrgbToLab } from '../../src/core/colour/lab'
import { ACESCG_TO_SRGB } from '../../src/core/colour/matrices'
import { decodeACEScct, encodeACEScct } from '../../src/core/colour/transfer'
import { MIDDLE_GREY_LINEAR } from '../../src/core/colour/grade'
import { mat3MulVec3 } from '../../src/core/colour/types'
import type { Vec3 } from '../../src/core/colour/types'
import { splitControlPoints } from '../../src/core/state/editState'

/** Apply one stock to a neutral linear value, as the shader does. */
function applyStock(
  stock: { red: readonly number[]; green: readonly number[]; blue: readonly number[] },
  linear: number,
  strength = 1,
): Vec3 {
  const encoded = encodeACEScct(linear)
  const channel = (points: readonly number[]): number => {
    const { xs, ys } = splitControlPoints(points)
    const curved = evaluateCurve(xs, ys, encoded)
    return decodeACEScct(encoded + strength * (curved - encoded))
  }
  return [channel(stock.red), channel(stock.green), channel(stock.blue)]
}

describe('film stocks', () => {
  it('carries three independent curves, not one shared shape', () => {
    // The feature, stated as a property. Three curves that happen to be equal
    // would pass every arithmetic test and produce no crossover at all.
    for (const stock of FILM_STOCKS) {
      expect(stock.red).not.toEqual(stock.green)
      expect(stock.green).not.toEqual(stock.blue)
      expect(stock.red).not.toEqual(stock.blue)
    }
  })

  it('leaves black neutral', () => {
    // A coloured pure black reads as a bug rather than as a stock, and it is the
    // first thing anyone checks. Real emulsion does have a coloured base density;
    // that is deliberately not reproduced at the very bottom.
    for (const stock of FILM_STOCKS) {
      const out = applyStock(stock, 0)
      expect(out[0]).toBeCloseTo(out[1], 6)
      expect(out[1]).toBeCloseTo(out[2], 6)
    }
  })

  it('does nothing at zero strength', () => {
    for (const stock of FILM_STOCKS) {
      for (const linear of [0.02, 0.18, 0.6, 2]) {
        const out = applyStock(stock, linear, 0)
        for (const channelValue of out) expect(channelValue).toBeCloseTo(linear, 6)
      }
    }
  })

  it('is described rather than named after a real stock', () => {
    // Real stock names are trademarks, and a look tuned by eye against a domain
    // the datasheet was not written for has no business borrowing one.
    const trademarks = ['portra', 'velvia', 'cinestill', 'ektar', 'provia', 'trix', 'kodak', 'fuji']
    for (const stock of FILM_STOCKS) {
      // Matched on word boundaries, not as substrings. The first version was a
      // substring check and flagged "warm portrait" for containing "portra",
      // which is the check being crude rather than the name borrowing anything.
      const words = `${stock.id} ${stock.name} ${stock.description}`
        .toLowerCase()
        .split(/[^a-z]+/)
      for (const mark of trademarks) {
        expect(words.includes(mark), `${stock.id} mentions "${mark}"`).toBe(false)
      }
      expect(stock.description.length).toBeGreaterThan(30)
    }
  })

  it('finds a stock by id, and reports a miss', () => {
    expect(findFilmStock('warm-portrait')?.name).toBe('Warm portrait')
    expect(findFilmStock('nonexistent')).toBeUndefined()
  })

  it('recognises the identity channel', () => {
    expect(isIdentityChannel(IDENTITY_CHANNEL)).toBe(true)
    expect(isIdentityChannel([FILM_DOMAIN[0], 0.2, 1, 1])).toBe(false)
  })
})

describe('crossover', () => {
  /**
   * The measurement: how far the hue of a rendered neutral drifts, and in which
   * direction, at the two ends of the exposure range.
   */
  function drift(stock: {
    red: readonly number[]
    green: readonly number[]
    blue: readonly number[]
  }): { shadowHue: number; highlightHue: number; shadowChroma: number; highlightChroma: number; separation: number } {
    // Sampled in STOPS FROM MIDDLE GREY rather than at chosen linear values.
    //
    // That is the occupancy rule applied to a fixture: a sample labelled
    // "shadow" has to be in the shadows *of a real image*, not merely smaller
    // than the other one. Both earlier attempts got this wrong in different
    // ways — 1.4 linear was called a highlight and encodes to a midtone, and
    // 0.012 was called a shadow and sits four stops down where the channels have
    // already converged. Stops from grey are the units the curves are defined
    // in, so a sample at -3 stops is in the shadows by construction.
    const shadow = linearSrgbToLab(
      mat3MulVec3(ACESCG_TO_SRGB, applyStock(stock, decodeACEScct(stopsFromGrey(-3)))),
    )
    const highlight = linearSrgbToLab(
      mat3MulVec3(ACESCG_TO_SRGB, applyStock(stock, decodeACEScct(stopsFromGrey(2)))),
    )
    return {
      shadowHue: labHueAngle(shadow),
      highlightHue: labHueAngle(highlight),
      shadowChroma: labChroma(shadow),
      highlightChroma: labChroma(highlight),
      separation: hueDifference(labHueAngle(shadow), labHueAngle(highlight)),
    }
  }

  it('drifts in opposite directions at the two ends of the range', () => {
    // This is the feature, and it is possible to have three technically correct
    // curves that produce none of it.
    //
    // **Chroma is asserted before hue, and that is not belt and braces.** Hue is
    // undefined on the neutral axis — `atan2(0, 0)` — so a stock producing no
    // colour at all yields an arbitrary angle. The first version of this test
    // measured hue alone and reported 68 degrees of "crossover" from three
    // identical curves, which was floating point noise on two neutrals.
    for (const stock of FILM_STOCKS) {
      const d = drift(stock)
      expect(d.shadowChroma, `${stock.id}: shadows have no colour to have a hue`).toBeGreaterThan(2)
      expect(d.highlightChroma, `${stock.id}: highlights have no colour`).toBeGreaterThan(2)
      expect(
        d.separation,
        `${stock.id}: shadows ${d.shadowHue.toFixed(0)}deg, highlights ${d.highlightHue.toFixed(0)}deg`,
      ).toBeGreaterThan(25)
    }
  })

  it('goes to zero when the three curves are identical', () => {
    // The mutation, kept as a test rather than run once. Three identical curves
    // are a contrast adjustment: correct arithmetic, no character.
    const shared = FILM_STOCKS[0]?.green
    expect(shared).toBeDefined()
    if (!shared) return

    const flattened = { red: shared, green: shared, blue: shared }
    const d = drift(flattened)

    // Asserted on chroma, because that is what actually goes to zero. The hue
    // angle does not: it is undefined here and returns whatever the rounding
    // gives.
    expect(d.shadowChroma, 'identical curves cannot tint a neutral').toBeLessThan(1e-6)
    expect(d.highlightChroma).toBeLessThan(1e-6)

    const out = applyStock(flattened, 0.5)
    expect(out[0]).toBeCloseTo(out[1], 9)
    expect(out[1]).toBeCloseTo(out[2], 9)
  })

  it('leaves middle grey exactly neutral, in every stock and every channel', () => {
    // The anchor, and the property everything else here depends on. A correctly
    // exposed midtone comes out exactly where it went in, so exposure moves the
    // image along the curves from a defined origin — and a correctly exposed
    // skin tone does not shift hue, which is where crossover usually goes wrong.
    //
    // It also makes the stocks comparable: all three agree at grey, so a
    // difference between them is a difference in character rather than in where
    // they happen to sit.
    for (const stock of FILM_STOCKS) {
      const out = applyStock(stock, MIDDLE_GREY_LINEAR)
      for (const channelValue of out) {
        expect(channelValue, `${stock.id} moves middle grey`).toBeCloseTo(MIDDLE_GREY_LINEAR, 9)
      }
      expect(
        labChroma(linearSrgbToLab(mat3MulVec3(ACESCG_TO_SRGB, out))),
        `${stock.id} tints middle grey`,
      ).toBeLessThan(1e-6)
    }
  })

  it('places its control points where a real image lives', () => {
    // The occupancy rule. A curve is only doing work over the range the data
    // occupies, and a display-referred image spans roughly six stops below
    // middle grey up to display white at +2.47. Control points spread past that
    // shape tones no picture contains — which is not a hypothetical: the first
    // version spread them over the full encoded domain, whose top half is nearly
    // eight stops above white, and more than half of every stock did nothing.
    for (const stock of FILM_STOCKS) {
      const { xs } = splitControlPoints(stock.green)
      const occupied = xs.filter(
        (x) => x >= stopsFromGrey(-6) && x <= DISPLAY_WHITE_ACESCCT + 1e-9,
      )
      expect(
        occupied.length / xs.length,
        `${stock.id}: only ${occupied.length} of ${xs.length} control points are in the occupied range`,
      ).toBeGreaterThan(0.6)

      // And grey is one of them, so the anchor is a control point rather than an
      // accident of interpolation.
      expect(xs.some((x) => Math.abs(x - MIDDLE_GREY_ACESCCT) < 1e-9)).toBe(true)
    }
  })

  it('survives a change of exposure', () => {
    // A look that only holds at one exposure is a cast dressed as a stock.
    //
    // Anchoring the curves to middle grey is what makes this hold. Before it,
    // the separation was 26 degrees at nominal exposure and 172 a stop up — a
    // factor of six from one stop, because the stocks had no defined reference
    // and a "correctly exposed" image landed wherever the last one had. Measured
    // after: 175, 174, 174, 175 across four stops.
    //
    // It still collapses two stops down, where both samples fall below the
    // lowest control point and the channels have converged. That is the curves
    // running out rather than the look failing, and it is why the range tested
    // here is the one the stocks are defined over.
    const stock = FILM_STOCKS[0]
    expect(stock).toBeDefined()
    if (!stock) return

    for (const stops of [-1, 0, 1]) {
      const gain = 2 ** stops
      const shadow = linearSrgbToLab(
        mat3MulVec3(ACESCG_TO_SRGB, applyStock(stock, decodeACEScct(stopsFromGrey(-3)) * gain)),
      )
      const highlight = linearSrgbToLab(
        mat3MulVec3(ACESCG_TO_SRGB, applyStock(stock, decodeACEScct(stopsFromGrey(2)) * gain)),
      )

      expect(labChroma(shadow), `no shadow colour at ${stops} stops`).toBeGreaterThan(1)
      expect(
        hueDifference(labHueAngle(shadow), labHueAngle(highlight)),
        `crossover collapsed at ${stops} stops`,
      ).toBeGreaterThan(12)
    }
  })
})

describe('digitised datasheet curves', () => {
  it('reduces dense samples to control points that reproduce them', () => {
    // The path a published characteristic curve takes: a few hundred traced
    // points, reduced to control points placed where the curve bends.
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i <= 300; i++) {
      const x = FILM_DOMAIN[0] + ((1 - FILM_DOMAIN[0]) * i) / 300
      const t = (x - FILM_DOMAIN[0]) / (1 - FILM_DOMAIN[0])
      // A toe, a straight section and a shoulder.
      ys.push(0.05 + 0.9 / (1 + Math.exp(-9 * (t - 0.45))))
      xs.push(x)
    }

    const tolerance = 2e-3
    const fitted = fitControlPoints(xs, ys, tolerance)

    expect(fitted.xs.length).toBeGreaterThan(2)
    expect(fitted.xs.length).toBeLessThan(20)

    let worst = 0
    for (let i = 0; i < xs.length; i++) {
      worst = Math.max(
        worst,
        Math.abs(evaluateCurve(fitted.xs, fitted.ys, xs[i] ?? 0) - (ys[i] ?? 0)),
      )
    }
    expect(worst).toBeLessThanOrEqual(tolerance)
  })

  it('places control points where the curve bends, not evenly', () => {
    // The reason for greedy insertion rather than fixed decimation: a curve that
    // is straight for half its range and sharply bent for the rest should spend
    // its control points on the bend.
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i <= 200; i++) {
      const x = i / 200
      xs.push(x)
      ys.push(x < 0.7 ? x * 0.5 : 0.35 + (x - 0.7) ** 0.4 * 0.9)
    }
    const fitted = fitControlPoints(xs, ys, 2e-3)
    const inBend = fitted.xs.filter((x) => x > 0.7).length
    const inStraight = fitted.xs.filter((x) => x <= 0.7).length
    expect(inBend).toBeGreaterThan(inStraight)
  })

  it('produces interleaved control points ready for EditState', () => {
    const xs = [0, 0.5, 1]
    const ys = [0, 0.6, 1]
    const points = channelFromSamples(xs, ys, 1e-3)
    expect(points.length % 2).toBe(0)
    expect(points[0]).toBe(0)
    expect(points[points.length - 2]).toBe(1)
  })
})
