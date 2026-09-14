/**
 * The graduated filter pass, in the grade stage.
 *
 * # Where it sits inside the stage, and the interaction that decides it
 *
 * After `contrast`, before `wheels`. Both halves matter.
 *
 * **After contrast**, because contrast is a slope about middle grey and a grad
 * is a local exposure: run the grad first and a contrast of 1.6 would turn a one
 * stop grad into 1.6 stops, so the filter would strengthen every time someone
 * touched an unrelated control. That is the exact interaction `registry.ts`
 * records for having moved contrast next to the tone curve, one control further
 * out.
 *
 * **Before the colour trims**, because tonal shaping and then colour trimming is
 * the order the stage is already built in, and a grad is a tonal decision that
 * happens to carry a tint. The wheels, the HSL bands and the split tone then act
 * on the graded result including the grad, which is what a colourist expects.
 *
 * # No overlap, and that is not the same as position independence
 *
 * Every pixel is a function of its own position in the frame and nothing else,
 * so no tile needs a margin. It does need to know where the tile sits, which is
 * `uSourceRect.xy` and not a margin — the distinction `ARCHITECTURE.md` §11
 * exists to make, and the one the vignette, the light leak and the date stamp
 * have each needed in turn.
 */

import graduatedSource from '../shaders/graduated.frag'
import type { Pass, RenderInput } from './types'

/** Neutral: no exposure change and a tint that multiplies by one. */
function isNeutral(input: RenderInput): boolean {
  const tint = input.edit.graduatedTint
  return (
    input.edit.graduatedExposure === 0 && tint[0] === 1 && tint[1] === 1 && tint[2] === 1
  )
}

export const graduatedPass: Pass = {
  id: 'graduated',
  stage: 'grade',
  fragmentSource: () => graduatedSource,
  variantKey: () => 'default',
  // Skipped when the filter does nothing, which is the default. The angle, the
  // position and the width are shape rather than strength: a grad at any angle
  // with no exposure and no tint is still nothing, so they are deliberately not
  // consulted here.
  enabled: (input) => !isNeutral(input),

  bindUniforms(gl, locate, input) {
    const scalar = (name: string, value: number): void => {
      const location = locate(name)
      if (location) gl.uniform1f(location, value)
    }
    scalar('uGraduatedAngle', input.edit.graduatedAngle)
    scalar('uGraduatedPosition', input.edit.graduatedPosition)
    scalar('uGraduatedWidth', input.edit.graduatedWidth)
    scalar('uGraduatedExposure', input.edit.graduatedExposure)

    const tint = locate('uGraduatedTint')
    if (tint) {
      gl.uniform3f(
        tint,
        input.edit.graduatedTint[0]!,
        input.edit.graduatedTint[1]!,
        input.edit.graduatedTint[2]!,
      )
    }
  },
}
