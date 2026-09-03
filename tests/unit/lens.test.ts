import { describe, expect, it } from 'vitest'

import {
  ABERRATION_RANGE,
  DIFFUSION_LENSLIKE_MAX_RADIUS,
  DISTORTION_RANGE,
  VIGNETTE_REACH,
  aberrationOverlap,
  aberrationScale,
  distortionOverlap,
  distortionScale,
  frameRadius,
  halfDiagonal,
  vignetteFalloff,
  vignetteMultiplier,
} from '../../src/core/colour/lens'

const LANDSCAPE = { width: 6000, height: 4000 }
const PORTRAIT = { width: 4000, height: 6000 }
const SQUARE = { width: 4000, height: 4000 }

describe('the frame radius', () => {
  it('is zero at the centre and one at every corner', () => {
    for (const frame of [LANDSCAPE, PORTRAIT, SQUARE]) {
      const label = `${frame.width}x${frame.height}`
      expect(frameRadius(frame.width / 2, frame.height / 2, frame.width, frame.height), label)
        .toBeCloseTo(0, 12)
      for (const [x, y] of [[0, 0], [frame.width, 0], [0, frame.height], [frame.width, frame.height]]) {
        expect(frameRadius(x ?? 0, y ?? 0, frame.width, frame.height), `${label} corner`)
          .toBeCloseTo(1, 12)
      }
    }
  })

  it('is circular, not elliptical, on a frame that is not square', () => {
    // The aspect correction. Without it the same physical distance from the
    // centre would give different radii along the two axes, so a vignette would
    // be an ellipse and a portrait frame would have a different lens from a
    // landscape one.
    //
    // Measured as: a point the same fraction of the way to the edge along x and
    // along y is NOT at the same radius — it is the same *physical* offset that
    // must be, and the half-height is a smaller physical distance than the
    // half-width on a landscape frame.
    const { width, height } = LANDSCAPE
    const offset = 1000
    const alongX = frameRadius(width / 2 + offset, height / 2, width, height)
    const alongY = frameRadius(width / 2, height / 2 + offset, width, height)
    expect(alongX).toBeCloseTo(alongY, 12)
  })

  it('grows monotonically outward', () => {
    let previous = -1
    for (let d = 0; d <= 3000; d += 25) {
      const r = frameRadius(3000 + d, 2000, LANDSCAPE.width, LANDSCAPE.height)
      expect(r).toBeGreaterThanOrEqual(previous)
      previous = r
    }
  })

  it('measures the corner at half the diagonal, in pixels', () => {
    expect(halfDiagonal(6000, 8000)).toBeCloseTo(5000, 9)
  })
})

describe('distortion', () => {
  it('is exactly the identity at zero, at every radius', () => {
    for (let r = 0; r <= 1; r += 0.01) expect(distortionScale(r, 0)).toBe(1)
  })

  it('reads from further out for positive values, which is pincushion', () => {
    // The sign convention, asserted because it is not self-evident from the
    // formula and is the first thing anyone will get backwards. An output pixel
    // at radius r reads from r * (1 + k r^2): with k > 0 it reads from further
    // out, so edge content is pulled inward and straight lines bow toward the
    // centre.
    expect(distortionScale(1, 0.1)).toBeGreaterThan(1)
    expect(distortionScale(1, -0.1)).toBeLessThan(1)
  })

  it('leaves the centre alone whatever the amount', () => {
    // A distortion that moved the centre would be a zoom with a curve on it.
    for (const k of [-DISTORTION_RANGE, -0.1, 0.1, DISTORTION_RANGE]) {
      expect(distortionScale(0, k)).toBe(1)
    }
  })

  it('displaces most at the corner, which is what the overlap is bounded by', () => {
    // Displacement is |k| r^3, so it is not merely largest at the corner but
    // grows fast enough that a bound taken anywhere else would be far too small.
    const k = 0.2
    const displacement = (r: number): number => Math.abs(distortionScale(r, k) - 1) * r
    expect(displacement(1)).toBeGreaterThan(displacement(0.5) * 4)
  })

  it('declares an overlap that covers the worst displacement', () => {
    const k = 0.2
    const overlap = distortionOverlap(k, LANDSCAPE.width, LANDSCAPE.height)
    const worst = Math.abs(k) * halfDiagonal(LANDSCAPE.width, LANDSCAPE.height)
    expect(overlap).toBeGreaterThanOrEqual(worst)
    // And it is not absurdly generous, which would make every export tile huge.
    expect(overlap).toBeLessThan(worst + 2)
  })

  it('declares no overlap when it is off', () => {
    expect(distortionOverlap(0, LANDSCAPE.width, LANDSCAPE.height)).toBe(1)
  })
})

describe('chromatic aberration', () => {
  it('is exactly the identity at zero, on every channel', () => {
    for (const channel of [0, 1, 2] as const) expect(aberrationScale(channel, 0)).toBe(1)
  })

  it('pulls red in and pushes blue out, and leaves green alone', () => {
    // Green is the reference because it carries most of the luminance, so a CA
    // setting does not shift the picture's apparent geometry.
    expect(aberrationScale(0, ABERRATION_RANGE)).toBeLessThan(1)
    expect(aberrationScale(1, ABERRATION_RANGE)).toBe(1)
    expect(aberrationScale(2, ABERRATION_RANGE)).toBeGreaterThan(1)
  })

  it('reverses cleanly, so the fringe can go either way', () => {
    expect(aberrationScale(0, -ABERRATION_RANGE)).toBeGreaterThan(1)
    expect(aberrationScale(2, -ABERRATION_RANGE)).toBeLessThan(1)
  })

  it('declares an overlap covering its worst displacement', () => {
    const amount = ABERRATION_RANGE
    const overlap = aberrationOverlap(amount, LANDSCAPE.width, LANDSCAPE.height)
    expect(overlap).toBeGreaterThanOrEqual(
      amount * halfDiagonal(LANDSCAPE.width, LANDSCAPE.height),
    )
  })

  it('has a range small enough to be a lens rather than a prism', () => {
    // 0.01 displaces the corner by 1% of the half-diagonal, which on a 6000px
    // frame is 36 pixels and already more than any lens worth using.
    const corner = ABERRATION_RANGE * halfDiagonal(6000, 4000)
    expect(corner).toBeGreaterThan(10)
    expect(corner).toBeLessThan(60)
  })
})

describe('the vignette', () => {
  it('is exactly one at the identity, at every radius', () => {
    // mix(1, f, 0) is 1*(1-0) + f*0, which is 1 bit for bit. Anything else
    // darkens every unedited photograph.
    for (let r = 0; r <= 1; r += 0.01) {
      expect(vignetteMultiplier(r, 0, VIGNETTE_REACH)).toBe(1)
    }
  })

  it('is one at the centre and falls monotonically toward the corner', () => {
    expect(vignetteFalloff(0, VIGNETTE_REACH)).toBe(1)
    let previous = 1
    for (let r = 0; r <= 1; r += 0.01) {
      const f = vignetteFalloff(r, VIGNETTE_REACH)
      expect(f).toBeLessThanOrEqual(previous + 1e-12)
      previous = f
    }
    expect(vignetteFalloff(1, VIGNETTE_REACH)).toBeLessThan(0.6)
  })

  it('has the cos^4 shape, not a linear or smoothstep gradient', () => {
    // The distinguishing property: near the centre a cos^4 falls off as the
    // SQUARE of the radius, so it is flat at r = 0 and accelerates. A radial
    // gradient multiply is linear there, which is what reads as an overlay.
    const near = 1 - vignetteFalloff(0.1, VIGNETTE_REACH)
    const twice = 1 - vignetteFalloff(0.2, VIGNETTE_REACH)
    expect(twice / near).toBeGreaterThan(3.5)
    expect(twice / near).toBeLessThan(4.5)
  })

  it('darkens more as the amount rises, and never brightens', () => {
    for (let r = 0; r <= 1; r += 0.05) {
      let previous = 1.0000001
      for (let amount = 0; amount <= 1; amount += 0.1) {
        const m = vignetteMultiplier(r, amount, VIGNETTE_REACH)
        expect(m).toBeLessThanOrEqual(previous)
        expect(m).toBeGreaterThan(0)
        previous = m
      }
    }
  })
})

describe('diffusion is kept distinct from halation', () => {
  it('reaches further, because glass scatters further than emulsion does', () => {
    // Halation is scattering within a few tens of microns of emulsion; diffusion
    // is scattering in glass in front of the lens. If the two ranges were the
    // same the controls would be two spellings of one slider.
    expect(DIFFUSION_LENSLIKE_MAX_RADIUS).toBeGreaterThan(0.015)
  })
})
