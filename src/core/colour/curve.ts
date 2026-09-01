/**
 * Monotone cubic interpolation (PCHIP) for tone and channel curves.
 *
 * ## Why not Catmull-Rom or a natural cubic spline
 *
 * Both overshoot. Given control points that rise and then level off, they swing
 * above the highest control point and back down, which on a tone curve is a
 * region that gets *darker* as the curve above it is raised. That is a visible
 * artifact — a local contrast inversion in the highlights — not a theoretical
 * concern, and it appears with entirely reasonable control points.
 *
 * PCHIP (Fritsch-Carlson) chooses the tangent at each control point as a
 * weighted harmonic mean of the neighbouring secant slopes, and sets it to zero
 * wherever those slopes disagree in sign. The consequence is that the
 * interpolant is monotone on every interval where the control points are, and
 * never leaves the range of the control points that bracket it. Both of those
 * are asserted in `tests/unit/curve.test.ts`, the second with deliberately
 * non-monotone control points, because that is the case that separates PCHIP
 * from the splines above.
 *
 * ## This module is the one deliberate exception to shader translatability
 *
 * Every other function in `src/core/colour/` is a per-pixel operation with a
 * line-for-line GLSL equivalent, and the project's standing rule is that
 * anything which cannot be transliterated should be restructured rather than
 * excused. This module is the exception, and it is granted rather than
 * tolerated. **Do not attempt to port it to GLSL.**
 *
 * It cannot be ported: the tangents depend on the entire control point set, so
 * a fragment shader would have to loop over a variable-length array of them for
 * every pixel. It also uses a throwing dynamic accessor, which has no GLSL
 * equivalent at all.
 *
 * ## The architectural constraint that resolves it
 *
 * **Curves are baked into a 1D lookup texture on the CPU and uploaded; the
 * shader samples the LUT and never evaluates a spline.** That is a rule binding
 * the render graph, not a note about this file — it is stated as such in
 * `docs/ARCHITECTURE.md`, and {@link sampleCurveLut} is the function that
 * implements it.
 *
 * The exception is earned by that rule rather than asserted alongside it. A
 * rebake happens once per control-point change — a slider drag at most, not per
 * frame and not per pixel — so the variable-length loop runs on the CPU where
 * loops are free, and the throwing accessor sits off the hot path **by
 * construction** rather than by anyone remembering to keep it there. Had curves
 * been evaluated per pixel, neither concession would have been available and the
 * module would have had to be restructured after all.
 */

/**
 * Read `a[i]`, converting the `| undefined` that `noUncheckedIndexedAccess`
 * gives every dynamic index into a thrown error.
 *
 * The alternative is a non-null assertion on every one of the ~20 dynamic
 * accesses below, which would turn a flag that catches real mistakes into a
 * pattern nobody reads. One checked accessor keeps the guarantee and costs a
 * comparison in code that runs when a curve changes, not per pixel.
 */
function at(a: readonly number[], i: number): number {
  const v = a[i]
  if (v === undefined) {
    throw new RangeError(`curve: index ${i} out of range (length ${a.length})`)
  }
  return v
}

/**
 * Fritsch-Carlson tangents for the control points `(xs[i], ys[i])`.
 *
 * `xs` must be strictly increasing. Returns one tangent per control point, for
 * {@link evaluateCurveWithTangents} to consume; separated from evaluation so a
 * LUT bake pays for it once rather than once per sample.
 */
export function curveTangents(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length
  if (n !== ys.length) {
    throw new RangeError(`curveTangents: xs has ${n} points, ys has ${ys.length}`)
  }
  if (n < 2) {
    throw new RangeError(`curveTangents: need at least 2 control points, got ${n}`)
  }

  const h: number[] = []
  const delta: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = at(xs, i + 1) - at(xs, i)
    if (!(dx > 0)) {
      throw new RangeError(`curveTangents: xs must be strictly increasing (xs[${i + 1}] <= xs[${i}])`)
    }
    h.push(dx)
    delta.push((at(ys, i + 1) - at(ys, i)) / dx)
  }

  // Two control points is a straight line; the general formulas below index a
  // second interval that does not exist.
  if (n === 2) {
    return [at(delta, 0), at(delta, 0)]
  }

  const d: number[] = new Array<number>(n).fill(0)

  // Interior tangents. A sign disagreement between the two neighbouring secants
  // means this control point is a local extremum, and a zero tangent is what
  // stops the interpolant overshooting past it. Otherwise the weighted harmonic
  // mean, which is bounded by three times the smaller secant and is what makes
  // monotonicity automatic rather than something to clamp for afterwards.
  for (let i = 1; i < n - 1; i++) {
    const dPrev = at(delta, i - 1)
    const dNext = at(delta, i)
    if (dPrev * dNext <= 0) {
      d[i] = 0
      continue
    }
    const wPrev = 2 * at(h, i) + at(h, i - 1)
    const wNext = at(h, i) + 2 * at(h, i - 1)
    d[i] = (wPrev + wNext) / (wPrev / dPrev + wNext / dNext)
  }

  d[0] = endpointTangent(at(h, 0), at(h, 1), at(delta, 0), at(delta, 1))
  d[n - 1] = endpointTangent(
    at(h, n - 2),
    at(h, n - 3),
    at(delta, n - 2),
    at(delta, n - 3),
  )

  return d
}

/**
 * The one-sided three-point tangent at an end control point, with the two
 * corrections that keep it monotone: drop to zero if it disagrees in sign with
 * the adjacent secant, and clamp to three times that secant if the interior is
 * turning the other way. Without these an end point can overshoot even though
 * every interior tangent is well behaved.
 */
function endpointTangent(hEnd: number, hInner: number, deltaEnd: number, deltaInner: number): number {
  let d = ((2 * hEnd + hInner) * deltaEnd - hEnd * deltaInner) / (hEnd + hInner)
  if (d * deltaEnd <= 0) {
    d = 0
  } else if (deltaEnd * deltaInner <= 0 && Math.abs(d) > Math.abs(3 * deltaEnd)) {
    d = 3 * deltaEnd
  }
  return d
}

/**
 * Evaluate the curve at `x` given precomputed `tangents`.
 *
 * Outside the control point range the curve is **clamped**, not extrapolated.
 * A cubic continued past its last control point diverges quickly, and the
 * values feeding a tone curve are linear light and unbounded above.
 */
export function evaluateCurveWithTangents(
  xs: readonly number[],
  ys: readonly number[],
  tangents: readonly number[],
  x: number,
): number {
  const n = xs.length
  if (x <= at(xs, 0)) return at(ys, 0)
  if (x >= at(xs, n - 1)) return at(ys, n - 1)

  // Binary search for the interval containing x.
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (at(xs, mid) <= x) {
      lo = mid
    } else {
      hi = mid
    }
  }

  const h = at(xs, hi) - at(xs, lo)
  const t = (x - at(xs, lo)) / h

  // Cubic Hermite basis.
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2

  return (
    h00 * at(ys, lo) +
    h10 * h * at(tangents, lo) +
    h01 * at(ys, hi) +
    h11 * h * at(tangents, hi)
  )
}

/** Evaluate the curve at a single `x`, computing tangents on the spot. */
export function evaluateCurve(xs: readonly number[], ys: readonly number[], x: number): number {
  return evaluateCurveWithTangents(xs, ys, curveTangents(xs, ys), x)
}

/**
 * Bake the curve into `count` evenly spaced samples spanning the control point
 * range inclusive, ready to upload as a 1D lookup texture.
 *
 * This is the function the shader path actually uses; see the module comment.
 *
 * **The texture coordinate maps to `[xs[0], xs[n-1]]`, not to `[0, 1]`.** Sample
 * 0 is the curve at the first control point and sample `count - 1` is the curve
 * at the last. For the usual tone curve those are 0 and 1 and the distinction
 * does not arise, but a curve whose control points span some other range — a
 * film characteristic curve over a log exposure axis, for instance — must have
 * its input remapped into `[0, 1]` before sampling, or the shader reads the
 * wrong part of the curve without anything looking obviously broken.
 */
export function sampleCurveLut(
  xs: readonly number[],
  ys: readonly number[],
  count: number,
): Float32Array {
  if (count < 2) {
    throw new RangeError(`sampleCurveLut: need at least 2 samples, got ${count}`)
  }
  const tangents = curveTangents(xs, ys)
  const x0 = at(xs, 0)
  const x1 = at(xs, xs.length - 1)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const x = x0 + ((x1 - x0) * i) / (count - 1)
    out[i] = evaluateCurveWithTangents(xs, ys, tangents, x)
  }
  return out
}
