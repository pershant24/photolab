/**
 * Film grain: density modulation, size, and the limit of what a proxy can show.
 *
 * # Grain is a variation in density, not a noise overlay
 *
 * Physically it is the statistical variation in how many silver halide crystals
 * developed. Where almost none did (deep shadow) or almost all did (blown
 * highlight) there is little room for variation and the image is smooth; the
 * variance peaks in between. That is why grain is built after the characteristic
 * curves — density does not exist until they have produced it — and why the
 * modulation below is the substance of the effect rather than a refinement of
 * it. A uniform overlay has none of these properties and reads as digital noise.
 *
 * It is applied as a perturbation of the **log** value (ACEScct) rather than of
 * linear light, for the same reason: density is a logarithmic quantity, so a
 * fixed swing in density is a fixed swing in stops, not a fixed number of
 * photons. Perturbing linear light would make grain invisible in the shadows and
 * enormous in the highlights, which is backwards.
 */

import { MIDDLE_GREY_ACESCCT, STOP_IN_ACESCCT } from './filmStock'
import { DISPLAY_WHITE_STOPS_ABOVE_GREY } from './halation'

/**
 * Where grain is most visible, in stops from middle grey.
 *
 * **Anchored, not emergent.** The obvious construction — normalise the encoded
 * value over the range the data occupies and peak at the midpoint — was rejected
 * because that midpoint is a fact about where ACEScct's log/linear splice falls,
 * not about film. It lands 1.75 stops under grey for reasons that have nothing
 * to do with emulsion, and an occupancy assertion against it would only be
 * restating the encoding back to itself.
 *
 * Zero, so grain peaks on a correctly exposed midtone. That is the same anchor
 * the film stocks use as a fixed point, and it makes the claim checkable by
 * looking at a photograph.
 *
 * It also measures better than either emergent alternative, on the two
 * photographs in `tests/fixtures/luminance-histograms.ts`. Share of the frame
 * carrying grain, weighted by this modulation:
 *
 *   peak at grey            night 50.5%   talk 47.9%   spread  2.6 points
 *   peak at -1.75 stops     night 25.9%   talk 17.0%   spread  8.9 points
 *   peak at +1.51 stops     night 39.9%   talk 74.8%   spread 34.9 points
 *
 * The anchored version is the only one that behaves the same on a low-key frame
 * and a high-key one, which is what a property of the emulsion should do — the
 * encoded midpoint also puts grain on barely a fifth of a lit interior, and the
 * `[0, 1]` midpoint puts it on three quarters.
 */
export const GRAIN_PEAK_STOPS_FROM_GREY = 0

/**
 * How far the modulation reaches below and above the peak, in stops.
 *
 * Asymmetric, and not as a tuning choice: there are only
 * {@link DISPLAY_WHITE_STOPS_ABOVE_GREY} stops between middle grey and display
 * white, against far more range beneath it. A symmetric falloff would either
 * stop short of the shadows or run past the top of the encoding.
 */
export const GRAIN_TOE_STOPS = 4
export const GRAIN_SHOULDER_STOPS = DISPLAY_WHITE_STOPS_ABOVE_GREY

/** Smoothstep, matching the GLSL builtin. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Grain visibility at a position given in stops from middle grey.
 *
 * One at the peak, zero at and beyond the toe and shoulder reaches, with zero
 * slope at both ends so the modulation does not leave a visible edge where it
 * runs out.
 */
export function grainDensityModulation(stopsFromGrey: number): number {
  const offset = stopsFromGrey - GRAIN_PEAK_STOPS_FROM_GREY
  const reach = offset < 0 ? GRAIN_TOE_STOPS : GRAIN_SHOULDER_STOPS
  return 1 - smoothstep(0, 1, Math.min(1, Math.abs(offset) / reach))
}

/** The same, for a value already encoded as ACEScct. */
export function grainDensityModulationFromEncoded(encoded: number): number {
  return grainDensityModulation((encoded - MIDDLE_GREY_ACESCCT) / STOP_IN_ACESCCT)
}

/**
 * The largest density swing grain applies, in ACEScct units, at full strength.
 *
 * 0.012 is about a fifth of a stop, which is heavy for a modern stock and about
 * right for a pushed one. The slider reaches it because the coarse, obvious end
 * is a legitimate look; the default sits well below.
 */
export const GRAIN_MAX_DENSITY_SWING = 0.012

/**
 * Per-channel size multipliers.
 *
 * The three emulsion layers have different crystal sizes, and the difference is
 * why film grain is coloured rather than monochrome. The blue-sensitive layer is
 * the coarsest of the three in most colour stocks and the green the finest,
 * which is also the order that matters least perceptually — the eye's luminance
 * response is dominated by green, so the finest layer carries most of the
 * apparent sharpness.
 *
 * The three channels are also given **independent** noise. Sharing one value
 * across all three produces luminance noise, which is what digital sensors make
 * and what film does not.
 */
export const GRAIN_CHANNEL_SIZES: readonly [number, number, number] = [1, 0.88, 1.18]

/**
 * # The proxy cannot show fine grain, and should not pretend to
 *
 * Grain has a physical size, expressed here as a fraction of the source long
 * edge so that it is the same size on a proxy and on an export. That is the same
 * rule as every other spatial parameter, and for grain it collides with sampling
 * in a way the others do not: a few source pixels is below the proxy's Nyquist
 * frequency, so the preview cannot represent it at all.
 *
 * Sampled naively, a hash below Nyquist does not vanish — it returns
 * uncorrelated values at whatever rate it is sampled, which is full-amplitude
 * noise one buffer pixel across. On a 2048px proxy of a 9500px source that is
 * grain nearly ten times too coarse: the preview would show a heavy, crawling
 * pattern for an export that is nearly smooth.
 *
 * So the amplitude is faded out as the period approaches the sampling rate. This
 * is the standard treatment for procedural noise and it is a deliberate reading
 * of the requirement: at the limit the preview shows *less* grain rather than
 * *wrong* grain. It is honest in the direction that matters — the preview
 * understates an effect it cannot draw, instead of overstating one it cannot.
 *
 * Both the shipped behaviour and the reported divergence threshold come from the
 * two constants below, so the number in the documentation cannot drift away from
 * the number in the shader.
 */

/** Period, in buffer pixels, at or above which grain is drawn at full amplitude. */
export const GRAIN_FULL_AMPLITUDE_PERIOD = 2
/** Period, in buffer pixels, at or below which grain is not drawn at all. */
export const GRAIN_VANISHED_PERIOD = 1

/** Amplitude scale for a grain period measured in buffer pixels. */
export function grainAmplitudeScale(periodInBufferPixels: number): number {
  return smoothstep(GRAIN_VANISHED_PERIOD, GRAIN_FULL_AMPLITUDE_PERIOD, periodInBufferPixels)
}

/**
 * The grain size, in **source** pixels, below which a buffer diverges from a
 * full-resolution render.
 *
 * `bufferScale` is buffer pixels per source pixel — the same quantity the
 * spatial passes derive from `uSourceRect`.
 */
export function grainDivergenceSourcePixels(bufferScale: number): number {
  return GRAIN_FULL_AMPLITUDE_PERIOD / bufferScale
}

/** Grain period in source pixels, from the size parameter and the image. */
export function grainPeriodSourcePixels(grainSize: number, sourceLongEdge: number): number {
  return grainSize * sourceLongEdge
}
