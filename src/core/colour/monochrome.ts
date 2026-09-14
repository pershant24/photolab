/**
 * The channel mixer: panchromatic sensitivity, which is what makes a black and
 * white emulsion black and white.
 *
 * # It is an emulsion property, so it is in the film stage
 *
 * A monochrome film is not a colour film with the colour removed afterwards. It
 * is a single layer whose sensitivity to each wavelength is fixed at manufacture,
 * and everything downstream — the characteristic curve, the grain, the print —
 * acts on the one channel that sensitivity produced.
 *
 * So the mixer runs in the **film stage, before the characteristic curves**, and
 * the curves then act on a single value replicated across three channels.
 *
 * # After halation, and that is the interesting half of the placement
 *
 * The obvious reading of "before the curves" would put it first in the film
 * stage. It goes after halation instead, because halation is *light*: it
 * scatters off the film base and re-exposes the emulsion from behind, and the
 * emulsion records that scattered light through the same spectral sensitivity as
 * everything else. A mixer running before halation would leave a warm halo on a
 * black and white frame.
 *
 * The same argument carries two effects with it for free. A light leak and a
 * date stamp both inject before the film stage, so both are collapsed to grey by
 * the mixer — which is correct, and is what those things look like on black and
 * white film. Neither needed a line of code.
 *
 * # Why the weights are the interesting parameter
 *
 * They are the coloured filter a photographer screwed onto the lens. Weighting
 * red heavily darkens a blue sky and lightens skin; weighting blue does the
 * opposite, which is the look of early orthochromatic film and of a lot of
 * gritty reportage. One triple of numbers produces several recognisably
 * different stocks, which is why three monochrome presets do not need three
 * curve sets to be distinct.
 */

/**
 * The weights are normalised, and that is load-bearing rather than tidiness.
 *
 * Dividing by their sum makes the mixer **exactly neutral-preserving**: for
 * `r = g = b = v` the output is `v * (wr + wg + wb) / (wr + wg + wb)`, which is
 * `v`. So a grey card comes out the same grey, middle grey stays anchored where
 * every stock's curves expect it, and the mixer cannot change exposure as a side
 * effect of changing colour response.
 *
 * Without it, weights summing to 1.2 would be a mixer and a third of a stop of
 * exposure at the same time, and nobody setting a red filter means that.
 */
export function normaliseMix(mix: readonly number[]): [number, number, number] {
  const sum = (mix[0] ?? 0) + (mix[1] ?? 0) + (mix[2] ?? 0)
  if (sum <= 0) return [0, 0, 0]
  return [(mix[0] ?? 0) / sum, (mix[1] ?? 0) / sum, (mix[2] ?? 0) / sum]
}

/**
 * Whether the mixer is doing anything.
 *
 * All zeros is the off state rather than a separate switch. It cannot be
 * confused with a legitimate setting: weights are relative, so a mixer that
 * takes nothing from any channel has no meaning to express.
 */
export function isMonochrome(mix: readonly number[]): boolean {
  return (mix[0] ?? 0) + (mix[1] ?? 0) + (mix[2] ?? 0) > 0
}

/*
 * There is deliberately no `mixToLuminance` reference implementation here.
 *
 * Step 5 of the add-a-pass recipe says non-trivial maths goes in TypeScript
 * first, gets unit tested, and is then asserted to agree with the shader. The
 * non-trivial part of this pass is the normalisation, and it happens **on the
 * CPU** — `normaliseMix` above, called once per frame by the pass. What reaches
 * the shader is a `dot` of three pre-normalised weights, which has nothing left
 * to diverge from.
 *
 * A reference function for that dot product would be a pure function nothing
 * calls, which is precisely the shape that drifts from the shader it claims to
 * mirror while every test stays green. `tests/golden/monochrome.spec.ts` asserts
 * the property that matters end to end instead.
 */
