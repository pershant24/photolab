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
import { encodeACEScct } from './transfer'

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
 * Display white, in ACEScct. **This is where the useful range ends.**
 *
 * The domain runs to 1.0, which decodes to a linear value of about 223 — nearly
 * eight stops above display white. A display-referred image occupies only
 * `[FILM_DOMAIN_LOW, 0.5548]`, so **more than half the domain is above anything
 * the picture contains**, and control points placed evenly across it spend most
 * of themselves on tones that do not exist.
 *
 * That was the first version's mistake, and it did not look like one: the curves
 * were valid, the arithmetic agreed with the shader, and the crossover
 * measurement came out weak for a reason that read as the stocks being too
 * subtle. What was actually happening is that the sample called "highlight" — a
 * linear value of 1.4 — encodes to 0.58, which sat on the crossover point rather
 * than past it. The control points are now distributed over the range the image
 * occupies, with one point beyond it to keep the curve defined.
 */
export const DISPLAY_WHITE_ACESCCT = encodeACEScct(1)

const SHARED_X = [LO, 0.17, 0.29, 0.41, 0.5, DISPLAY_WHITE_ACESCCT, 1]

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
    red: channel(SHARED_X, [LO, 0.155, 0.278, 0.408, 0.508, 0.566, 1.0]),
    green: channel(SHARED_X, [LO, 0.17, 0.29, 0.41, 0.5, 0.5548, 0.98]),
    blue: channel(SHARED_X, [LO, 0.185, 0.302, 0.412, 0.492, 0.545, 0.96]),
  },
  {
    id: 'punchy-reversal',
    name: 'Punchy reversal',
    description:
      'High contrast with a hard shoulder, cyan-leaning shadows and a warm, ' +
      'quickly saturating top end. Reversal film rather than negative.',
    red: channel(SHARED_X, [LO, 0.13, 0.255, 0.415, 0.535, 0.6, 1.0]),
    green: channel(SHARED_X, [LO, 0.15, 0.27, 0.412, 0.52, 0.583, 0.99]),
    blue: channel(SHARED_X, [LO, 0.175, 0.288, 0.41, 0.505, 0.565, 0.96]),
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
    red: channel(SHARED_X, [LO, 0.18, 0.295, 0.4, 0.487, 0.54, 0.92]),
    green: channel(SHARED_X, [LO, 0.215, 0.318, 0.405, 0.47, 0.515, 0.88]),
    blue: channel(SHARED_X, [LO, 0.187, 0.298, 0.402, 0.483, 0.535, 0.91]),
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
