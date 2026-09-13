import { describe, expect, it } from 'vitest'

import {
  FILM_STOCKS,
  MIDDLE_GREY_ACESCCT,
  stopsFromGrey,
} from '../../src/core/colour/filmStock'
import { MIDDLE_GREY_LINEAR } from '../../src/core/colour/grade'
import {
  isReversalShaped,
  measureCurveShape,
} from '../../src/core/colour/curveShape'
import { curveLutResolution, LUT_TOLERANCE, evaluateCurve } from '../../src/core/colour/curve'
import { splitControlPoints } from '../../src/core/state/editState'
import { decodeACEScct, encodeACEScct } from '../../src/core/colour/transfer'
import { ACESCG_TO_SRGB } from '../../src/core/colour/matrices'
import { mat3MulVec3 } from '../../src/core/colour/types'
import { labChroma, linearSrgbToLab } from '../../src/core/colour/lab'
import { STOCK_PRESETS } from '../../src/core/presets/axisLibrary'

/**
 * Does the stock axis span its dimensions, or does it cluster?
 *
 * # Why this is a test and not a one-off script
 *
 * The axis had three stocks, all of them negatives, one of them **named**
 * reversal and measured here as a negative. Nothing caught that, because nothing
 * measured shape — the crossover assertions check that a stock has character and
 * the occupancy assertion checks its control points are somewhere useful, and a
 * library can satisfy both while being three tunings of one idea.
 *
 * So the spread is asserted rather than admired. Adding a stock that duplicates
 * an existing one fails here.
 *
 * # Monochrome is measured separately, and that is not a convenience
 *
 * Monochrome stocks sit trivially far from the colour ones on crossover and
 * saturation — they have none — so pooling all eight would report a
 * well-separated axis that is really two clusters with a chasm between them.
 * The families are measured against their own members instead, which is the
 * question anyone browsing the panel actually has: are these two distinguishable
 * from each other?
 */

const COLOUR = FILM_STOCKS.filter((s) => !s.monochrome)
const MONO = FILM_STOCKS.filter((s) => s.monochrome)

/** Apply one stock's curves to a neutral at `stops` from grey. */
function neutralThrough(
  stock: { red: readonly number[]; green: readonly number[]; blue: readonly number[] },
  stops: number,
): [number, number, number] {
  const x = stopsFromGrey(stops)
  return (['red', 'green', 'blue'] as const).map((channel) => {
    const { xs, ys } = splitControlPoints(stock[channel])
    return decodeACEScct(evaluateCurve(xs, ys, x))
  }) as [number, number, number]
}

interface Row {
  id: string
  /** Slope at grey: what reads as contrast. */
  gamma: number
  /** Stops in the shoulder, or Infinity for a curve that never terminates. */
  shoulder: number
  /** Output five stops under grey, in linear light. Deep black versus matte. */
  floor: number
  /** CIELAB chroma of a neutral three stops under grey, and two stops over. */
  shadowChroma: number
  highlightChroma: number
  /**
   * Hue difference between shadow and highlight, in degrees: crossover
   * MAGNITUDE. `NaN` where there is no chroma to have a hue.
   */
  crossover: number
  /**
   * Blue-yellow of a neutral three stops under grey: crossover DIRECTION.
   *
   * The difference above cannot carry direction. Every stock here measures near
   * 180 degrees — which is what crossover means, the two ends landing on
   * opposite hues — so its sign is decided by which way the wrap fell, and two
   * stocks reading -177 and +178 are drifting the SAME way while looking
   * opposed. Asking which end is warm is the question that has an answer.
   */
  shadowB: number
  /** Grain the preset carries, which is character rather than curve shape. */
  grain: number
  lut: number
}

function measure(stock: (typeof FILM_STOCKS)[number]): Row {
  const { xs, ys } = splitControlPoints(stock.green)
  const shape = measureCurveShape(xs, ys, MIDDLE_GREY_ACESCCT)

  const lab = (stops: number): readonly number[] =>
    linearSrgbToLab(mat3MulVec3(ACESCG_TO_SRGB, neutralThrough(stock, stops)))
  const shadow = lab(-3)
  const highlight = lab(2)
  const asVec = (l: readonly number[]): [number, number, number] => [l[0]!, l[1]!, l[2]!]
  const hue = (l: readonly number[]): number =>
    (Math.atan2(l[2] ?? 0, l[1] ?? 0) * 180) / Math.PI

  let separation = hue(highlight) - hue(shadow)
  while (separation > 180) separation -= 360
  while (separation < -180) separation += 360

  /*
   * Chroma gates the hue, as `film-stock.test.ts` records at length: hue is
   * undefined on the neutral axis, so a monochrome stock yields whatever
   * `atan2(0, 0)` rounds to. The first version of this census reported
   * crossovers of -90, +158 and -68 degrees for three stocks that have no colour
   * at all, and the clustering check below would have accepted those as
   * separation.
   */
  const hasColour = labChroma(asVec(shadow)) > 1e-6 && labChroma(asVec(highlight)) > 1e-6

  // Matched on the curve rather than on a name, and asserted rather than
  // defaulted: a miss would silently give this stock a grain of 0, and grain is
  // one of the five dimensions the clustering check below reads. A silent zero
  // weakens that check without failing anything, which is the failure mode this
  // file has two other sections about.
  const preset = STOCK_PRESETS.find(
    (p) => JSON.stringify(p.patch.filmCurveGreen) === JSON.stringify(stock.green),
  )
  if (!preset) throw new Error(`stock-spread: no preset ships the stock "${stock.id}"`)

  return {
    id: stock.id,
    gamma: shape.gammaAtGrey,
    shoulder: shape.shoulderStops,
    floor: decodeACEScct(shape.densityFloor),
    shadowChroma: labChroma(asVec(shadow)),
    highlightChroma: labChroma(asVec(highlight)),
    crossover: hasColour ? separation : Number.NaN,
    shadowB: shadow[2] ?? 0,
    grain: preset.patch.grainStrength ?? 0,
    lut: Math.max(
      ...(['red', 'green', 'blue'] as const).map((c) => {
        const s = splitControlPoints(stock[c])
        return curveLutResolution(s.xs, s.ys, LUT_TOLERANCE)
      }),
    ),
  }
}

const ROWS = FILM_STOCKS.map(measure)
const byId = new Map(ROWS.map((r) => [r.id, r]))

describe('the stock axis spans its dimensions', () => {
  it('reports the census', () => {
    const fmt = (r: Row): string =>
      `${r.id.padEnd(19)} gamma ${r.gamma.toFixed(2)}  ` +
      `shoulder ${(r.shoulder === Infinity ? 'none' : `${r.shoulder.toFixed(2)}st`).padStart(6)}  ` +
      `floor ${r.floor.toExponential(2)}  ` +
      `chroma ${r.shadowChroma.toFixed(1)}/${r.highlightChroma.toFixed(1)}  ` +
      `crossover ${Number.isNaN(r.crossover) ? '   n/a' : `${r.crossover >= 0 ? '+' : ''}${r.crossover.toFixed(0)}deg`}  ` +
      `shadow b* ${r.shadowB.toFixed(1).padStart(5)}  ` +
      `grain ${r.grain.toFixed(2)}  lut ${r.lut}`
    console.log(
      '\n  colour stocks\n    ' +
        ROWS.filter((r) => !MONO.some((m) => m.id === r.id)).map(fmt).join('\n    ') +
        '\n  monochrome stocks\n    ' +
        ROWS.filter((r) => MONO.some((m) => m.id === r.id)).map(fmt).join('\n    ') +
        '\n',
    )
    expect(ROWS.length).toBeGreaterThan(6)
  })

  it('has both families of colour stock, which it did not before', () => {
    /*
     * The finding that started this. `punchy-reversal` shipped claiming "a hard
     * shoulder ... reversal film rather than negative" and measured as a
     * negative: still climbing at 90% of its midtone gamma four stops over grey,
     * slope never falling to a twentieth of that anywhere in the domain.
     *
     * Contrast is not what separates the families, which is why raising it until
     * a stock looks punchy produces a punchy negative. The extent of the
     * shoulder is.
     */
    const reversal = COLOUR.filter((s) => {
      const { xs, ys } = splitControlPoints(s.green)
      return isReversalShaped(measureCurveShape(xs, ys, MIDDLE_GREY_ACESCCT))
    })
    const negatives = COLOUR.filter((s) => !reversal.includes(s))
    expect(reversal.length, 'no stock terminates its highlights').toBeGreaterThanOrEqual(2)
    expect(negatives.length, 'no stock has negative latitude').toBeGreaterThanOrEqual(2)
  })

  it('separates the two reversal stocks by crossover DIRECTION, not just amount', () => {
    // The only opposed pair in the library. Two reversal stocks that drifted the
    // same way would be one stock at two contrasts, which is what the negatives
    // already are.
    const vivid = byId.get('vivid-reversal')!
    const cool = byId.get('cool-reversal')!

    // Direction from which end is warm, not from the sign of a wrapped angle.
    expect(Math.sign(vivid.shadowB), 'the reversal stocks drift the same way').not.toBe(
      Math.sign(cool.shadowB),
    )
    // And both are genuinely crossing rather than merely tinted: the two ends
    // land far apart in hue.
    expect(Math.abs(vivid.crossover)).toBeGreaterThan(25)
    expect(Math.abs(cool.crossover)).toBeGreaterThan(25)
    // Non-vacuity for the direction test: a shadow with no blue-yellow to speak
    // of would give a sign from rounding.
    expect(Math.abs(vivid.shadowB), 'vivid shadows are neutral').toBeGreaterThan(0.5)
    expect(Math.abs(cool.shadowB), 'cool shadows are neutral').toBeGreaterThan(0.5)
  })

  it('gives reversal a deeper floor than any negative', () => {
    // "Deep black versus lifted matte" as a number rather than an impression.
    const worstReversal = Math.max(
      byId.get('vivid-reversal')!.floor,
      byId.get('cool-reversal')!.floor,
    )
    const bestNegative = Math.min(
      byId.get('warm-portrait')!.floor,
      byId.get('punchy-negative')!.floor,
      byId.get('muted-documentary')!.floor,
    )
    expect(worstReversal, 'a reversal stock has a shallower floor than a negative').toBeLessThan(
      bestNegative,
    )
  })

  it('separates the monochrome stocks from each other, measured on their own terms', () => {
    /*
     * The trap this avoids: monochrome stocks are trivially far from every
     * colour stock on crossover and saturation, so a census over all eight would
     * report a beautifully spread axis that is two clusters. Measured within the
     * family instead.
     *
     * Their available dimensions are contrast, floor, grain — and the mixer,
     * which does not appear in the curve at all. So the mixer is measured here
     * too, because it is most of what distinguishes them.
     */
    const mixes = STOCK_PRESETS.filter((p) => Array.isArray(p.patch.monochromeMix)).map(
      (p) => p.patch.monochromeMix as readonly number[],
    )
    expect(mixes.length, 'no monochrome preset carries a mix').toBe(3)

    // Every pair must differ by a real amount somewhere in the triple. Two
    // stocks with the same weights and the same curve are the same stock.
    for (let i = 0; i < mixes.length; i++) {
      for (let j = i + 1; j < mixes.length; j++) {
        const distance = Math.max(
          ...[0, 1, 2].map((c) => Math.abs((mixes[i]![c] ?? 0) - (mixes[j]![c] ?? 0))),
        )
        expect(distance, `monochrome mixes ${i} and ${j} are barely distinguishable`).toBeGreaterThan(
          0.1,
        )
      }
    }

    const monoRows = ROWS.filter((r) => MONO.some((m) => m.id === r.id))
    const gammas = monoRows.map((r) => r.gamma).sort((a, b) => a - b)
    expect(
      gammas[gammas.length - 1]! - gammas[0]!,
      'the monochrome stocks are all the same contrast',
    ).toBeGreaterThan(0.4)
  })

  it('leaves no two stocks close on every dimension at once', () => {
    /*
     * The clustering check, and the one that would catch a lazily added stock.
     *
     * Within each family, every pair must be clearly apart on at least one
     * dimension. "Clearly" is a per-dimension threshold rather than a single
     * distance, because the dimensions are in different units and normalising
     * them would bury the judgement in a scale factor nobody could argue with.
     */
    const families: [string, Row[]][] = [
      ['colour', ROWS.filter((r) => COLOUR.some((c) => c.id === r.id))],
      ['monochrome', ROWS.filter((r) => MONO.some((m) => m.id === r.id))],
    ]
    for (const [family, rows] of families) {
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const a = rows[i]!
          const b = rows[j]!
          const apart =
            Math.abs(a.gamma - b.gamma) > 0.1 ||
            (a.shoulder === Infinity) !== (b.shoulder === Infinity) ||
            Math.abs(Math.log2(a.floor / b.floor)) > 0.5 ||
            // NaN on either side makes this false, which is the point: two
            // monochrome stocks must be separated by something real.
            Math.abs(a.crossover - b.crossover) > 20 ||
            Math.abs(a.grain - b.grain) > 0.15
          expect(apart, `${family}: ${a.id} and ${b.id} sit close on every dimension`).toBe(true)
        }
      }
    }
  })

  it('asks the reversal curves for more lookup samples than any negative', () => {
    /*
     * The Stage 6 resolution derivation meeting the case it was built for.
     *
     * It sizes each lookup table from the curve's own second derivative, and
     * until now it had only ever seen gentle S-curves — every negative here
     * lands at or near the floor of 64. A terminating shoulder is the first
     * shape in the library that genuinely asks for more.
     */
    const negatives = ['warm-portrait', 'punchy-negative', 'muted-documentary'].map(
      (id) => byId.get(id)!.lut,
    )
    const reversal = ['vivid-reversal', 'cool-reversal'].map((id) => byId.get(id)!.lut)
    expect(Math.min(...reversal)).toBeGreaterThan(Math.max(...negatives) * 2)
    // And nowhere near the ceiling: the machinery is working, not straining.
    expect(Math.max(...reversal)).toBeLessThan(1024)
  })

  it('keeps every stock anchored at middle grey, new ones included', () => {
    // Restated here rather than relied on from film-stock.test.ts, because the
    // reversal and monochrome channels are BUILT rather than digitised and a
    // construction that drifted off the anchor would break every comparison in
    // this file silently.
    for (const stock of FILM_STOCKS) {
      const out = neutralThrough(stock, 0)
      for (const channel of out) {
        expect(channel, `${stock.id} moves middle grey`).toBeCloseTo(MIDDLE_GREY_LINEAR, 9)
      }
    }
    expect(encodeACEScct(MIDDLE_GREY_LINEAR)).toBeCloseTo(MIDDLE_GREY_ACESCCT, 12)
  })
})
