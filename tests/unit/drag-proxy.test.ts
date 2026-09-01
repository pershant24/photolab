import { describe, expect, it } from 'vitest'

import {
  DRAG_PROXY_FRAME_BUDGET_MS,
  DRAG_PROXY_WINDOW,
  shouldEngageDragProxy,
} from '../../src/render/renderer'

/**
 * The drag proxy's engagement rule, on given numbers.
 *
 * The browser test drives the real frame loop, which is how it found that
 * `Viewport` re-opens the gesture on every store change. It is not sufficient
 * cover on its own: it needs the machine to actually miss frames, and CI's did
 * not, so the rule itself is tested here where the intervals are inputs.
 */
describe('the drag proxy engagement rule', () => {
  it('waits for a full window before deciding anything', () => {
    // Two slow frames at the start of a gesture are a shader compile and a first
    // draw at a new size, not a slow gesture.
    for (let n = 0; n < DRAG_PROXY_WINDOW; n++) {
      expect(shouldEngageDragProxy(Array<number>(n).fill(300))).toBe(false)
    }
    expect(shouldEngageDragProxy(Array<number>(DRAG_PROXY_WINDOW).fill(300))).toBe(true)
  })

  it('engages when the median frame is missing a refresh', () => {
    expect(shouldEngageDragProxy([250, 260, 240, 255, 245])).toBe(true)
  })

  it('leaves a healthy drag alone', () => {
    // Measured intervals from a trivial frame in a real browser: a 60Hz display
    // with normal jitter. An earlier rule of three consecutive over 20ms engaged
    // on exactly this.
    expect(shouldEngageDragProxy([23, 19, 19, 14, 16])).toBe(false)
    expect(shouldEngageDragProxy([12, 14, 15, 16, 13])).toBe(false)
    expect(shouldEngageDragProxy([24, 20, 13, 14, 16])).toBe(false)
  })

  it('is not started by a single spike', () => {
    // A garbage collection, a compositor hiccup, a background tab waking up.
    expect(shouldEngageDragProxy([14, 16, 400, 15, 13])).toBe(false)
    expect(shouldEngageDragProxy([14, 400, 15, 380, 13])).toBe(false)
  })

  it('is not defeated by alternating fast and slow frames', () => {
    // The pattern a count of CONSECUTIVE slow frames misses entirely, and the
    // reason the statistic is a median. Three of five over budget engages.
    expect(shouldEngageDragProxy([200, 14, 210, 15, 220])).toBe(true)
    // Two of five does not: the gesture is mostly keeping up.
    expect(shouldEngageDragProxy([200, 14, 210, 15, 12])).toBe(false)
  })

  it('sits clear of the jitter on one side and of trouble on the other', () => {
    // 33ms is one missed frame at 60Hz. Healthy frames measured 12-24ms and a
    // struggling gesture 240-300ms, so the threshold is inside a wide gap rather
    // than near either population.
    expect(DRAG_PROXY_FRAME_BUDGET_MS).toBeGreaterThan(24)
    expect(DRAG_PROXY_FRAME_BUDGET_MS).toBeLessThan(240)
  })
})
