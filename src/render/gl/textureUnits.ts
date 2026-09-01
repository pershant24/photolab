/**
 * Texture unit assignments, in one place.
 *
 * ## Why a reserved scratch unit exists
 *
 * Creating or uploading a texture requires binding it, and `gl.bindTexture`
 * binds to **whichever unit happens to be active**. That is a global side
 * effect, and it caused a real bug: the curve pass baked its lookup table while
 * unit 0 was active, so the bind — and the unbind that followed it — wiped the
 * `uSource` binding the graph had just made, and the pass sampled a black
 * source. The symptom was a constant output, and the constant turned out to be
 * the curve evaluated at zero rather than anything wrong with the table itself.
 *
 * It was found by instrumenting the shader, not by a test, which is the worse
 * way to find things. The fix is structural rather than a save-and-restore
 * around each call site: **all creation and upload happens on a unit reserved
 * for it and never sampled**, so no caller has to remember, and the film stage's
 * three lookup tables per stock cannot reintroduce it.
 */

/** The output of the previous pass, bound by the graph for every pass. */
export const SOURCE_UNIT = 0

/** The decoded source image, bound by the image source pass. */
export const IMAGE_UNIT = 1

/**
 * Curve lookup tables. Three, because the film stage runs one per channel; the
 * grade's single tone curve uses the first.
 */
export const CURVE_LUT_UNITS = [2, 3, 4] as const

/**
 * Reserved for creation and upload. **Never sampled by any shader**, so a stray
 * binding left here cannot affect an image.
 */
export const SCRATCH_UNIT = 7

/**
 * Run `build` with the scratch unit active, then restore the source unit.
 *
 * Restoring to {@link SOURCE_UNIT} rather than to whatever was active before is
 * deliberate: that is the unit every other binding site assumes is current, so
 * leaving it selected is the invariant the rest of the renderer is written
 * against.
 */
export function onScratchUnit<T>(gl: WebGL2RenderingContext, build: () => T): T {
  gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT)
  try {
    return build()
  } finally {
    gl.activeTexture(gl.TEXTURE0 + SOURCE_UNIT)
  }
}
