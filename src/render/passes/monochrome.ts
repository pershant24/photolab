/**
 * The channel mixer pass.
 *
 * Film stage, after halation and before the characteristic curves. The physical
 * argument is in `src/core/colour/monochrome.ts`; the position is asserted in
 * `tests/unit/pass-positions.test.ts`.
 *
 * # What happens to the per-channel crossover machinery
 *
 * Nothing is bypassed. A monochrome stock carries **three identical
 * characteristic curves**, they bake into three identical lookup tables, and the
 * film pass samples all three exactly as it does for a colour stock. That is a
 * deliberate choice over a dedicated single-channel path, for two reasons.
 *
 * The first is the one this project keeps making: a second path through the film
 * stage is a second implementation to keep in agreement with the first, and the
 * saving is two texture fetches per pixel in a stage that already runs several
 * separable blurs.
 *
 * The second is better. Three curves acting on one channel is not waste, it is
 * **toning** — it is exactly how a sepia or selenium print is built, and it
 * would be unreachable behind a single-channel path. The machinery is not idle
 * on a monochrome stock so much as unused for now.
 *
 * `tests/unit/film-stock.test.ts` asserts the three are identical for every
 * stock marked monochrome, rather than trusting it: three curves that drifted
 * apart would give a black and white stock a quiet colour cast, and the
 * crossover assertions are skipped for exactly these stocks so nothing else
 * would catch it.
 */

import monochromeSource from '../shaders/monochrome.frag'
import { isMonochrome, normaliseMix } from '../../core/colour/monochrome'
import type { Pass, RenderInput } from './types'

export const monochromePass: Pass = {
  id: 'monochrome',
  stage: 'film',
  fragmentSource: () => monochromeSource,
  variantKey: () => 'default',
  enabled: (input: RenderInput) => isMonochrome(input.edit.monochromeMix),

  bindUniforms(gl, locate, input) {
    const location = locate('uMonochromeMix')
    if (!location) return
    // Normalised here rather than in the shader: it is a division per frame
    // instead of per pixel, and it keeps the neutral-preserving property in the
    // one place that is unit tested.
    const [r, g, b] = normaliseMix(input.edit.monochromeMix)
    gl.uniform3f(location, r, g, b)
  },
}
