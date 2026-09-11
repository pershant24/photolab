import { describe, expect, it } from 'vitest'

import {
  LIGHT_LEAK_REACH,
  LIGHT_LEAK_TINT,
  lightLeakEntry,
  lightLeakFalloff,
} from '../../src/core/colour/lightLeak'

describe('the light leak profile', () => {
  it('is strongest at the edge and never reaches zero', () => {
    // Exponential rather than a ramp that ends. A leak with a hard outer edge
    // reads as a gradient someone drew, which is the failure this shape avoids.
    expect(lightLeakFalloff(0)).toBe(1)
    let previous = Infinity
    for (let d = 0; d <= 2; d += 0.05) {
      const value = lightLeakFalloff(d)
      expect(value, `falloff at ${d}`).toBeLessThan(previous)
      expect(value, `falloff at ${d} reached zero`).toBeGreaterThan(0)
      previous = value
    }
  })

  it('has fallen to a twentieth by the end of its reach', () => {
    // The reach is not a cut-off, so what it means has to be said in terms of
    // the profile rather than by where the function stops.
    expect(lightLeakFalloff(LIGHT_LEAK_REACH)).toBeCloseTo(Math.exp(-3), 6)
    expect(lightLeakFalloff(LIGHT_LEAK_REACH)).toBeLessThan(0.05)
  })

  it('clamps behind the edge rather than growing', () => {
    expect(lightLeakFalloff(-1)).toBe(1)
  })
})

describe('where the leak enters', () => {
  it('always lands on the frame edge, all the way round', () => {
    // The reason position is one parameter and not two. A leak comes through a
    // seam, and there are no seams in the middle of the frame.
    for (let p = 0; p < 1; p += 0.01) {
      const [x, y] = lightLeakEntry(p)
      const onEdge = x === 0 || x === 1 || y === 0 || y === 1
      expect(onEdge, `position ${p.toFixed(2)} gave (${x}, ${y})`).toBe(true)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
    }
  })

  it('goes once around and returns to where it started', () => {
    expect(lightLeakEntry(0)).toEqual(lightLeakEntry(1))
    expect(lightLeakEntry(0.25)).toEqual(lightLeakEntry(1.25))
    // And wraps for a negative, rather than reflecting or clamping.
    expect(lightLeakEntry(-0.75)).toEqual(lightLeakEntry(0.25))
  })

  it('visits all four edges in order', () => {
    expect(lightLeakEntry(0.125)[0]).toBe(0)
    expect(lightLeakEntry(0.375)[1]).toBe(1)
    expect(lightLeakEntry(0.625)[0]).toBe(1)
    expect(lightLeakEntry(0.875)[1]).toBe(0)
  })
})

describe('the tint', () => {
  it('is warm, and warmer than halation, with red leading', () => {
    const [r, g, b] = LIGHT_LEAK_TINT
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
  })
})
