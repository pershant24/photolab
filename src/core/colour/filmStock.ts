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
  /**
   * A black and white emulsion: its three curves are identical, deliberately.
   *
   * Declared rather than inferred from the curves being equal. Inferring it
   * would make "this stock is monochrome" and "this stock's curves happen to
   * match" the same statement, and the second is a defect the first is not —
   * `tests/unit/film-stock.test.ts` asserts each direction against the other.
   *
   * The crossover assertions are skipped for these, because a monochrome frame
   * has no crossover to have. That makes the identical-curves assertion the only
   * thing standing between a black and white stock and a quiet colour cast,
   * which is why it is asserted rather than assumed.
   */
  readonly monochrome?: boolean
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

/**
 * The x axis the reversal stocks use, and why it is not {@link SHARED_X}.
 *
 * Reversal film terminates: its highlights compress over roughly one stop and
 * then the curve stops rising. `SHARED_X` cannot express that. Its points above
 * grey are +1.25, +2.47 and then +10.27, so the shoulder and the whole flat top
 * would have to be carried by one enormous span, and a spline across it drifts
 * instead of holding still.
 *
 * So the reversal stocks put their points where their shape is: four of them
 * between +0.8 and +3.4, which is the stop and a half the shoulder occupies plus
 * enough beyond it to pin the curve flat.
 *
 * This is the occupancy rule pointed at a control-point layout rather than at a
 * parameter domain. `SHARED_X` was placed for curves that are straight through
 * the highlights; using it for curves that are not would put most of the
 * interesting behaviour in one unconstrained gap.
 */
const REVERSAL_X = [
  LO,
  stopsFromGrey(-4),
  stopsFromGrey(-2.5),
  stopsFromGrey(-1.25),
  MIDDLE_GREY_ACESCCT,
  stopsFromGrey(0.8),
  stopsFromGrey(1.4),
  stopsFromGrey(2),
  stopsFromGrey(2.6),
  stopsFromGrey(3.4),
  1,
]

/**
 * One reversal channel, built from its shape rather than digitised from a graph.
 *
 * The negatives are literal y arrays because they were read off curves. These
 * are constructed, and the construction is the documentation: a straight section
 * at `gamma` through the midtones, a shoulder that gives up its slope over a
 * stop and a half, and a floor the toe settles onto.
 *
 * Writing them as literals would hide exactly the property that makes them
 * reversal — `curveShape.ts` measures it back out, and the assertion in
 * `tests/unit/film-stock.test.ts` is what stops a later edit turning one of
 * these into a contrasty negative while it keeps the name.
 */
function reversalChannel(shape: {
  /** Slope of the straight section, in output per stop of exposure. */
  gamma: number
  /** Output four stops under grey: the deep black reversal is bought for. */
  floor: number
  /** Output two and a half stops under grey, where the toe leaves the line. */
  toe: number
  /** Slope through the three shoulder segments, as a fraction of gamma. */
  shoulder: readonly [number, number, number]
}): number[] {
  const line = (stops: number): number =>
    MIDDLE_GREY_ACESCCT + shape.gamma * stops * STOP_IN_ACESCCT
  const [a, b, c] = shape.shoulder
  const atShoulderStart = line(1.4)
  const at2 = atShoulderStart + a * shape.gamma * 0.6 * STOP_IN_ACESCCT
  const at26 = at2 + b * shape.gamma * 0.6 * STOP_IN_ACESCCT
  const at34 = at26 + c * shape.gamma * 0.8 * STOP_IN_ACESCCT
  const ys = [
    LO,
    shape.floor,
    shape.toe,
    line(-1.25),
    MIDDLE_GREY_ACESCCT,
    line(0.8),
    atShoulderStart,
    at2,
    at26,
    at34,
    // Barely above the previous point across a span of seven stops: that near
    // zero slope is what "terminates" means, and it is what the shoulder-extent
    // measurement reads.
    at34 + 4e-4,
  ]
  return channel(REVERSAL_X, ys)
}

/**
 * One monochrome channel: a negative shape, since black and white film is a
 * negative.
 *
 * It does terminate, and saying otherwise would be a comment contradicting its
 * own measurement — the census reads 7.6 stops of shoulder here against
 * `Infinity` for the colour negatives and 1.3 for the reversal stocks. What
 * separates it from reversal is not whether it terminates but how long it takes:
 * six times longer, which is what enormous highlight latitude looks like when
 * you measure it.
 *
 * Built rather than digitised for the same reason the reversal channels are —
 * the shape is the documentation — but over {@link SHARED_X}, because without a
 * shoulder to resolve there is nothing the denser reversal axis would buy.
 */
function monochromeChannel(gamma: number, floor: number): number[] {
  const line = (stops: number): number =>
    MIDDLE_GREY_ACESCCT + gamma * stops * STOP_IN_ACESCCT
  return channel(SHARED_X, [
    LO,
    floor,
    // The toe: a shallower approach to the floor than the straight section, so
    // the deepest shadows compress rather than clipping to black.
    (floor + line(-2.5)) / 2,
    line(-1.25),
    MIDDLE_GREY_ACESCCT,
    line(1.25),
    line(2.47),
    // Above display white the curve keeps climbing, gently. A black and white
    // negative has enormous highlight latitude, which is most of why people
    // shoot it.
    Math.min(1, line(2.47) + 0.3 * gamma * (1 - DISPLAY_WHITE_ACESCCT)),
  ])
}

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
    id: 'punchy-negative',
    name: 'Punchy negative',
    /*
     * Renamed, not reshaped, and the measurement is why.
     *
     * It shipped as "Punchy reversal" describing "a hard shoulder ... reversal
     * film rather than negative". `curveShape.ts` says otherwise: at four stops
     * over grey it is still climbing at **90% of its midtone gamma**, and its
     * slope never falls to a twentieth of that anywhere in the domain. It does
     * not terminate. It is a contrasty negative, and contrast is not what
     * separates the families — a high-gamma negative looks punchy and still
     * rolls off asymptotically for as long as you can expose it.
     *
     * Reshaping it was the other option and was rejected. The curve is a good
     * punchy negative; the only thing wrong with it was the claim on the label.
     * Reshaping would have thrown away a working look to rescue a name, and the
     * library needed genuine reversal stocks either way — which are now beside
     * it rather than instead of it.
     */
    description:
      'High contrast with cyan-leaning shadows and a warm top end. A colour ' +
      'negative: it keeps climbing rather than terminating, measured at 90% of ' +
      'its midtone gamma four stops over grey.',
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

  /*
   * The reversal stocks.
   *
   * Both terminate — their slope falls to a twentieth of the midtone gamma
   * within a stop and a half of leaving the straight section — which is the
   * property that separates them from every negative above, and the property
   * the library previously claimed without having.
   *
   * They differ from each other in the two ways that matter. Their crossover
   * runs in OPPOSITE directions, which is the only pair in the library that
   * does: one is warm in the shadows and cools into the highlights, the other
   * the reverse. And their gamma differs by a sixth, so one is a transparency
   * you could still print from and the other is the contrastiest thing here.
   */
  {
    id: 'vivid-reversal',
    name: 'Vivid reversal',
    description:
      'Saturated transparency with a deep black and highlights that terminate ' +
      'rather than roll off. Warm shadows cooling through the top end, which is ' +
      'the opposite drift to the negatives here.',
    // Red the shallowest, so it sits highest in the shadows and lowest in the
    // highlights: warm below, cool above.
    red: reversalChannel({ gamma: 1.58, floor: 0.094, toe: 0.184, shoulder: [0.9, 0.25, 0.03] }),
    green: reversalChannel({ gamma: 1.7, floor: 0.086, toe: 0.172, shoulder: [0.9, 0.25, 0.03] }),
    blue: reversalChannel({ gamma: 1.82, floor: 0.078, toe: 0.16, shoulder: [0.9, 0.25, 0.03] }),
  },
  {
    id: 'cool-reversal',
    name: 'Cool reversal',
    description:
      'The contrastiest stock here, with a near-black floor and a hard ' +
      'termination. Cyan shadows against warm highlights, carried much further ' +
      'than the gentler negatives take it.',
    // Red the steepest this time, so the drift runs the other way. The shoulder
    // is also tighter, which is what makes this the harder clip of the two.
    red: reversalChannel({ gamma: 2.04, floor: 0.072, toe: 0.144, shoulder: [0.75, 0.18, 0.02] }),
    green: reversalChannel({ gamma: 1.94, floor: 0.079, toe: 0.154, shoulder: [0.75, 0.18, 0.02] }),
    blue: reversalChannel({ gamma: 1.84, floor: 0.086, toe: 0.164, shoulder: [0.75, 0.18, 0.02] }),
  },

  /*
   * The monochrome stocks.
   *
   * Three identical curves each, which is the whole point: the channel mixer has
   * already collapsed the frame to one value by the time these run, so three
   * different curves would put colour back into a black and white photograph.
   *
   * What separates these three is mostly NOT here. The mixer weights are the
   * coloured filter on the lens and they live on the preset in
   * `axisLibrary.ts`; these carry the contrast and the density floor. That split
   * is deliberate and it is why three monochrome stocks need only as many curve
   * sets as they have distinct tonalities.
   */
  {
    id: 'mono-panchromatic',
    name: 'Panchromatic monochrome',
    monochrome: true,
    description:
      'An even-tempered black and white emulsion: mild contrast, a long ' +
      'straight section and shadows that keep their detail rather than blocking.',
    red: monochromeChannel(1.08, 0.126),
    green: monochromeChannel(1.08, 0.126),
    blue: monochromeChannel(1.08, 0.126),
  },
  {
    id: 'mono-filtered',
    name: 'Filtered monochrome',
    monochrome: true,
    description:
      'Built to be used with a heavy red weighting, which darkens a blue sky ' +
      'and opens skin. Slightly firmer than the panchromatic stock so the ' +
      'separation the filter creates is not then flattened.',
    red: monochromeChannel(1.22, 0.118),
    green: monochromeChannel(1.22, 0.118),
    blue: monochromeChannel(1.22, 0.118),
  },
  {
    id: 'mono-hard',
    name: 'Hard monochrome',
    monochrome: true,
    description:
      'Pushed: steep, with a near-black floor and highlights that go to paper ' +
      'white quickly. The gritty end of black and white rather than the ' +
      'descriptive end.',
    red: monochromeChannel(1.72, 0.088),
    green: monochromeChannel(1.72, 0.088),
    blue: monochromeChannel(1.72, 0.088),
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
