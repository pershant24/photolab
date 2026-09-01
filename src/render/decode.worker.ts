/**
 * Image decoding, off the main thread.
 *
 * Decoding a 60MP JPEG takes long enough to drop frames, and the main thread is
 * where the render loop lives, so it happens here and the result is transferred
 * rather than copied — `ImageBitmap` is transferable, so handing it back costs
 * nothing regardless of its size.
 *
 * ## Decode straight to proxy size
 *
 * The interactive path never needs the full-resolution image, and creating it as
 * a texture is not merely wasteful but impossible on a lot of hardware:
 * `MAX_TEXTURE_SIZE` is 8192 on SwiftShader and on many integrated and mobile
 * GPUs, while a 60MP source at 3:2 is around 9500px on the long edge. Resizing
 * during decode sidesteps that completely for preview — the oversized texture is
 * never created, so the limit is never reached. Full-resolution handling belongs
 * to tiled export at Stage 5.
 *
 * ## The deviation this introduces, stated rather than discovered later
 *
 * `resizeQuality: 'high'` downsamples the **encoded** 8-bit data, not linear
 * light. Averaging gamma-encoded values is not the same as averaging the light
 * they represent: it under-weights the brighter samples, so fine high-frequency
 * detail comes out slightly darker than a linear-light downscale would give.
 *
 * The consequence is that **preview and export will not be bit-identical in fine
 * detail**, which touches the preview-export parity invariant. It is accepted
 * because it is what essentially every decoder and browser does, the error is
 * confined to detail near the resolution limit, and the alternative is worse:
 * decoding at full resolution and downscaling on the GPU in linear light would
 * be correct, but it reintroduces exactly the `MAX_TEXTURE_SIZE` problem this
 * avoids. Recorded in docs/ARCHITECTURE.md alongside the parity invariant.
 *
 * ## Two decodes' worth of peak memory, one decode's worth of work
 *
 * The true source dimensions are needed for `uImageSize` and by export, and
 * `createImageBitmap` will not report them without producing the bitmap. So the
 * blob is decoded once at full size, resized *from that bitmap* rather than by
 * decoding again, and the full-size one is closed immediately. Peak memory is
 * therefore one full-resolution bitmap — 240MB for a 60MP source, in CPU memory
 * rather than VRAM. Parsing dimensions out of the JPEG and PNG headers would
 * avoid even that, and would have to parse EXIF as well to know whether the
 * dimensions are swapped; deferred as an optimisation rather than a correctness
 * fix.
 */

import type { DecodeRequest, DecodeResponse, DecodeSuccess, DecodeFailure } from './decodeProtocol'
import { proxySize } from './decodeProtocol'

async function decode(blob: Blob): Promise<Omit<DecodeSuccess, 'id' | 'ok'>> {
  // `imageOrientation: 'from-image'` applies EXIF rotation during decode, so
  // nothing downstream ever sees the unrotated shape and no pass needs an
  // orientation transform.
  //
  // `colorSpaceConversion: 'none'` stops the browser converting an embedded
  // profile, which would be an uncontrolled colour transform in the middle of a
  // pipeline whose entire point is controlling them. The consequence is that
  // ingest interprets every file as sRGB, so a Display P3 photograph is read
  // undersaturated. The fix is scoped, not open: read the ICC profile and pick a
  // different ingest matrix. `primaries.ts` derives its matrices from
  // chromaticities already, so P3 is a set of chromaticities and a second
  // `const mat3` selected by the compile-time variant mechanism the display pass
  // already uses. See docs/ARCHITECTURE.md §4.
  const full = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
    colorSpaceConversion: 'none',
  })

  const sourceWidth = full.width
  const sourceHeight = full.height
  const proxy = proxySize(sourceWidth, sourceHeight)

  if (proxy.width === sourceWidth && proxy.height === sourceHeight) {
    return { bitmap: full, sourceWidth, sourceHeight }
  }

  try {
    const resized = await createImageBitmap(full, {
      resizeWidth: proxy.width,
      resizeHeight: proxy.height,
      resizeQuality: 'high',
      imageOrientation: 'from-image',
      colorSpaceConversion: 'none',
    })
    return { bitmap: resized, sourceWidth, sourceHeight }
  } finally {
    // Released whether or not the resize succeeded; a retained full-resolution
    // bitmap is a quarter of a gigabyte per failed load.
    full.close()
  }
}

/**
 * The worker global, narrowed by hand.
 *
 * `tsconfig.json` includes the DOM lib for the application, so `self` is typed
 * as a `Window` here and its `postMessage` has the window signature, which takes
 * a target origin rather than a transfer list. Pulling in the webworker lib
 * instead would conflict with DOM across the rest of the program, so the scope is
 * declared locally: it names exactly the two members this file uses.
 */
interface DecodeWorkerScope {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null
  postMessage(message: DecodeResponse, transfer?: Transferable[]): void
}

const scope = self as unknown as DecodeWorkerScope

scope.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const { id, blob } = event.data
  void decode(blob).then(
    ({ bitmap, sourceWidth, sourceHeight }) => {
      const response: DecodeSuccess = { id, ok: true, bitmap, sourceWidth, sourceHeight }
      scope.postMessage(response, [bitmap])
    },
    (error: unknown) => {
      const response: DecodeFailure = {
        id,
        ok: false,
        message:
          error instanceof Error
            ? `Could not decode that image: ${error.message}`
            : 'Could not decode that image. It may be corrupt or in an unsupported format.',
      }
      scope.postMessage(response)
    },
  )
}
