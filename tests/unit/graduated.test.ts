import { describe, expect, it } from 'vitest'

import {
  GRADUATED_MIN_WIDTH,
  applyGraduated,
  graduatedAspect,
  graduatedCoordinate,
  graduatedDirection,
  graduatedHalfExtent,
  graduatedMask,
} from '../../src/core/colour/graduated'
import { DEFAULT_EDIT_STATE } from '../../src/core/state/editState'

/**
 * The graduated filter's geometry.
 *
 * The shader evaluates the same maths per pixel rather than receiving it as
 * uniforms — it is a function of position, so it has to — which makes this one
 * of the cases step 5 of the add-a-pass recipe is written for: the maths is in
 * TypeScript, tested here against known values, and
 * `tests/golden/graduated.spec.ts` then asserts the shader agrees with it across
 * a ramp rather than the two being assumed to match.
 */

const LANDSCAPE = graduatedAspect([3000, 2000])
const PORTRAIT = graduatedAspect([2000, 3000])
const SQUARE = graduatedAspect([2000, 2000])

describe('the gradient direction', () => {
  it('points at the top of the frame at zero degrees, and turns clockwise', () => {
    // Frame y runs downward, so "up" is negative y. Zero darkening the sky is
    // the default a graduated filter is bought for.
    const near = (v: readonly [number, number], x: number, y: number): void => {
      expect(v[0]).toBeCloseTo(x, 12)
      expect(v[1]).toBeCloseTo(y, 12)
    }
    near(graduatedDirection(0), 0, -1)
    near(graduatedDirection(90), 1, 0)
    near(graduatedDirection(180), 0, 1)
    near(graduatedDirection(270), -1, 0)
  })

  it('is a unit vector at every angle', () => {
    for (let a = 0; a < 360; a += 7) {
      const [x, y] = graduatedDirection(a)
      expect(Math.hypot(x, y), `angle ${a}`).toBeCloseTo(1, 12)
    }
  })
})

describe('the frame extent along the gradient', () => {
  it('is half the frame in the axis directions', () => {
    expect(graduatedHalfExtent(SQUARE, [0, -1])).toBeCloseTo(0.5, 12)
    expect(graduatedHalfExtent(LANDSCAPE, [1, 0])).toBeCloseTo(0.5, 12)
    // The short axis of a 3:2 frame is 2/3 of the long one.
    expect(graduatedHalfExtent(LANDSCAPE, [0, -1])).toBeCloseTo(1 / 3, 12)
  })

  it('is the support function, not the diagonal', () => {
    // THE ASSERTION THIS GEOMETRY EXISTS FOR, stated as the property rather than
    // as a formula. `position` has to mean the same fraction of the frame at
    // every angle, which requires the coordinate to reach exactly 0 at one
    // corner and exactly 1 at another — for every angle, on every frame shape.
    //
    // The diagonal passes this at 56 degrees on a 3:2 frame and fails
    // everywhere else, which is why it is asserted across a sweep rather than
    // at one angle.
    for (const aspect of [LANDSCAPE, PORTRAIT, SQUARE]) {
      for (let angle = 0; angle < 360; angle += 3) {
        const corners: number[] = []
        for (const x of [0, 1]) {
          for (const y of [0, 1]) corners.push(graduatedCoordinate([x, y], aspect, angle))
        }
        expect(Math.min(...corners), `angle ${angle} on ${aspect.join(':')}`).toBeCloseTo(0, 12)
        expect(Math.max(...corners), `angle ${angle} on ${aspect.join(':')}`).toBeCloseTo(1, 12)
      }
    }
  })
})

describe('the gradient coordinate', () => {
  it('is a half at the centre of the frame, whatever the angle', () => {
    for (const aspect of [LANDSCAPE, PORTRAIT, SQUARE]) {
      for (let angle = 0; angle < 360; angle += 11) {
        expect(graduatedCoordinate([0.5, 0.5], aspect, angle), `angle ${angle}`).toBeCloseTo(0.5, 12)
      }
    }
  })

  it('runs one at the top of the frame and zero at the bottom, unrotated', () => {
    expect(graduatedCoordinate([0.5, 0], LANDSCAPE, 0)).toBeCloseTo(1, 12)
    expect(graduatedCoordinate([0.5, 1], LANDSCAPE, 0)).toBeCloseTo(0, 12)
  })

  it('increases monotonically along the gradient', () => {
    for (const angle of [0, 37, 90, 143, 250]) {
      const [dx, dy] = graduatedDirection(angle)
      let previous = -Infinity
      for (let t = -0.4; t <= 0.4; t += 0.02) {
        const u = graduatedCoordinate([0.5 + dx * t, 0.5 + dy * t], LANDSCAPE, angle)
        expect(u, `angle ${angle} at ${t.toFixed(2)}`).toBeGreaterThan(previous)
        previous = u
      }
    }
  })
})

describe('the mask', () => {
  it('is exactly zero and exactly one outside the transition band', () => {
    // Exactly, not nearly. It is what lets the pass be a bit-exact identity over
    // most of the frame at any setting, the way the vignette is at amount zero.
    expect(graduatedMask([0.5, 1], LANDSCAPE, 0, 0.5, 0.3)).toBe(0)
    expect(graduatedMask([0.5, 0], LANDSCAPE, 0, 0.5, 0.3)).toBe(1)
  })

  it('is a half exactly at the position, which is what makes the parameter mean something', () => {
    for (const position of [0.2, 0.5, 0.8]) {
      // The frame point whose coordinate equals `position`, unrotated: the
      // coordinate runs 1 at the top to 0 at the bottom, so y = 1 - position.
      const mask = graduatedMask([0.5, 1 - position], LANDSCAPE, 0, position, 0.4)
      expect(mask, `position ${position}`).toBeCloseTo(0.5, 10)
    }
  })

  it('never divides by zero, however narrow the width is asked to be', () => {
    // smoothstep with equal edges is undefined in GLSL rather than hard, so the
    // width has a floor. Zero and a negative both have to land on it.
    for (const width of [0, -1, 1e-12, GRADUATED_MIN_WIDTH / 2]) {
      for (const y of [0, 0.25, 0.5, 0.75, 1]) {
        const mask = graduatedMask([0.5, y], LANDSCAPE, 0, 0.5, width)
        expect(Number.isFinite(mask), `width ${width} at y ${y}`).toBe(true)
        expect(mask).toBeGreaterThanOrEqual(0)
        expect(mask).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is narrower at a smaller width, which is the parameter doing its job', () => {
    // Non-vacuity for the width: the band has to actually change size, or every
    // assertion above holds for a parameter that is ignored.
    const bandSize = (width: number): number => {
      let count = 0
      for (let y = 0; y <= 1; y += 0.001) {
        const m = graduatedMask([0.5, y], LANDSCAPE, 0, 0.5, width)
        if (m > 0 && m < 1) count++
      }
      return count
    }
    expect(bandSize(0.8)).toBeGreaterThan(bandSize(0.4))
    expect(bandSize(0.4)).toBeGreaterThan(bandSize(0.05))
  })
})

describe('what the filter does to a colour', () => {
  it('leaves an unmasked pixel bit for bit', () => {
    const rgb: [number, number, number] = [0.21, 0.37, 0.58]
    expect(applyGraduated(rgb, 0, -3, [0.4, 0.7, 1.6])).toEqual(rgb)
  })

  it('is exactly the stops it claims, at full mask', () => {
    const [r] = applyGraduated([0.18, 0.18, 0.18], 1, -1, [1, 1, 1])
    expect(r).toBeCloseTo(0.09, 12)
    const [r2] = applyGraduated([0.18, 0.18, 0.18], 1, 2, [1, 1, 1])
    expect(r2).toBeCloseTo(0.72, 12)
  })

  it('absorbs rather than adds, at a tint below one', () => {
    const [r, g, b] = applyGraduated([0.5, 0.5, 0.5], 1, 0, [1, 0.8, 0.6])
    expect(r).toBeCloseTo(0.5, 12)
    expect(g).toBeCloseTo(0.4, 12)
    expect(b).toBeCloseTo(0.3, 12)
  })
})

describe('the defaults', () => {
  it('ship the filter switched off, with a shape that is ready to use', () => {
    expect(DEFAULT_EDIT_STATE.graduatedExposure).toBe(0)
    expect(DEFAULT_EDIT_STATE.graduatedTint).toEqual([1, 1, 1])
    // Unrotated, centred, and soft: turn the exposure down and it darkens the
    // sky, which is what the control is for.
    expect(DEFAULT_EDIT_STATE.graduatedAngle).toBe(0)
    expect(DEFAULT_EDIT_STATE.graduatedPosition).toBe(0.5)
    expect(DEFAULT_EDIT_STATE.graduatedWidth).toBeGreaterThan(GRADUATED_MIN_WIDTH)
  })
})
