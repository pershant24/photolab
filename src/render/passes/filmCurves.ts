/**
 * Per-channel characteristic curves, in the film stage.
 *
 * Three lookup tables rather than one, sharing the machinery the tone curve
 * established. Each is baked at its own derived resolution, which matters here
 * more than it did there: a characteristic curve's toe is sharper than anything
 * a person places by hand on a tone curve, and it is the part carrying the
 * stock's character.
 */

import fragmentSource from '../shaders/filmCurves.frag'

import { LUT_TOLERANCE, curveLutResolution, sampleCurveLut } from '../../core/colour/curve'
import { FILM_DOMAIN } from '../../core/colour/filmStock'
import { isFilmStageIdentity, splitControlPoints } from '../../core/state/editState'
import type { CurveLut } from '../gl/lut'
import { createCurveLut } from '../gl/lut'
import { CURVE_LUT_UNITS } from '../gl/textureUnits'
import type { Pass, RenderInput } from './types'

const CHANNELS = ['filmCurveRed', 'filmCurveGreen', 'filmCurveBlue'] as const
const SAMPLERS = ['uFilmLutR', 'uFilmLutG', 'uFilmLutB'] as const

export interface FilmCurvesPass extends Pass {
  readonly bakeCount: number
}

export function createFilmCurvesPass(): FilmCurvesPass {
  const luts: (CurveLut | null)[] = [null, null, null]
  const bakedFrom: (string | null)[] = [null, null, null]
  let bakes = 0

  /** Rebake one channel, and only when its own control points changed. */
  const ensure = (
    gl: WebGL2RenderingContext,
    index: number,
    points: readonly number[],
  ): CurveLut => {
    const signature = points.join(',')
    const existing = luts[index]
    if (existing && bakedFrom[index] === signature) return existing

    const { xs, ys } = splitControlPoints(points)
    const size = curveLutResolution(xs, ys, LUT_TOLERANCE)
    const samples = sampleCurveLut(xs, ys, size)

    existing?.dispose()
    const built = createCurveLut(gl, samples, [xs[0] ?? FILM_DOMAIN[0], xs[xs.length - 1] ?? 1])
    luts[index] = built
    bakedFrom[index] = signature
    bakes += 1
    return built
  }

  return {
    id: 'filmCurves',
    stage: 'film',

    fragmentSource: () => fragmentSource,
    variantKey: () => 'default',

    // Skipped when all three curves are the identity, or strength is zero.
    enabled: (input: RenderInput) => !isFilmStageIdentity(input.edit),

    bindUniforms(gl, locate, input) {
      const sizes: number[] = []

      for (let i = 0; i < CHANNELS.length; i++) {
        const key = CHANNELS[i]
        if (!key) continue
        // Baking happens on the reserved scratch unit inside createCurveLut, so
        // three tables in a row cannot disturb the source binding — which is
        // exactly the failure a single table produced before that was reserved.
        const baked = ensure(gl, i, input.edit[key])
        sizes.push(baked.size)

        const sampler = locate(SAMPLERS[i] ?? '')
        const unit = CURVE_LUT_UNITS[i] ?? 2
        if (sampler) {
          gl.activeTexture(gl.TEXTURE0 + unit)
          gl.bindTexture(gl.TEXTURE_2D, baked.texture)
          gl.uniform1i(sampler, unit)
        }
      }
      gl.activeTexture(gl.TEXTURE0)

      const domain = locate('uFilmDomain')
      // All three share a domain by construction: they are one stock's response
      // to one exposure axis, and separate domains would make the crossover
      // between them meaningless.
      if (domain) gl.uniform2f(domain, FILM_DOMAIN[0], FILM_DOMAIN[1])

      const sizeUniform = locate('uFilmLutSizes')
      if (sizeUniform) gl.uniform3f(sizeUniform, sizes[0] ?? 2, sizes[1] ?? 2, sizes[2] ?? 2)

      const strength = locate('uFilmStrength')
      if (strength) gl.uniform1f(strength, input.edit.filmStrength)
    },

    dispose() {
      for (let i = 0; i < luts.length; i++) {
        luts[i]?.dispose()
        luts[i] = null
        bakedFrom[i] = null
      }
    },

    get bakeCount() {
      return bakes
    },
  }
}
