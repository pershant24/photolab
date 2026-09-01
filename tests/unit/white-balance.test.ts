import { describe, expect, it } from 'vitest'

import {
  MAX_TEMPERATURE,
  MIN_TEMPERATURE,
  NEUTRAL_TEMPERATURE,
  NEUTRAL_TINT,
  isNeutralWhiteBalance,
  planckianXy,
  uvToXy,
  whiteBalanceMatrix,
  whitePointXy,
  xyToUv,
} from '../../src/core/colour/whiteBalance'
import { MAT3_IDENTITY, mat3MulVec3 } from '../../src/core/colour/types'
import type { Vec3 } from '../../src/core/colour/types'
import { linearSrgbToLab } from '../../src/core/colour/lab'
import { cat02AdaptationMatrix } from '../../src/core/colour/adaptation'
import { xyToXYZ } from '../../src/core/colour/primaries'
import { ACESCG_TO_SRGB } from '../../src/core/colour/matrices'

describe('the Planckian locus', () => {
  it('matches published chromaticities for standard illuminants', () => {
    // Independent values, not derived here: CIE illuminant A is a blackbody at
    // 2856K at (0.44757, 0.40745), and D65's correlated temperature is about
    // 6504K at (0.31271, 0.32902).
    //
    // The tolerance is 1e-3, which is looser than the 5e-5 the fit is often
    // quoted at — measured deviation at illuminant A is 5.3e-4, an order of
    // magnitude worse than the headline figure, because the fit degrades toward
    // the bottom of its range. That is recorded rather than papered over with a
    // tolerance that merely happens to pass: 5e-4 in xy is far below what a
    // slider dragged by eye can resolve, but it is not 5e-5 and a later reader
    // should not believe it is.
    const [ax, ay] = planckianXy(2856)
    expect(Math.abs(ax - 0.44757)).toBeLessThan(1e-3)
    expect(Math.abs(ay - 0.40745)).toBeLessThan(1e-3)

    // D65 is deliberately NOT compared here, and the reason matters. D65 is a
    // *daylight* illuminant, and the daylight locus sits above the Planckian
    // one: at 6504K they differ by 5.4e-3 in y, which is twenty times the fit's
    // error and nothing to do with the fit. Asserting against it would be
    // comparing a blackbody to something that is not one.
    //
    // The consequence for the control is recorded in whiteBalance.ts: this
    // temperature scale is Planckian, and the neutral setting is defined as
    // no-change rather than as a physical white point, so 6500 on this slider is
    // not exactly D65.
    const [px, py] = planckianXy(6500)
    expect(Math.abs(px - 0.3135)).toBeLessThan(1e-3)
    expect(Math.abs(py - 0.3237)).toBeLessThan(1e-3)
  })

  it('moves toward blue as temperature rises, monotonically', () => {
    // The direction the whole control depends on. A locus that doubled back
    // would make the slider reverse somewhere in the middle.
    let previousX = Infinity
    for (let t = MIN_TEMPERATURE; t <= MAX_TEMPERATURE; t += 50) {
      const [x] = planckianXy(t)
      expect(x).toBeLessThan(previousX)
      previousX = x
    }
  })

  it('clamps outside its fitted range instead of extrapolating', () => {
    expect(planckianXy(100)).toEqual(planckianXy(MIN_TEMPERATURE))
    expect(planckianXy(1e6)).toEqual(planckianXy(MAX_TEMPERATURE))
  })
})

describe('the uv round trip tint is displaced in', () => {
  it('returns to where it started', () => {
    for (const t of [2000, 3200, 5500, 6500, 9000]) {
      const [x, y] = planckianXy(t)
      const [u, v] = xyToUv(x, y)
      const [rx, ry] = uvToXy(u, v)
      expect(rx).toBeCloseTo(x, 12)
      expect(ry).toBeCloseTo(y, 12)
    }
  })

  it('moves the image green or magenta, which is the direction that matters', () => {
    // Asserted on the displayed image rather than on the white point, because
    // the two run opposite ways and asserting the wrong one is easy: a white
    // point that moves *toward* green describes greener light, which the
    // adaptation then removes, making the image more magenta.
    //
    // The convention here follows what editors present rather than what is
    // internally consistent with temperature: positive tint makes the image more
    // magenta, negative more green. Temperature describes the light and tint
    // describes the correction, which is inconsistent, and is what everyone
    // expects.
    const grey: Vec3 = [0.18, 0.18, 0.18]
    const aStar = (tint: number): number =>
      linearSrgbToLab(
        mat3MulVec3(ACESCG_TO_SRGB, mat3MulVec3(whiteBalanceMatrix(NEUTRAL_TEMPERATURE, tint), grey)),
      )[1]

    expect(aStar(0)).toBeCloseTo(0, 6)
    expect(aStar(60), 'positive tint is magenta, so a* rises').toBeGreaterThan(2)
    expect(aStar(-60), 'negative tint is green, so a* falls').toBeLessThan(-2)
  })
})

describe('the white balance matrix', () => {
  it('is exactly the identity at the neutral setting', () => {
    // Exactly, not nearly. Composing the adaptation with its own inverse would
    // land within 1e-16, which is invisible — and invisible is precisely how an
    // unedited photograph gets altered by something nobody asked for. The
    // neutral case returns the identity rather than computing it, and the pass
    // is skipped entirely on top of that.
    expect(whiteBalanceMatrix(NEUTRAL_TEMPERATURE, NEUTRAL_TINT)).toBe(MAT3_IDENTITY)
    expect(isNeutralWhiteBalance(NEUTRAL_TEMPERATURE, NEUTRAL_TINT)).toBe(true)
    expect(isNeutralWhiteBalance(NEUTRAL_TEMPERATURE, 1)).toBe(false)
    expect(isNeutralWhiteBalance(5000, NEUTRAL_TINT)).toBe(false)
  })

  it('maps the named white point onto the neutral one, which is what balancing means', () => {
    // The defining property: whatever was white under the light the user named
    // comes out white. Checked in XYZ, where a white point is a white point,
    // before the working space's primaries are involved.
    for (const [t, tint] of [[2500, 0], [9000, 0], [6500, 60], [3200, -40]] as const) {
      const source = whitePointXy(t, tint)
      const sourceXYZ = xyToXYZ(source[0], source[1])
      const neutral = whitePointXy(NEUTRAL_TEMPERATURE, NEUTRAL_TINT)
      const neutralXYZ = xyToXYZ(neutral[0], neutral[1])

      const adapted = mat3MulVec3(
        cat02AdaptationMatrix(sourceXYZ, neutralXYZ),
        sourceXYZ,
      )
      for (let c = 0; c < 3; c++) {
        expect(adapted[c], `${t}K tint ${tint} channel ${c}`).toBeCloseTo(
          neutralXYZ[c] ?? Number.NaN,
          12,
        )
      }
    }
  })

  it('warms and cools in the direction a photographer expects', () => {
    // Naming a low temperature says "this was lit by tungsten", so the
    // application removes that cast and the image becomes cooler. Measured as a
    // CIELAB hue shift of a grey, which is where a cast is visible.
    const grey: Vec3 = [0.18, 0.18, 0.18]
    const displayed = (t: number): Vec3 =>
      mat3MulVec3(ACESCG_TO_SRGB, mat3MulVec3(whiteBalanceMatrix(t, 0), grey))

    const tungsten = displayed(3200)
    const daylight = displayed(9000)

    // Removing a warm cast leaves more blue than red; removing a cool one, the
    // reverse.
    expect(tungsten[2] / tungsten[0]).toBeGreaterThan(1)
    expect(daylight[2] / daylight[0]).toBeLessThan(1)
  })

  it('shifts hue further the further the setting is from neutral', () => {
    const grey: Vec3 = [0.18, 0.18, 0.18]
    const chroma = (t: number): number => {
      const lab = linearSrgbToLab(mat3MulVec3(ACESCG_TO_SRGB, mat3MulVec3(whiteBalanceMatrix(t, 0), grey)))
      return Math.hypot(lab[1], lab[2])
    }
    expect(chroma(6500)).toBeCloseTo(0, 6)
    expect(chroma(5000)).toBeGreaterThan(chroma(6000))
    expect(chroma(3000)).toBeGreaterThan(chroma(5000))
  })
})
