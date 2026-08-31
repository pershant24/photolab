import { describe, expect, it } from 'vitest'

import { PROXY_LONG_EDGE, proxySize } from '../../src/render/decodeProtocol'

describe('proxy sizing', () => {
  it('leaves an image already within the budget untouched', () => {
    // Upscaling a small source would invent detail and cost memory for nothing.
    expect(proxySize(800, 600)).toEqual({ width: 800, height: 600 })
    expect(proxySize(PROXY_LONG_EDGE, 100)).toEqual({ width: PROXY_LONG_EDGE, height: 100 })
  })

  it('scales the long edge to the budget, whichever axis it is', () => {
    expect(proxySize(4000, 3000)).toEqual({ width: 2048, height: 1536 })
    expect(proxySize(3000, 4000)).toEqual({ width: 1536, height: 2048 })
  })

  it('brings a 60MP source under any plausible MAX_TEXTURE_SIZE', () => {
    // 9504x6336 is the largest input this project accepts, and its long edge is
    // above the 8192 limit SwiftShader reports and many mobile GPUs impose.
    const proxy = proxySize(9504, 6336)
    expect(Math.max(proxy.width, proxy.height)).toBe(PROXY_LONG_EDGE)
    expect(proxy.width).toBeLessThan(8192)
  })

  it('preserves aspect ratio to within a pixel of rounding', () => {
    for (const [w, h] of [[4000, 3000], [9504, 6336], [5000, 2000], [2049, 2048]] as const) {
      const proxy = proxySize(w, h)
      expect(proxy.width / proxy.height).toBeCloseTo(w / h, 2)
    }
  })

  it('never rounds an extreme aspect ratio down to zero', () => {
    // A panorama's short edge would otherwise round to 0, and createImageBitmap
    // rejects a zero dimension — a crash on a legitimate file.
    const proxy = proxySize(30000, 900)
    expect(proxy.height).toBeGreaterThanOrEqual(1)
    expect(proxy.width).toBe(PROXY_LONG_EDGE)
  })
})
