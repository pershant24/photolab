/**
 * The tone curve editor. Enough to place, drag and remove control points and see
 * the result; no design work.
 *
 * The x axis is the curve's own domain, which starts at `encodeACEScct(0)` — the
 * ACEScct value of black — rather than at zero. Everything below that describes
 * negative light, so the editor shows the part of the domain that means
 * something.
 *
 * Gestures go through the same `beginInteraction` / `endInteraction` pair as the
 * sliders, so a drag is one undo entry and engages the drag proxy, and the
 * curve's lookup table is rebaked once per change rather than once per frame.
 */

import { useCallback, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { evaluateCurve } from '../core/colour/curve'
import { splitControlPoints, withCurve } from '../core/state/editState'
import type { CurveParameter } from '../core/state/editState'
import { editorStore } from '../core/state/editorStore'

const SIZE = 240

export function CurveEditor({ descriptor }: { descriptor: CurveParameter }) {
  const DESCRIPTOR = descriptor
  const points = useStore(editorStore, (state) => state.edit[descriptor.key])
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)

  const [lo, hi] = DESCRIPTOR.domain

  const toScreen = (x: number, y: number): [number, number] => [
    ((x - lo) / (hi - lo)) * SIZE,
    SIZE - ((y - lo) / (hi - lo)) * SIZE,
  ]
  const toCurve = (px: number, py: number): [number, number] => [
    lo + (px / SIZE) * (hi - lo),
    lo + ((SIZE - py) / SIZE) * (hi - lo),
  ]

  const localPoint = (event: { clientX: number; clientY: number }): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return [0, 0]
    return [event.clientX - rect.left, event.clientY - rect.top]
  }

  const commit = useCallback((next: number[]) => {
    editorStore.setState((state) => ({ edit: withCurve(state.edit, descriptor.key, next) }))
  }, [])

  const { xs, ys } = splitControlPoints(points)

  // The rendered path is the actual spline, not straight lines between control
  // points: a monotone spline and a polyline disagree most exactly where the
  // curve is interesting, and an editor that drew the wrong one would mislead.
  const path = Array.from({ length: 96 }, (_, i) => {
    const x = lo + ((hi - lo) * i) / 95
    const [px, py] = toScreen(x, evaluateCurve(xs, ys, x))
    return `${i === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`
  }).join(' ')

  const pointCount = points.length / 2

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between text-xs">
        <span className="text-ink">{DESCRIPTOR.label}</span>
        <span className="text-ink-dim">
          {pointCount} points · click to add, double-click to remove
        </span>
      </div>

      <svg
        ref={svgRef}
        data-testid="curve-editor"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full touch-none rounded border border-hairline bg-surface"
        onPointerDown={(event) => {
          const [px, py] = localPoint(event)
          // Grab an existing point if the pointer is near one, otherwise add.
          let nearest = -1
          let nearestDistance = Infinity
          for (let i = 0; i < pointCount; i++) {
            const [sx, sy] = toScreen(xs[i] ?? 0, ys[i] ?? 0)
            const distance = Math.hypot(sx - px, sy - py)
            if (distance < nearestDistance) {
              nearestDistance = distance
              nearest = i
            }
          }

          editorStore.getState().beginInteraction()
          if (nearestDistance < 12) {
            setDragging(nearest)
            return
          }

          const [cx, cy] = toCurve(px, py)
          const next = [...points]
          let insertAt = pointCount
          for (let i = 0; i < pointCount; i++) {
            if ((xs[i] ?? 0) > cx) {
              insertAt = i
              break
            }
          }
          next.splice(insertAt * 2, 0, cx, cy)
          commit(next)
          setDragging(insertAt)
        }}
        onPointerMove={(event) => {
          if (dragging === null) return
          const [px, py] = localPoint(event)
          const [cx, cy] = toCurve(px, py)
          const next = [...points]
          // Endpoints keep their x: the domain is the curve's, not the user's to
          // move, and dragging one inward would leave part of the range with no
          // curve over it.
          const isEndpoint = dragging === 0 || dragging === pointCount - 1
          if (!isEndpoint) {
            const before = xs[dragging - 1] ?? lo
            const after = xs[dragging + 1] ?? hi
            // Kept strictly between its neighbours, because the spline requires
            // strictly increasing x and would otherwise reject the whole curve.
            next[dragging * 2] = Math.min(after - 1e-4, Math.max(before + 1e-4, cx))
          }
          next[dragging * 2 + 1] = cy
          commit(next)
        }}
        onPointerUp={() => {
          setDragging(null)
          editorStore.getState().endInteraction()
        }}
        onPointerLeave={() => {
          if (dragging === null) return
          setDragging(null)
          editorStore.getState().endInteraction()
        }}
        onDoubleClick={(event) => {
          const [px, py] = localPoint(event)
          for (let i = 1; i < pointCount - 1; i++) {
            const [sx, sy] = toScreen(xs[i] ?? 0, ys[i] ?? 0)
            if (Math.hypot(sx - px, sy - py) < 12) {
              const next = [...points]
              next.splice(i * 2, 2)
              commit(next)
              return
            }
          }
        }}
      >
        <line x1="0" y1={SIZE} x2={SIZE} y2="0" stroke="currentColor" strokeOpacity="0.15" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
        {Array.from({ length: pointCount }, (_, i) => {
          const [sx, sy] = toScreen(xs[i] ?? 0, ys[i] ?? 0)
          return (
            <circle
              key={i}
              data-testid={`curve-point-${i}`}
              cx={sx}
              cy={sy}
              r="4"
              fill="currentColor"
            />
          )
        })}
      </svg>
    </div>
  )
}
