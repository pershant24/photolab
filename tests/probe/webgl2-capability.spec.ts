import { expect, test } from '@playwright/test'

/**
 * Capability probe, not a feature test.
 *
 * Every visual test in this repository (golden images, the two-resolution
 * invariant, shader-vs-TypeScript ramps) runs in headless Chromium on
 * SwiftShader, and all of it assumes an RGBA16F framebuffer is colour
 * renderable there. If that assumption is false the test architecture needs an
 * RGBA8 fallback, so this probe asserts it directly rather than letting it fail
 * obliquely inside a golden comparison.
 *
 * It also records the readback format of a half-float framebuffer, which is
 * what forces tiled export to resolve through an RGBA8 target.
 */

interface Probe {
  webgl2: boolean
  renderer: string
  vendor: string
  maxTextureSize: number
  maxRenderbufferSize: number
  colorBufferFloat: boolean
  colorBufferHalfFloat: boolean
  floatLinear: boolean
  rgba16fComplete: boolean
  rgba16fStatus: string
  /** Values above 1.0 survive a round trip, i.e. the buffer really is HDR. */
  rgba16fHdrRoundTrip: number[] | null
  /** gl.IMPLEMENTATION_COLOR_READ_{FORMAT,TYPE} while an RGBA16F FBO is bound. */
  halfFloatReadFormat: string
  halfFloatReadType: string
  rgba8ReadsAsUnsignedByte: boolean
  extensions: string[]
}

test('SwiftShader supports the RGBA16F pipeline the renderer assumes', async ({ page }) => {
  await page.goto('/')

  const probe = await page.evaluate<Probe>(() => {
    const enumName = (gl: WebGL2RenderingContext, value: number): string => {
      for (const key of Object.keys(Object.getPrototypeOf(gl) as object)) {
        if (/^[A-Z0-9_]+$/.test(key) && (gl as unknown as Record<string, unknown>)[key] === value) {
          return key
        }
      }
      return `0x${value.toString(16)}`
    }

    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      return {
        webgl2: false,
        renderer: '',
        vendor: '',
        maxTextureSize: 0,
        maxRenderbufferSize: 0,
        colorBufferFloat: false,
        colorBufferHalfFloat: false,
        floatLinear: false,
        rgba16fComplete: false,
        rgba16fStatus: 'no context',
        rgba16fHdrRoundTrip: null,
        halfFloatReadFormat: '',
        halfFloatReadType: '',
        rgba8ReadsAsUnsignedByte: false,
        extensions: [],
      }
    }

    // Either extension makes RGBA16F colour renderable in WebGL2. Chrome has
    // historically exposed only EXT_color_buffer_float, so both are accepted.
    const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null
    const colorBufferHalfFloat = gl.getExtension('EXT_color_buffer_half_float') !== null
    const floatLinear = gl.getExtension('OES_texture_float_linear') !== null

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER))
    const vendor = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL))
      : String(gl.getParameter(gl.VENDOR))

    const makeFbo = (internalFormat: number, format: number, type: number) => {
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      return gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    }

    const halfStatus = makeFbo(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)
    const rgba16fComplete = halfStatus === gl.FRAMEBUFFER_COMPLETE

    let hdr: number[] | null = null
    let halfFloatReadFormat = ''
    let halfFloatReadType = ''

    if (rgba16fComplete) {
      halfFloatReadFormat = enumName(
        gl,
        gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number,
      )
      halfFloatReadType = enumName(
        gl,
        gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number,
      )

      // Clear to values well outside [0,1]; a genuine half-float target keeps
      // them, an 8-bit fallback would clamp to 1.0.
      gl.viewport(0, 0, 4, 4)
      gl.clearColor(4.5, -0.25, 1.75, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const out = new Float32Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, out)
      hdr = gl.getError() === gl.NO_ERROR ? Array.from(out) : null
    }

    const byteStatus = makeFbo(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE)
    let rgba8ReadsAsUnsignedByte = false
    if (byteStatus === gl.FRAMEBUFFER_COMPLETE) {
      gl.viewport(0, 0, 4, 4)
      gl.clearColor(0.5, 0.25, 0.75, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const px = new Uint8Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      rgba8ReadsAsUnsignedByte = gl.getError() === gl.NO_ERROR && px[3] === 255
    }

    return {
      webgl2: true,
      renderer,
      vendor,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      colorBufferFloat,
      colorBufferHalfFloat,
      floatLinear,
      rgba16fComplete,
      rgba16fStatus: enumName(gl, halfStatus),
      rgba16fHdrRoundTrip: hdr,
      halfFloatReadFormat,
      halfFloatReadType,
      rgba8ReadsAsUnsignedByte,
      extensions: (gl.getSupportedExtensions() ?? []).sort(),
    }
  })

  // Printed unconditionally: the numbers matter even when the test passes.
  console.log(JSON.stringify(probe, null, 2))

  expect(probe.webgl2, 'WebGL2 context').toBe(true)
  expect(
    probe.colorBufferFloat || probe.colorBufferHalfFloat,
    'one of EXT_color_buffer_float / EXT_color_buffer_half_float',
  ).toBe(true)
  expect(probe.rgba16fComplete, `RGBA16F framebuffer status: ${probe.rgba16fStatus}`).toBe(true)

  // The point of a half-float target: highlights above 1.0 are not clamped.
  expect(probe.rgba16fHdrRoundTrip).not.toBeNull()
  expect(probe.rgba16fHdrRoundTrip?.[0]).toBeGreaterThan(4)

  expect(probe.rgba8ReadsAsUnsignedByte, 'RGBA8 readback for tiled export').toBe(true)
  expect(probe.maxTextureSize).toBeGreaterThanOrEqual(8192)
})
