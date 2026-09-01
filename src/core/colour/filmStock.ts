/**
 * Film stocks: three characteristic curves and the metadata around them.
 *
 * # Domain, and what it costs
 *
 * The curves operate over **log display-referred exposure** — ACEScct, the same
 * domain the tone curve uses — not over log *scene* exposure, which is what a
 * published characteristic curve is defined against.
 *
 * That follows from the referredness decision in `docs/ARCHITECTURE.md` §1a: the
 * input is a JPEG, which already carries the camera's rendering, and no
 * transform recovers what it discarded. The consequence has to be stated plainly
 * because it changes what the datasheet work is for:
 *
 * **A digitised datasheet curve will not reproduce its published behaviour
 * here.** It is a starting shape to be tuned by eye, not a calibration to be
 * matched. Matching one numerically buys nothing that survives the tuning that
 * has to happen anyway.
 *
 * What does survive is the **relative separation between the three channels**.
 * The domain warp between scene- and display-referred applies equally to all
 * three, so the vertical distance between the R, G and B curves keeps its
 * character even as their absolute positions shift. That separation is the
 * crossover, and the crossover is the stock's identity.
 *
 * # Why three curves and not one
 *
 * A single shared RGB curve is a contrast adjustment. It cannot produce
 * **colour crossover** — shadows drifting one way and highlights the other, with
 * the drift changing across the exposure range — because crossover *is* the
 * difference between the channels. Its absence is why lookup-table film
 * emulations read as flat: they get the tonality and none of the character.
 *
 * # Names
 *
 * The stocks below are described rather than named. Real stock names are
 * trademarks, and a look tuned by eye against a domain the datasheet was not
 * written for has no business borrowing one.
 */

import { fitControlPoints } from './curve'
import { ACESCCT_LOG_SCALE, encodeACEScct } from './transfer'
import { MIDDLE_GREY_LINEAR } from './grade'

/** The bottom of the curve domain: ACEScct of zero light. */
export const FILM_DOMAIN_LOW = encodeACEScct(0)
export const FILM_DOMAIN: readonly [number, number] = [FILM_DOMAIN_LOW, 1]

export interface FilmStock {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Interleaved `[x, y, ...]` control points, over {@link FILM_DOMAIN}. */
  readonly red: readonly number[]
  readonly green: readonly number[]
  readonly blue: readonly number[]
}

/**
 * Build a stock's channel from a curve read off a graph.
 *
 * The entry point a digitiser feeds. Dense samples are reduced to control points
 * that reproduce them within `tolerance`, placed where the curve bends rather
 * than spread evenly — see `fitControlPoints`.
 */
export function channelFromSamples(
  xs: readonly number[],
  ys: readonly number[],
  tolerance = 2e-3,
): number[] {
  const fitted = fitControlPoints(xs, ys, tolerance)
  const interleaved: number[] = []
  for (let i = 0; i < fitted.xs.length; i++) {
    interleaved.push(fitted.xs[i] ?? Number.NaN, fitted.ys[i] ?? Number.NaN)
  }
  return interleaved
}

const LO = FILM_DOMAIN_LOW

/** Interleave a shared x axis with one channel's y values. */
function channel(xs: readonly number[], ys: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < xs.length; i++) out.push(xs[i] ?? Number.NaN, ys[i] ?? Number.NaN)
  return out
}

/**
 * All three channels start at the same point, so **black stays black**.
 *
 * Real emulsion has a base density and its shadows are not neutral, which is
 * part of the look. It is deliberately not reproduced at the very bottom: a
 * coloured pure black reads as a bug rather than as a stock, and it is the first
 * thing anyone checks. Crossover begins just above black instead, where it is
 * legible as character.
 */
/**
 * Middle grey in ACEScct, and the width of one stop in that encoding.
 *
 * ACEScct's log segment has a fixed scale, so a stop is a constant distance
 * along it — `1 / 17.52` — which is what makes "two stops above grey" a
 * position rather than an estimate.
 */
export const MIDDLE_GREY_ACESCCT = encodeACEScct(MIDDLE_GREY_LINEAR)
export const STOP_IN_ACESCCT = 1 / ACESCCT_LOG_SCALE

/** A position on the curve, in stops relative to middle grey. */
export function stopsFromGrey(stops: number): number {
  return MIDDLE_GREY_ACESCCT + stops * STOP_IN_ACESCCT
}

/**
 * Display white, in ACEScct: 2.47 stops above middle grey, since 1 / 0.18 is
 * 5.56.
 *
 * **This is where the useful range ends.** The domain runs to 1.0, which decodes
 * to a linear value of about 223 — nearly eight stops past display white — so
 * more than half of it is above anything a display-referred picture contains.
 */
export const DISPLAY_WHITE_ACESCCT = encodeACEScct(1)

/**
 * # Control points are placed in stops from middle grey, not by occupancy
 *
 * An earlier version distributed them across the range one test image happened
 * to occupy. That fixed a worse bug — points spread evenly over a domain whose
 * top half contains no pixels — but replaced it with a subtler one: the stocks
 * had no defined reference, so a "correctly exposed" image landed wherever the
 * previous image had, and the strength of the look varied by a factor of six
 * across a single stop of exposure.
 *
 * Real film has a nominal exposure it is designed around. These now do too:
 *
 * - **Middle grey is a fixed point of every stock, in every channel.** A
 *   correctly exposed midtone comes out exactly where it went in, so exposure
 *   moves the image along the curves from a defined origin rather than from an
 *   arbitrary one — and a correctly exposed skin tone does not shift hue, which
 *   is where crossover usually goes wrong.
 * - **Stocks become comparable.** All three agree at grey, so a difference
 *   between them is a difference in character rather than in where they happen
 *   to sit.
 *
 * The spacing runs from four stops under grey to display white, with the domain
 * endpoints kept so the curve stays defined outside that.
 */
const SHARED_X = [
  LO,
  stopsFromGrey(-4),
  stopsFromGrey(-2.5),
  stopsFromGrey(-1.25),
  MIDDLE_GREY_ACESCCT,
  stopsFromGrey(1.25),
  DISPLAY_WHITE_ACESCCT,
  1,
]

/** The index of the middle-grey anchor within {@link SHARED_X}. */
export const GREY_ANCHOR_INDEX = 4

export const FILM_STOCKS: readonly FilmStock[] = [
  {
    id: 'warm-portrait',
    name: 'Warm portrait',
    description:
      'Cool shadows against warm highlights, with a soft toe. The classic colour ' +
      'negative crossover, and the gentlest of the three.',
    // Blue sits above red in the shadows and below it at display white, so the
    // drift reverses across the range the picture actually occupies. That
    // reversal is the crossover.
    red: channel(SHARED_X, [LO, 0.178, 0.264, 0.339, MIDDLE_GREY_ACESCCT, 0.492, 0.57, 1.0]),
    green: channel(SHARED_X, [LO, 0.18527, 0.27089, 0.34224, MIDDLE_GREY_ACESCCT, 0.48494, 0.5548, 0.98]),
    blue: channel(SHARED_X, [LO, 0.193, 0.278, 0.3455, MIDDLE_GREY_ACESCCT, 0.478, 0.54, 0.96]),
  },
  {
    id: 'punchy-reversal',
    name: 'Punchy reversal',
    description:
      'High contrast with a hard shoulder, cyan-leaning shadows and a warm, ' +
      'quickly saturating top end. Reversal film rather than negative.',
    red: channel(SHARED_X, [LO, 0.168, 0.252, 0.332, MIDDLE_GREY_ACESCCT, 0.505, 0.6, 1.0]),
    green: channel(SHARED_X, [LO, 0.178, 0.261, 0.337, MIDDLE_GREY_ACESCCT, 0.497, 0.582, 0.99]),
    blue: channel(SHARED_X, [LO, 0.195, 0.276, 0.343, MIDDLE_GREY_ACESCCT, 0.488, 0.562, 0.96]),
  },
  {
    id: 'muted-documentary',
    name: 'Muted documentary',
    description:
      'Low contrast with lifted shadows and a long, flat midsection. Green ' +
      'shadows against magenta highlights, which reads as older stock.',
    // The reversal runs green to magenta rather than blue to warm. An earlier
    // version had green leading at both ends, which drifts and still is not
    // crossover — it is a green cast that warms slightly, and telling those two
    // apart is exactly what the direction assertion exists for.
    red: channel(SHARED_X, [LO, 0.192, 0.274, 0.343, MIDDLE_GREY_ACESCCT, 0.478, 0.538, 0.92]),
    green: channel(SHARED_X, [LO, 0.206, 0.283, 0.348, MIDDLE_GREY_ACESCCT, 0.47, 0.522, 0.88]),
    blue: channel(SHARED_X, [LO, 0.194, 0.275, 0.3435, MIDDLE_GREY_ACESCCT, 0.477, 0.536, 0.91]),
  },
]

/** The identity for one channel: two points, output equals input. */
export const IDENTITY_CHANNEL: readonly number[] = [LO, LO, 1, 1]

export function isIdentityChannel(points: readonly number[]): boolean {
  return (
    points.length === IDENTITY_CHANNEL.length &&
    points.every((v, i) => v === IDENTITY_CHANNEL[i])
  )
}

export function findFilmStock(id: string): FilmStock | undefined {
  return FILM_STOCKS.find((stock) => stock.id === id)
}
