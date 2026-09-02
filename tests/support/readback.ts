/**
 * Reading pixels back out of a render, without the two mistakes that keep
 * happening.
 *
 * # Mistake one: assuming the colour space
 *
 * `displayMode: 'identity'` skips the tone map and the gamut compression. It does
 * **not** skip the primaries matrix or the sRGB transfer function, because the
 * round-trip test it exists for needs sRGB in to equal sRGB out. A readback is
 * therefore display-encoded, and reading it as linear ACEScg is wrong.
 *
 * That has now happened twice, both times by someone who had just written the
 * comment explaining it. In the grain amplitude profile it moved an apparent peak
 * by 1.3 stops and looked like a plausible answer; in the wheels agreement test
 * it gave an 800% error, which was luck rather than diligence. Twice by people
 * who knew better makes it structural: **the mode names what the pass does, not
 * what space its output is in.**
 *
 * So a readback here carries its space with it. A caller that wants linear
 * working-space values has to say so and gets the conversion; a caller that
 * forgets gets a field called `space` sitting in the object it destructured.
 *
 * # Mistake two: assuming row order
 *
 * `readPixels` fills bottom-up. Indexing rows directly has produced a comparison
 * against **zero samples** — a tonal range selected by row index turned out to be
 * the opposite end of the ramp, every sample failed the skip threshold, and the
 * loop silently compared nothing and passed. It is the same shape as the grain
 * y-flip: an orientation assumption that yields a plausible wrong answer instead
 * of an error.
 *
 * So this exposes `at(x, y)` in **image** coordinates, with the flip inside it,
 * and never hands out a raw index.
 */

/**
 * What a readback actually contains.
 *
 * There is deliberately no `'linear-acescg'` member. Nothing in the pipeline can
 * currently produce one from a final-target render — the display pass always runs
 * — and offering the name would invite exactly the assumption this exists to
 * prevent.
 */
export type ReadbackSpace = 'display-encoded-srgb'

export interface Readback {
  readonly width: number
  readonly height: number
  /** RGBA, row-major from the TOP, already flipped. */
  readonly values: Float32Array
  readonly space: ReadbackSpace
}

/**
 * The page-side helper, as source to interpolate into `page.evaluate`.
 *
 * A string rather than an import because it runs in the browser and cannot close
 * over anything from here. Defines `__render(renderer, options)`.
 */
export const READBACK_SOURCE = `
const __decodeHalf = (h) => {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x3ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
}

/**
 * Render and read back, flipping to top-down on the way out.
 *
 * The flip happens here, once, so that no caller ever indexes a bottom-up buffer.
 */
function __render(renderer, options) {
  const gl = renderer.context.gl
  const viewport = options.viewport
  const width = viewport.resolution[0]
  const height = viewport.resolution[1]
  const target = renderer.graph.pool.acquire(width, height)
  renderer.graph.render(
    {
      ...renderer.input,
      edit: { ...renderer.input.edit, ...(options.edit || {}) },
      view: { ...renderer.input.view, ...(options.view || {}) },
    },
    viewport,
    { finalTarget: target },
  )
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
  const raw = new Uint16Array(width * height * 4)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, raw)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  renderer.graph.pool.release(target)

  const values = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    // readPixels is bottom-up; row y from the top is row height-1-y in the buffer.
    const from = (height - 1 - y) * width * 4
    const to = y * width * 4
    for (let i = 0; i < width * 4; i++) values[to + i] = __decodeHalf(raw[from + i])
  }
  return { width, height, values: Array.from(values), space: 'display-encoded-srgb' }
}
`

/** Index a readback in image coordinates, origin top-left. */
export function at(readback: Readback, x: number, y: number): [number, number, number] {
  if (x < 0 || y < 0 || x >= readback.width || y >= readback.height) {
    throw new RangeError(`(${x}, ${y}) is outside a ${readback.width}x${readback.height} readback`)
  }
  const i = (y * readback.width + x) * 4
  return [readback.values[i] ?? 0, readback.values[i + 1] ?? 0, readback.values[i + 2] ?? 0]
}

/** Turn what came back into an object with a real Float32Array. */
export function toReadback(raw: {
  width: number
  height: number
  values: number[]
  space: string
}): Readback {
  return {
    width: raw.width,
    height: raw.height,
    values: Float32Array.from(raw.values),
    space: raw.space as ReadbackSpace,
  }
}

/**
 * Assert a readback is in the space a caller is about to treat it as.
 *
 * Call it. The point of carrying the space is that somebody checks it, and a
 * field nobody reads is a comment.
 */
export function assertSpace(readback: Readback, expected: ReadbackSpace): void {
  // Compared as strings, because `ReadbackSpace` currently has one member and the
  // type checker narrows the comparison to `never`. The check is still worth
  // making: it is a runtime guard against a caller that got its readback from
  // somewhere else, and it stops being vacuous the moment a second space exists.
  const actual: string = readback.space
  if (actual !== (expected as string)) {
    throw new Error(
      `readback is ${actual}, and is about to be used as ${String(expected)}. ` +
        'Convert it rather than reinterpreting it.',
    )
  }
}

const SRGB_BREAK = 0.04045

/** sRGB EOTF, for turning a readback into linear display-primary values. */
export function srgbToLinear(encoded: number): number {
  return encoded <= SRGB_BREAK ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4)
}

/**
 * A readback pixel as linear light in display primaries.
 *
 * Named for what it returns. There is no `toAcescg` here because that needs the
 * inverse primaries matrix and a caller who has thought about which one — the
 * point being to make the conversion a decision rather than an assumption.
 */
export function linearAt(readback: Readback, x: number, y: number): [number, number, number] {
  assertSpace(readback, 'display-encoded-srgb')
  const [r, g, b] = at(readback, x, y)
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]
}
