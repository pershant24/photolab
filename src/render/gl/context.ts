/**
 * WebGL2 context creation and the capability checks the renderer's premise
 * depends on.
 *
 * The context attributes are all deliberate:
 *
 * - `alpha: false` and `premultipliedAlpha: false` — the canvas is opaque and
 *   compositing it against the page must not multiply anything into the colour
 *   we spent the whole pipeline computing.
 * - `antialias: false` — every draw is a full-screen quad. There are no edges to
 *   sample, so multisampling costs bandwidth for nothing.
 * - `preserveDrawingBuffer: false` — keeping the buffer alive between frames
 *   forces the driver to allocate and copy. Anything that needs to read pixels
 *   reads them in the same task that drew them.
 */

/**
 * Thrown when the browser cannot support the pipeline. Carries a message that is
 * safe to show a user, because the alternative to showing one is degrading
 * silently, which for a colour pipeline is the worst available outcome.
 */
export class RendererUnsupportedError extends Error {
  override readonly name = 'RendererUnsupportedError'

  constructor(
    message: string,
    /** Short technical detail for the console; not for the interface. */
    readonly detail: string,
  ) {
    super(message)
  }
}

export interface RenderCapabilities {
  /**
   * A runtime value, not a constant. Measured at 8192 under SwiftShader and
   * common on integrated and mobile GPUs, which makes it a production limit
   * rather than a test artifact: a 60MP source at 3:2 is roughly 9500px on the
   * long edge and cannot be uploaded as one texture on such a device.
   */
  readonly maxTextureSize: number
  readonly maxRenderbufferSize: number
  readonly colorBufferFloat: boolean
  readonly colorBufferHalfFloat: boolean
  readonly renderer: string
}

export type ContextStatus = 'ok' | 'lost'

/**
 * A canvas the renderer can draw into.
 *
 * Either kind. `OffscreenCanvas` is what the export worker uses: it has no
 * document to be attached to, and export never displays anything.
 *
 * This is the whole of what it took to make the pipeline context-agnostic, and
 * it is small for a reason worth stating — `RenderGraph` was built around `gl`
 * rather than around the canvas from Stage 3, so nothing between the graph and
 * the passes ever learned there was a DOM. Only `Renderer` reads the canvas, for
 * sizing and the drag proxy, and the export path does not use `Renderer` at all.
 */
export type RenderSurface = HTMLCanvasElement | OffscreenCanvas

export interface RenderContext {
  readonly gl: WebGL2RenderingContext
  readonly canvas: RenderSurface
  readonly capabilities: RenderCapabilities
  /** Never render while this is `'lost'`; every GL object is invalid. */
  status(): ContextStatus
  /** Notified on loss and on restore. Returns an unsubscribe function. */
  onStatusChange(listener: (status: ContextStatus) => void): () => void
  dispose(): void
}

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  premultipliedAlpha: false,
  antialias: false,
  preserveDrawingBuffer: false,
  depth: false,
  stencil: false,
  desynchronized: false,
  powerPreference: 'high-performance',
}

const NO_HALF_FLOAT_MESSAGE =
  'This browser cannot render high-precision colour. photolab needs WebGL2 with ' +
  'a half-float framebuffer, which this device or browser does not provide. ' +
  'Try a recent Chrome, Edge, Firefox or Safari, or a machine with a different ' +
  'graphics driver.'

const NO_WEBGL2_MESSAGE =
  'This browser does not support WebGL2, which photolab needs in order to ' +
  'process images on your machine. Try a recent Chrome, Edge, Firefox or Safari.'

/**
 * Create the context and verify the pipeline's preconditions.
 *
 * Throws {@link RendererUnsupportedError} rather than falling back to RGBA8.
 * That is the important line in this file. An 8-bit fallback would keep
 * producing images, and they would be quietly wrong — banded in gradients,
 * clipped wherever the pipeline holds values above display white, and unable to
 * carry the negative values a wide-gamut working space legitimately produces.
 * A pipeline whose premise has silently been removed is worse than one that
 * says it cannot run.
 */
export function createRenderContext(canvas: RenderSurface): RenderContext {
  /*
   * The canvas is narrowed BEFORE `getContext` is called, and the two branches
   * are textually identical on purpose. Do not merge them.
   *
   * There used to be one call on the `HTMLCanvasElement | OffscreenCanvas` union,
   * followed by `as WebGL2RenderingContext | null`. The comment on it said the
   * cast narrowed a union return type. It did not. The TypeScript compiler
   * resolves that call to `WebGL2RenderingContext | null` either way — checked
   * through the compiler API on the full program and on this file alone.
   *
   * What the cast actually did was cover a type-aware lint program that, in one
   * file order, **could not resolve the call at all**. With `export.worker.ts`
   * linted before this file, typescript-eslint typed `gl` as an error type and
   * flagged nine unsafe calls below; with this file first, it resolved the call
   * and flagged the cast as unnecessary instead. `eslint .` reaches the worker
   * first, so the one lint gate — the same command locally and in CI — reported
   * nothing, and a single-file run reported the opposite.
   *
   * Calling `getContext` on a concrete type in each branch removes the union
   * overload resolution from the question. Narrowed with an `in` check rather
   * than `instanceof`, so no branch references a global that a given context
   * might not define. That this removes the order dependence is verified; WHY
   * typescript-eslint resolves the union call differently by file order is not
   * understood, and tests/README.md records it as unexplained rather than as a
   * mechanism.
   */
  const gl =
    'transferToImageBitmap' in canvas
      ? canvas.getContext('webgl2', CONTEXT_ATTRIBUTES)
      : canvas.getContext('webgl2', CONTEXT_ATTRIBUTES)
  if (!gl) {
    throw new RendererUnsupportedError(NO_WEBGL2_MESSAGE, 'getContext("webgl2") returned null')
  }

  // Either extension makes RGBA16F colour-renderable, and both are accepted:
  // Chrome has historically exposed only the former, and the probe records both
  // as present on the test browser. See tests/README.md.
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null
  const colorBufferHalfFloat = gl.getExtension('EXT_color_buffer_half_float') !== null

  if (!colorBufferFloat && !colorBufferHalfFloat) {
    throw new RendererUnsupportedError(
      NO_HALF_FLOAT_MESSAGE,
      'neither EXT_color_buffer_float nor EXT_color_buffer_half_float is available',
    )
  }

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER))

  const capabilities: RenderCapabilities = {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    colorBufferFloat,
    colorBufferHalfFloat,
    renderer,
  }

  let status: ContextStatus = 'ok'
  const listeners = new Set<(status: ContextStatus) => void>()

  const publish = (next: ContextStatus): void => {
    status = next
    for (const listener of listeners) listener(next)
  }

  // preventDefault() is what makes the loss recoverable at all: without it the
  // browser will not fire `webglcontextrestored`, and the canvas stays dead for
  // the life of the page.
  const onLost = (event: Event): void => {
    event.preventDefault()
    publish('lost')
  }
  const onRestored = (): void => {
    publish('ok')
  }

  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  return {
    gl,
    canvas,
    capabilities,
    status: () => status,
    onStatusChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      listeners.clear()
    },
  }
}
