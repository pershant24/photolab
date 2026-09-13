/**
 * The date stamp pass.
 *
 * Registered first in the film stage, beside the light leak, and for the same
 * reason: both are light that reaches the emulsion without having come through
 * the lens, so both must precede everything the emulsion does. The physical
 * argument is in `src/core/colour/dateStamp.ts`; the position is asserted in
 * `tests/unit/pass-positions.test.ts`.
 *
 * # Order against the light leak
 *
 * Commutative, and not by arrangement. Both passes read their own texel of
 * `uSource` and write `colour + amount * tint` — no kernel, no dependence on a
 * neighbour — so composing them in either order gives the same sum. The
 * registration puts the leak first because a leak is a property of the body and
 * the stamp is a thing bolted into it, which is a reason to prefer an order
 * rather than a reason one is required.
 *
 * # Three notes on the new machinery, which turned out to be no machinery
 *
 * The brief for this pass expected a glyph asset, and the consequences were to
 * be recorded rather than discovered. They are recorded here, and each is
 * negative, which is the point:
 *
 * - **Program cache.** `variantKey` is `'default'` and stays there. The segment
 *   geometry is compile-time constant and everything that varies — the date, the
 *   position, the colour, the layout — is a uniform. Changing the date must
 *   never compile, and `tests/render/plumbing.spec.ts` covers the general rule
 *   that a parameter change does not recompile.
 * - **Asset loading.** There is none. Nothing is fetched, so there is no moment
 *   before it has loaded, no failure to report loudly, and no second load path
 *   in the export worker to disagree with the main thread's.
 * - **Texture units.** None claimed. The pass binds no texture but `uSource`,
 *   which the graph binds, so the wipe that `SCRATCH_UNIT` exists to prevent
 *   cannot arise here.
 *
 * Borders would still need all three. `CLAUDE.md` §3b says so.
 */

import dateStampSource from '../shaders/dateStamp.frag'
import { dateDigits, digitOrigins, stampWidth, TICK_ORIGIN } from '../../core/colour/dateStamp'
import type { Pass, RenderInput } from './types'

/**
 * Computed once. The layout depends on nothing that varies, which is exactly why
 * the shader is handed it rather than deriving it — there is one implementation
 * of the arithmetic and it is unit tested.
 */
const DIGIT_ORIGINS = new Float32Array(digitOrigins())
const STAMP_WIDTH = stampWidth()

const enabled = (input: RenderInput): boolean => input.edit.dateStampStrength > 0

export const dateStampPass: Pass = {
  id: 'dateStamp',
  stage: 'film',
  fragmentSource: () => dateStampSource,
  variantKey: () => 'default',
  enabled,
  // No overlap: no kernel. The tile dependency is on absolute frame position,
  // which uSourceRect.xy carries and a margin would not.
  bindUniforms(gl, locate, input) {
    const { dateStampYear, dateStampMonth, dateStampDay } = input.edit

    const digits = locate('uDateDigits[0]')
    if (digits) {
      gl.uniform1iv(digits, dateDigits(dateStampYear, dateStampMonth, dateStampDay))
    }

    const origins = locate('uDigitOrigins[0]')
    if (origins) gl.uniform1fv(origins, DIGIT_ORIGINS)

    const tick = locate('uTickOrigin')
    if (tick) gl.uniform1f(tick, TICK_ORIGIN)

    const width = locate('uStampWidth')
    if (width) gl.uniform1f(width, STAMP_WIDTH)

    const position = locate('uDateStampPosition')
    if (position) {
      gl.uniform2f(position, input.edit.dateStampPosition[0]!, input.edit.dateStampPosition[1]!)
    }

    const tint = locate('uDateStampTint')
    if (tint) {
      gl.uniform3f(
        tint,
        input.edit.dateStampTint[0]!,
        input.edit.dateStampTint[1]!,
        input.edit.dateStampTint[2]!,
      )
    }

    const strength = locate('uDateStampStrength')
    if (strength) gl.uniform1f(strength, input.edit.dateStampStrength)
  },
}
