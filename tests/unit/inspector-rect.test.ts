import { describe, expect, it } from 'vitest'

import { inspectorRect } from '../../src/render/renderer'

/**
 * The region the 1:1 inspector shows.
 *
 * Small enough to test exhaustively and worth doing so: it is the only new
 * arithmetic the inspector introduces, and everything downstream of it is the
 * ordinary pass chain over a `uSourceRect` like any other.
 */
describe('the inspector region', () => {
  const SOURCE = { w: 4000, h: 3000 }

  it('is buffer-sized, so one buffer pixel covers one source pixel', () => {
    const [, , w, h] = inspectorRect([0.5, 0.5], 800, 600, SOURCE.w, SOURCE.h)
    expect([w, h]).toEqual([800, 600])
  })

  it('centres on the requested point', () => {
    const [x, y] = inspectorRect([0.5, 0.5], 800, 600, SOURCE.w, SOURCE.h)
    expect(x).toBe(2000 - 400)
    expect(y).toBe(1500 - 300)
  })

  it('clamps the rect rather than the centre, so a corner shows pixels', () => {
    // Clamping the centre would leave the rect hanging off the edge and the view
    // would show a band of nothing. Clamping the rect stops it at the boundary
    // with the region still full.
    for (const centre of [[0, 0], [1, 1], [-5, 5], [0.5, 0]] as const) {
      const [x, y, w, h] = inspectorRect(centre, 800, 600, SOURCE.w, SOURCE.h)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(SOURCE.w)
      expect(y + h).toBeLessThanOrEqual(SOURCE.h)
      expect([w, h]).toEqual([800, 600])
    }
  })

  it('collapses to the whole image when the buffer is larger than the source', () => {
    // A small photograph on a big display. The region cannot be bigger than what
    // exists, and going negative here would produce a rect the shaders divide by.
    const [x, y, w, h] = inspectorRect([0.5, 0.5], 4000, 4000, 640, 480)
    expect([x, y, w, h]).toEqual([0, 0, 640, 480])
  })

  it('never produces a rect outside the image, for any centre at any size', () => {
    for (let i = 0; i < 500; i++) {
      const cx = (Math.random() - 0.5) * 3
      const cy = (Math.random() - 0.5) * 3
      const bw = 1 + Math.floor(Math.random() * 5000)
      const bh = 1 + Math.floor(Math.random() * 5000)
      const [x, y, w, h] = inspectorRect([cx, cy], bw, bh, SOURCE.w, SOURCE.h)
      expect(w).toBeGreaterThan(0)
      expect(h).toBeGreaterThan(0)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(SOURCE.w)
      expect(y + h).toBeLessThanOrEqual(SOURCE.h)
    }
  })
})
