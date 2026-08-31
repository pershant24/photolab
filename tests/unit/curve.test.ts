import { describe, expect, it } from 'vitest'

import {
  curveTangents,
  evaluateCurve,
  evaluateCurveWithTangents,
  sampleCurveLut,
} from '../../src/core/colour/curve'

const DENSE_SAMPLES = 1000

function sampleDense(xs: readonly number[], ys: readonly number[]): number[] {
  const tangents = curveTangents(xs, ys)
  const first = xs[0] ?? Number.NaN
  const last = xs[xs.length - 1] ?? Number.NaN
  const out: number[] = []
  for (let i = 0; i <= DENSE_SAMPLES; i++) {
    out.push(evaluateCurveWithTangents(xs, ys, tangents, first + ((last - first) * i) / DENSE_SAMPLES))
  }
  return out
}

describe('monotone curve interpolation', () => {
  it('passes exactly through every control point', () => {
    const xs = [0, 0.25, 0.5, 0.75, 1]
    const ys = [0, 0.1, 0.45, 0.9, 1]
    for (let i = 0; i < xs.length; i++) {
      expect(evaluateCurve(xs, ys, xs[i] ?? Number.NaN)).toBeCloseTo(ys[i] ?? Number.NaN, 12)
    }
  })

  it('produces monotonically increasing output from monotonically increasing control points', () => {
    // A deliberately awkward shape: a long flat run followed by a steep rise is
    // the case that makes a natural cubic spline dip below the flat section.
    const xs = [0, 0.2, 0.4, 0.6, 0.8, 1]
    const ys = [0, 0.02, 0.03, 0.4, 0.95, 1]
    const samples = sampleDense(xs, ys)

    let previous = -Infinity
    for (const v of samples) {
      expect(v).toBeGreaterThanOrEqual(previous)
      previous = v
    }
  })

  it('keeps every sample inside the control point range', () => {
    const xs = [0, 0.2, 0.4, 0.6, 0.8, 1]
    const ys = [0, 0.02, 0.03, 0.4, 0.95, 1]
    const lowest = Math.min(...ys)
    const highest = Math.max(...ys)
    for (const v of sampleDense(xs, ys)) {
      expect(v).toBeGreaterThanOrEqual(lowest)
      expect(v).toBeLessThanOrEqual(highest)
    }
  })

  it('does not overshoot between non-monotone control points', () => {
    // This is the assertion that separates PCHIP from Catmull-Rom and from a
    // natural cubic spline. Both of those swing past a local extremum, which on
    // a tone curve is a region that gets darker as the curve above it is
    // raised. Here the interpolant must stay between the two control points
    // bracketing each interval, everywhere.
    const xs = [0, 0.2, 0.4, 0.6, 0.8, 1]
    const ys = [0.1, 0.9, 0.15, 0.85, 0.2, 0.8]
    const tangents = curveTangents(xs, ys)

    for (let interval = 0; interval < xs.length - 1; interval++) {
      const x0 = xs[interval] ?? Number.NaN
      const x1 = xs[interval + 1] ?? Number.NaN
      const y0 = ys[interval] ?? Number.NaN
      const y1 = ys[interval + 1] ?? Number.NaN
      const lower = Math.min(y0, y1)
      const upper = Math.max(y0, y1)

      for (let i = 0; i <= 200; i++) {
        const v = evaluateCurveWithTangents(xs, ys, tangents, x0 + ((x1 - x0) * i) / 200)
        expect(v).toBeGreaterThanOrEqual(lower - 1e-12)
        expect(v).toBeLessThanOrEqual(upper + 1e-12)
      }
    }
  })

  it('reproduces a straight line from collinear control points', () => {
    const xs = [0, 0.3, 0.55, 1]
    const ys = xs.map((x) => 0.25 + 0.5 * x)
    for (let i = 0; i <= 100; i++) {
      const x = i / 100
      expect(evaluateCurve(xs, ys, x)).toBeCloseTo(0.25 + 0.5 * x, 12)
    }
  })

  it('clamps rather than extrapolating outside the control point range', () => {
    const xs = [0.1, 0.5, 0.9]
    const ys = [0.2, 0.6, 0.7]
    expect(evaluateCurve(xs, ys, -5)).toBe(0.2)
    expect(evaluateCurve(xs, ys, 0.05)).toBe(0.2)
    expect(evaluateCurve(xs, ys, 1000)).toBe(0.7)
  })

  it('handles two control points as a straight line', () => {
    const xs = [0, 1]
    const ys = [0.25, 0.75]
    expect(evaluateCurve(xs, ys, 0.5)).toBeCloseTo(0.5, 12)
  })

  it('bakes a lookup table matching direct evaluation', () => {
    // The shader path samples the LUT rather than evaluating the spline, so a
    // disagreement here would make the shader and this reference implementation
    // differ for reasons that have nothing to do with the shader.
    const xs = [0, 0.25, 0.5, 0.75, 1]
    const ys = [0, 0.05, 0.4, 0.9, 1]
    const lut = sampleCurveLut(xs, ys, 256)

    expect(lut.length).toBe(256)
    for (let i = 0; i < 256; i++) {
      const x = i / 255
      expect(lut[i] ?? Number.NaN).toBeCloseTo(evaluateCurve(xs, ys, x), 6)
    }
  })

  it('rejects control points that are not strictly increasing in x', () => {
    expect(() => curveTangents([0, 0.5, 0.5, 1], [0, 0.2, 0.6, 1])).toThrow(RangeError)
    expect(() => curveTangents([0, 0.5, 0.4, 1], [0, 0.2, 0.6, 1])).toThrow(RangeError)
  })

  it('rejects mismatched or degenerate control point sets', () => {
    expect(() => curveTangents([0, 1], [0])).toThrow(RangeError)
    expect(() => curveTangents([0], [0])).toThrow(RangeError)
  })
})
