/**
 * RGBA16F render targets and the pool that keeps a pass chain from reallocating
 * one per frame.
 *
 * A pass chain ping-pongs: read buffer A, write buffer B, swap, repeat. Two
 * targets of the proxy size serve the whole chain however many passes it has,
 * so the pool's job is to hand the same two back every frame and to allocate
 * only when the size actually changes.
 *
 * The targets are RGBA16F, never 32F. Half float carries a 10-bit mantissa and
 * an exponent reaching 65504, which is ample for scene-referred values across
 * twelve stops, at half the memory and bandwidth. The memory matters: a 60MP
 * image at RGBA16F is already 480MB per buffer, and a 32F ping-pong pair would
 * be two gigabytes.
 */

/** The subset of WebGL2 this module uses, so a test can supply a counting stub. */
export type TargetGL = Pick<
  WebGL2RenderingContext,
  | 'createTexture'
  | 'bindTexture'
  | 'texStorage2D'
  | 'texParameteri'
  | 'deleteTexture'
  | 'createFramebuffer'
  | 'bindFramebuffer'
  | 'framebufferTexture2D'
  | 'checkFramebufferStatus'
  | 'deleteFramebuffer'
  | 'TEXTURE_2D'
  | 'RGBA16F'
  | 'TEXTURE_MIN_FILTER'
  | 'TEXTURE_MAG_FILTER'
  | 'TEXTURE_WRAP_S'
  | 'TEXTURE_WRAP_T'
  | 'LINEAR'
  | 'CLAMP_TO_EDGE'
  | 'FRAMEBUFFER'
  | 'COLOR_ATTACHMENT0'
  | 'FRAMEBUFFER_COMPLETE'
>

export interface RenderTarget {
  readonly texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  readonly width: number
  readonly height: number
}

export class TargetAllocationError extends Error {
  override readonly name = 'TargetAllocationError'
}

function sizeKey(width: number, height: number): string {
  return `${width}x${height}`
}

/**
 * Allocate one RGBA16F target.
 *
 * `texStorage2D` rather than `texImage2D`: it allocates immutable storage in one
 * call, which lets the driver skip the completeness re-validation that a mutable
 * texture needs on every bind.
 *
 * `CLAMP_TO_EDGE` is not a default worth inheriting silently — a spatial kernel
 * sampling past the edge of a `REPEAT` texture wraps around and pulls the
 * opposite side of the frame into the border, which reads as a strange halo
 * rather than as an obvious bug.
 */
export function createRenderTarget(gl: TargetGL, width: number, height: number): RenderTarget {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TargetAllocationError(`invalid target size ${width}x${height}`)
  }

  const texture = gl.createTexture()
  if (!texture) throw new TargetAllocationError('gl.createTexture() returned null')

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const framebuffer = gl.createFramebuffer()
  if (!framebuffer) {
    gl.deleteTexture(texture)
    throw new TargetAllocationError('gl.createFramebuffer() returned null')
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer)
    gl.deleteTexture(texture)
    throw new TargetAllocationError(
      `RGBA16F framebuffer incomplete (status 0x${status.toString(16)}) at ${width}x${height}`,
    )
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.bindTexture(gl.TEXTURE_2D, null)

  return { texture, framebuffer, width, height }
}

/**
 * A free list of render targets keyed by size.
 *
 * `acquire` reuses a free target of the exact size if one exists and allocates
 * otherwise; `release` returns it. Steady state for a proxy chain is two
 * allocations total, reused every frame.
 *
 * Sizes other than the current one are not evicted on acquire, because a chain
 * that alternates between two sizes would then reallocate on every frame — the
 * opposite of the point. {@link prune} does the eviction, called once per frame
 * with the size actually in use, so a resize costs one round of reallocation and
 * a steady state costs none.
 */
export class TargetPool {
  #gl: TargetGL
  #free = new Map<string, RenderTarget[]>()
  #live = new Set<RenderTarget>()
  #allocations = 0

  constructor(gl: TargetGL) {
    this.#gl = gl
  }

  /** Total targets allocated over this pool's life. Steady state must not grow. */
  get allocationCount(): number {
    return this.#allocations
  }

  /** Targets currently handed out and not yet released. */
  get liveCount(): number {
    return this.#live.size
  }

  /** Targets allocated and available for reuse. */
  get freeCount(): number {
    let total = 0
    for (const list of this.#free.values()) total += list.length
    return total
  }

  acquire(width: number, height: number): RenderTarget {
    const pooled = this.#free.get(sizeKey(width, height))?.pop()
    if (pooled) {
      this.#live.add(pooled)
      return pooled
    }
    const created = createRenderTarget(this.#gl, width, height)
    this.#allocations += 1
    this.#live.add(created)
    return created
  }

  release(target: RenderTarget): void {
    if (!this.#live.delete(target)) {
      // Releasing twice would put the same target on the free list twice and let
      // a later frame read and write it simultaneously, which produces
      // intermittent corruption rather than a clean failure.
      throw new TargetAllocationError('released a target that the pool does not have out')
    }
    const key = sizeKey(target.width, target.height)
    const list = this.#free.get(key)
    if (list) list.push(target)
    else this.#free.set(key, [target])
  }

  /** Dispose every *free* target whose size is not `width`x`height`. */
  prune(width: number, height: number): void {
    const keep = sizeKey(width, height)
    for (const [key, list] of this.#free) {
      if (key === keep) continue
      for (const target of list) this.#destroy(target)
      this.#free.delete(key)
    }
  }

  disposeAll(): void {
    for (const list of this.#free.values()) {
      for (const target of list) this.#destroy(target)
    }
    this.#free.clear()
    for (const target of this.#live) this.#destroy(target)
    this.#live.clear()
  }

  #destroy(target: RenderTarget): void {
    this.#gl.deleteFramebuffer(target.framebuffer)
    this.#gl.deleteTexture(target.texture)
  }
}
