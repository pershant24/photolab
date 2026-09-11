/**
 * The light leak pass: stray light fogging the emulsion.
 *
 * # Why it is in the film stage and not the lens stage
 *
 * Because it did not come through the lens. A leak enters through a seam in the
 * body, so nothing about it is shaped by the glass — it is not distorted, not
 * split by wavelength, and not affected by the aperture's falloff. Putting it in
 * the lens stage would be putting it somewhere it demonstrably does not belong.
 *
 * It runs **first inside the film stage**, before halation and before the
 * characteristic curves, and both of those matter:
 *
 * - the curves develop it as exposure, so it compresses where the frame is
 *   already bright and lifts where it is dark, which is what makes a fogged
 *   frame look fogged rather than tinted;
 * - halation blooms it, because stray light reflects off the film base like any
 *   other light.
 *
 * Neither is arranged here. Both fall out of the registration order, which is
 * asserted in `tests/unit/pass-positions.test.ts`.
 *
 * # It is a camera parameter in a film-stage pass
 *
 * Deliberately, and it is the clearest example in the pipeline of why the preset
 * axes are defined by parameter and not by stage. A leak is a fact about the
 * camera body; it acts in the film stage. `src/core/state/axes.ts` says so.
 */

import lightLeakSource from '../shaders/lightLeak.frag'
import type { Pass, RenderInput } from './types'

const enabled = (input: RenderInput): boolean => input.edit.lightLeakStrength > 0

export const lightLeakPass: Pass = {
  id: 'lightLeak',
  stage: 'film',
  fragmentSource: () => lightLeakSource,
  variantKey: () => 'default',
  enabled,
  // No overlap. There is no kernel: every pixel is a function of its own
  // position in the frame and nothing else. The tile dependency it does have is
  // on absolute position, which margins cannot fix and `uSourceRect.xy` does.
  bindUniforms(gl, locate, input) {
    const strength = locate('uLightLeakStrength')
    if (strength) gl.uniform1f(strength, input.edit.lightLeakStrength)
    const position = locate('uLightLeakPosition')
    if (position) gl.uniform1f(position, input.edit.lightLeakPosition)
  },
}
