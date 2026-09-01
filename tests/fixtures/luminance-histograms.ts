/**
 * Luminance histograms of two real photographs.
 *
 * # Why a histogram and not a photograph
 *
 * The occupancy rule needs to check parameter ranges and fixture labels against
 * where data in a real image actually lives, which needs a real image. Checking
 * in the photographs themselves is the obvious way and the wrong one: this
 * repository is intended to go public for Pages, a JPEG is permanent once
 * pushed, and these are personal photographs of identifiable people. A
 * histogram is not invertible — it carries the distribution and no picture.
 *
 * # What is binned
 *
 * The **same quantity `halationThreshold.frag` compares against**: ACEScg
 * luminance under AP1 weights, after sRGB decode and the primaries matrix, with
 * the bins in stops from middle grey. Binning something merely similar — Rec.709
 * weights on sRGB-linear, say — would make every assertion below a statement
 * about a domain no parameter controls.
 *
 * Generated from the two photographs used for the halation look:
 *
 * - `night` — a flash-lit night scene. White cotton shirts against dark sand:
 *   the brightest thing in the frame is not a light source, which is the case a
 *   highlight threshold most easily gets wrong.
 * - `talk` — a lit room. An emissive LED panel and ceiling spill against white
 *   painted brick, so genuinely bright and merely light-toned sit side by side.
 *
 * Both are 8-bit display-referred JPEGs, which is the whole point: neither
 * contains any value above display white at +2.474 stops, and no photograph of
 * that kind can.
 */

/** Lower edge of the first bin, in stops from middle grey. */
export const HISTOGRAM_LO = -8
/** Upper edge of the last bin, in stops from middle grey. */
export const HISTOGRAM_HI = 4
export const HISTOGRAM_BINS = 240

export const LUMINANCE_HISTOGRAMS: Readonly<Record<'night' | 'talk', readonly number[]>> = {
  night: [0,0,211,126,1,0,43,137843,4729,0,1,11123,16,2726,141,40072,50949,6,0,14598,10090,41,40042,9,15733,19893,1176,53,16584,10922,29634,78,5757,17642,20373,151,3180,35930,428,1057,39874,3902,6240,26396,3415,3978,21149,6081,7847,7533,5902,16188,7037,15062,5281,4650,17902,5180,19497,4495,17382,5288,2681,22170,3496,19602,3246,16374,3497,15232,4995,15474,11999,4349,11907,2952,10583,2880,10594,8752,4769,7432,3023,8351,6715,2558,6669,5988,2386,7036,5578,5320,5291,5694,7372,3727,8255,7050,6370,7623,5268,9912,9028,9331,10406,9800,5304,9319,8960,8342,8682,8422,7967,7387,6186,7602,6939,6835,7779,6874,6964,7150,7824,9626,9625,10441,12749,10893,10576,10260,11575,10308,10053,11378,15280,12815,17334,16741,15746,23980,18729,23702,20660,21436,24390,23735,25071,23462,18797,22278,24752,24008,28046,30549,27157,29126,32034,29191,28752,28530,28294,26067,29485,35866,41929,54319,57731,68179,64859,54516,44111,42893,31636,30364,35207,23646,23657,18278,17104,15669,16814,17005,16505,17852,18466,22773,26126,21355,21029,21876,22168,16331,8743,6073,3884,2824,4333,2052,282,111,16,12,6,4,6,20,18,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  talk: [111,145,1176,161,733,1263,324,1401,1980,100,267,772,346,794,1799,1296,1323,185,374,851,1920,1368,2081,295,787,1200,2242,1682,737,794,1036,2517,1218,950,920,2205,1220,1124,2010,1213,1427,1813,1366,1360,2088,1177,1462,2364,886,1355,2028,1191,1818,1125,1615,1315,1442,1827,1241,1544,1211,1402,1423,1269,1523,1366,1468,1201,1645,1313,1419,1480,1531,1887,1477,2075,1886,2269,1610,2361,1915,2345,3322,2025,3352,4146,2816,4229,4660,3542,3315,4740,4286,3698,4081,4328,3990,3973,4022,4434,3927,4685,3656,4779,5007,5571,5891,6426,6640,6980,6603,6271,6754,7811,7727,7713,7760,8706,8582,11295,10259,9258,8747,8927,8949,7958,9177,9081,7828,7473,7491,7796,6764,6842,7213,7465,7152,8026,8320,8039,8561,8594,9379,9274,10732,11871,12641,11760,12394,12919,12464,12571,13330,13798,13993,14143,13932,13583,13873,13927,14044,14479,15160,16277,18393,19767,18652,19554,19973,21767,25050,27545,28855,31108,37302,46284,42068,38918,39130,44617,47943,45216,45888,47968,51663,64049,63546,70639,75663,81313,87260,101602,88007,96039,85726,61189,66522,75577,85133,30260,23799,19960,13528,9450,3880,2158,3975,2345,3552,695,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
}

/** Bin index a position in stops from middle grey falls in. */
export function histogramBin(stopsFromGrey: number): number {
  return Math.floor(((stopsFromGrey - HISTOGRAM_LO) / (HISTOGRAM_HI - HISTOGRAM_LO)) * HISTOGRAM_BINS)
}

/** Centre of a bin, in stops from middle grey. */
export function binCentre(bin: number): number {
  const width = (HISTOGRAM_HI - HISTOGRAM_LO) / HISTOGRAM_BINS
  return HISTOGRAM_LO + (bin + 0.5) * width
}

/** Fraction of an image at or above a position, in stops from middle grey. */
export function fractionAbove(histogram: readonly number[], stopsFromGrey: number): number {
  const from = Math.max(0, histogramBin(stopsFromGrey))
  let above = 0
  let total = 0
  for (let i = 0; i < histogram.length; i++) {
    total += histogram[i] ?? 0
    if (i >= from) above += histogram[i] ?? 0
  }
  return total === 0 ? 0 : above / total
}

/** Fraction between two positions, in stops from middle grey. */
export function fractionBetween(
  histogram: readonly number[],
  lowStops: number,
  highStops: number,
): number {
  return fractionAbove(histogram, lowStops) - fractionAbove(histogram, highStops)
}
