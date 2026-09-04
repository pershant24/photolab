/**
 * The export worker.
 *
 * A 60MP export renders tens of tiles through the full pass chain and encodes a
 * quarter of a gigabyte of pixels. On the main thread that is seconds of frozen
 * interface; here it is seconds of a progress count moving.
 *
 * # It runs the same pass chain, not a second one
 *
 * The graph, the passes, the shaders and `exportImage` are all imported from
 * exactly where the interactive path gets them. A forked render path would
 * destroy the parity invariant this project has held since Stage 3 and would do
 * it silently, because the two would agree on the day they were written.
 *
 * What made that possible was already true: `RenderGraph` was built around `gl`
 * rather than around a canvas, so nothing between the graph and the passes has
 * ever known there is a DOM. The only change needed was widening
 * `RenderContext` to accept an `OffscreenCanvas`.
 *
 * # Its own context, and what that costs
 *
 * A worker cannot share a `WebGLRenderingContext` with the main thread, so this
 * creates its own — which means its own program cache, and the first export
 * compiles every enabled pass from scratch. Measured in
 * `tests/render/export-worker.spec.ts`; the short version is that it is tens of
 * milliseconds against an export measured in seconds, and it is paid once per
 * worker rather than once per export.
 *
 * The canvas is created here rather than transferred from the main thread. There
 * is nothing to display, so there is no element to transfer from, and a 1x1
 * surface is enough — every pixel the export produces goes to a framebuffer the
 * graph allocates and then to an `OffscreenCanvas` sized to the image.
 */

import { RenderGraph } from './graph'
import { RendererUnsupportedError, createRenderContext } from './gl/context'
import { createCurvePass } from './passes/curve'
import { createFilmCurvesPass } from './passes/filmCurves'
import { registeredPasses } from './passes/registry'
import { ExportError, exportImage } from './export'
import type { ExportRequest, ExportResponse, MemoryReport } from './exportProtocol'

/** Set when a cancel arrives for the export currently running. */
let cancelledId: number | null = null

function reply(message: ExportResponse): void {
  self.postMessage(message)
}

/**
 * Peak memory the agent attributes to this worker.
 *
 * `performance.measureUserAgentSpecificMemory` is the only API that sees an
 * `ImageBitmap`, a GPU-backed canvas or a detached ArrayBuffer — `performance.memory`
 * reports the JS heap and would say 15MB while a quarter of a gigabyte of pixels
 * is resident. It needs cross-origin isolation, and reports plainly when it does
 * not have it rather than falling back to a number that means something else.
 */
async function measureMemory(): Promise<MemoryReport | null> {
  const api = performance as unknown as {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>
  }
  if (!api.measureUserAgentSpecificMemory) {
    return {
      kind: 'unavailable',
      reason: `API absent (crossOriginIsolated: ${String(self.crossOriginIsolated)})`,
    }
  }
  try {
    return { kind: 'measured', beforeBytes: (await api.measureUserAgentSpecificMemory()).bytes, peakBytes: 0 }
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}

self.onmessage = async (event: MessageEvent<ExportRequest>) => {
  const request = event.data
  if (request.kind === 'cancel') {
    cancelledId = request.id
    return
  }

  const { id } = request
  cancelledId = null

  // A 1x1 surface: nothing is displayed, and every pixel goes to a framebuffer.
  const surface = new OffscreenCanvas(1, 1)
  let context
  try {
    context = createRenderContext(surface)
  } catch (error) {
    // Loud, per the standing rule. A worker whose context lacks the half-float
    // support the pipeline is built on must say so rather than quietly producing
    // an 8-bit approximation of the picture.
    reply({
      kind: 'failed',
      id,
      message:
        error instanceof RendererUnsupportedError
          ? error.message
          : 'The export worker could not create a WebGL2 context.',
      unsupported: true,
    })
    return
  }

  const graph = new RenderGraph(context, registeredPasses(createCurvePass(), createFilmCurvesPass()))

  let before: MemoryReport | null = null
  let peak = null as MemoryReport | null
  if (request.measureMemory) before = await measureMemory()

  try {
    const result = await exportImage(
      context,
      graph,
      request.blob,
      request.edit,
      request.view,
      request.sourceWidth,
      request.sourceHeight,
      {
        format: request.format,
        ...(request.quality === undefined ? {} : { quality: request.quality }),
        onProgress: (done, total) => reply({ kind: 'progress', id, done, total }),
        shouldCancel: () => cancelledId === id,
        ...(request.measureMemory
          ? {
              onBeforeEncode: async () => {
                peak = await measureMemory()
              },
            }
          : {}),
      },
    )

    // Taken by `onBeforeEncode`, while every buffer is still alive.
    const memory: MemoryReport =
      before?.kind === 'measured' && peak?.kind === 'measured'
        ? { kind: 'measured', beforeBytes: before.beforeBytes, peakBytes: peak.beforeBytes }
        : (peak ?? before ?? { kind: 'unavailable', reason: 'not requested' })

    reply({
      kind: 'done',
      id,
      blob: result.blob,
      width: result.width,
      height: result.height,
      tiles: result.tiles,
      overlap: result.overlap,
      milliseconds: result.milliseconds,
      uploadPath: result.uploadPath,
      memory,
    })
  } catch (error) {
    if (error instanceof ExportError && error.cancelled) {
      reply({ kind: 'cancelled', id })
      return
    }
    reply({
      kind: 'failed',
      id,
      message: error instanceof Error ? error.message : 'Export failed.',
      unsupported: false,
    })
  } finally {
    context.dispose()
  }
}
