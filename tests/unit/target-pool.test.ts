import { describe, expect, it } from 'vitest'

import { TargetAllocationError, TargetPool, createRenderTarget } from '../../src/render/gl/target'
import type { TargetGL } from '../../src/render/gl/target'

/** Counting stand-in for the framebuffer and texture calls the pool makes. */
function stubGL(options: { incomplete?: boolean } = {}): TargetGL & {
  textures: number
  framebuffers: number
  deletedTextures: number
  deletedFramebuffers: number
  storageCalls: { width: number; height: number }[]
} {
  const counters = {
    textures: 0,
    framebuffers: 0,
    deletedTextures: 0,
    deletedFramebuffers: 0,
    storageCalls: [] as { width: number; height: number }[],
  }

  const gl = {
    TEXTURE_2D: 0x0de1,
    RGBA16F: 0x881a,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,

    createTexture: () => {
      counters.textures += 1
      return {} as WebGLTexture
    },
    bindTexture: () => undefined,
    texStorage2D: (_t: number, _l: number, _f: number, width: number, height: number) => {
      counters.storageCalls.push({ width, height })
    },
    texParameteri: () => undefined,
    deleteTexture: () => {
      counters.deletedTextures += 1
    },
    createFramebuffer: () => {
      counters.framebuffers += 1
      return {} as WebGLFramebuffer
    },
    bindFramebuffer: () => undefined,
    framebufferTexture2D: () => undefined,
    checkFramebufferStatus: () => (options.incomplete ? 0x8cd6 : 0x8cd5),
    deleteFramebuffer: () => {
      counters.deletedFramebuffers += 1
    },
    ...counters,
  }

  return new Proxy(gl, {
    get: (target, prop) =>
      prop in counters ? counters[prop as keyof typeof counters] : target[prop as keyof typeof gl],
  }) as unknown as TargetGL & typeof counters
}

describe('render target allocation', () => {
  it('allocates immutable RGBA16F storage at the requested size', () => {
    const gl = stubGL()
    createRenderTarget(gl, 640, 480)
    expect(gl.storageCalls).toEqual([{ width: 640, height: 480 }])
  })

  it('cleans up both objects when the framebuffer comes back incomplete', () => {
    // Leaking a texture and a framebuffer per failed attempt is how a resize
    // loop on an unsupported format exhausts VRAM rather than reporting.
    const gl = stubGL({ incomplete: true })
    expect(() => createRenderTarget(gl, 64, 64)).toThrow(TargetAllocationError)
    expect(gl.deletedTextures).toBe(1)
    expect(gl.deletedFramebuffers).toBe(1)
  })

  it('rejects a non-integer or non-positive size', () => {
    const gl = stubGL()
    expect(() => createRenderTarget(gl, 0, 64)).toThrow(TargetAllocationError)
    expect(() => createRenderTarget(gl, 64.5, 64)).toThrow(TargetAllocationError)
  })
})

describe('target pool', () => {
  it('allocates two targets for a ping-pong chain and none thereafter', () => {
    // The assertion the pool exists for. A chain of any length uses two buffers,
    // and a steady state must allocate nothing: reallocating per frame at proxy
    // size is hundreds of megabytes of churn per second.
    const pool = new TargetPool(stubGL())

    for (let frame = 0; frame < 60; frame++) {
      const a = pool.acquire(2048, 1365)
      const b = pool.acquire(2048, 1365)
      pool.release(a)
      pool.release(b)
      pool.prune(2048, 1365)
    }

    expect(pool.allocationCount).toBe(2)
    expect(pool.liveCount).toBe(0)
  })

  it('reuses a released target of the same size', () => {
    const pool = new TargetPool(stubGL())
    const first = pool.acquire(256, 256)
    pool.release(first)
    expect(pool.acquire(256, 256)).toBe(first)
    expect(pool.allocationCount).toBe(1)
  })

  it('allocates again after a resize, then settles', () => {
    const gl = stubGL()
    const pool = new TargetPool(gl)

    const before = pool.acquire(2048, 1365)
    pool.release(before)
    pool.prune(2048, 1365)

    // Resize: the old size is pruned and the new one allocated once.
    const after = pool.acquire(1024, 683)
    pool.release(after)
    pool.prune(1024, 683)

    expect(pool.allocationCount).toBe(2)
    expect(gl.deletedTextures).toBe(1)

    for (let frame = 0; frame < 10; frame++) {
      pool.release(pool.acquire(1024, 683))
      pool.prune(1024, 683)
    }
    expect(pool.allocationCount).toBe(2)
  })

  it('does not evict on acquire, so alternating sizes do not thrash', () => {
    // prune() is what evicts, and it is called with the size actually in use.
    // Evicting inside acquire would make a chain that alternates sizes
    // reallocate every single frame, which is the opposite of the point.
    const pool = new TargetPool(stubGL())
    pool.release(pool.acquire(64, 64))
    pool.release(pool.acquire(128, 128))
    pool.release(pool.acquire(64, 64))
    expect(pool.allocationCount).toBe(2)
  })

  it('refuses a double release rather than handing the same buffer out twice', () => {
    // A doubly-released target would sit on the free list twice and be acquired
    // as both the read and the write buffer of one pass, which corrupts
    // intermittently instead of failing.
    const pool = new TargetPool(stubGL())
    const target = pool.acquire(32, 32)
    pool.release(target)
    expect(() => pool.release(target)).toThrow(TargetAllocationError)
  })

  it('disposes targets on the free list and targets still handed out', () => {
    const gl = stubGL()
    const pool = new TargetPool(gl)

    const free = pool.acquire(32, 32)
    const live = pool.acquire(32, 32)
    pool.release(free)
    const otherSize = pool.acquire(64, 64)

    expect(pool.allocationCount).toBe(3)
    expect(pool.freeCount).toBe(1)
    expect(pool.liveCount).toBe(2)

    pool.disposeAll()

    // All three, not just the ones on the free list: a target still checked out
    // at teardown is the common case, since dispose happens mid-frame.
    expect(gl.deletedFramebuffers).toBe(3)
    expect(gl.deletedTextures).toBe(3)
    expect(pool.liveCount).toBe(0)
    expect(pool.freeCount).toBe(0)
    void live
    void otherSize
  })
})
