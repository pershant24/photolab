/**
 * The date stamp: a small LED array inside the camera back, exposing the film.
 *
 * # It is light, so it is drawn before the emulsion responds
 *
 * A date back is not a caption. It is a row of seven-segment LEDs a few
 * millimetres from the emulsion, firing while the shutter is open, and the
 * frame records it the same way it records everything else in front of it. So
 * the pass injects into the **film stage, before halation and before the
 * characteristic curves**, and gets two things for free that a composite at the
 * end would have to fake:
 *
 * - **halation**, because a small very bright source is precisely what scatters
 *   off the film base. The orange bleed around a date stamp is not a stylistic
 *   choice, it is the same phenomenon as the bloom around a street light, and it
 *   is most of what makes a real one recognisable;
 * - **the characteristic curves**, which compress it exactly as they compress
 *   any other highlight, so it sits in the stock's own shoulder rather than on
 *   top of it.
 *
 * `tests/golden/date-stamp.spec.ts` asserts the first of those rather than
 * assuming it, because a later refactor moving the injection point is the one
 * failure this whole design is exposed to, and it would be invisible otherwise.
 *
 * # Why there is no glyph asset
 *
 * The obvious implementation is a texture atlas, and it was rejected. A
 * seven-segment digit is seven axis-aligned boxes, so its signed distance field
 * is analytic and a handful of `min` calls evaluate it exactly at any scale —
 * there is nothing an atlas would add except a resolution of its own to be
 * softened by.
 *
 * The decisive argument is elsewhere, though, and it is worth stating because it
 * is the one that generalises. `CLAUDE.md` §2 says the renderer is
 * `render(sourceImage, EditState) -> pixels`. The curve pass's baked lookup
 * table is not a counterexample: it is a pure function of `EditState.toneCurve`,
 * computed on demand. **An external asset would be a third argument** to a
 * function the project insists has two — and since export runs in a worker with
 * its own GL context (`src/render/export.worker.ts`), it would need a second
 * load-and-upload path that had to agree with the main thread's. A preview and
 * export that disagree is the one deviation this project already carries an
 * apology for. Adding a second was not worth a row of digits.
 *
 * # Where the layout lives, and why it is not in the shader
 *
 * Everything positional is computed here and handed over as uniforms: the six
 * digit origins, the tick's origin, the total width. The shader knows how to
 * draw a digit and nothing about how they are arranged.
 *
 * That is step 5 of the add-a-pass recipe taken seriously. The arrangement is
 * the part with arithmetic in it, so it is the part that is unit tested, and
 * having exactly one implementation of it means there is no second copy to
 * drift. The constants the shader genuinely does need — the segment boxes, the
 * digit width, the slant — are mirrored in `lib/dateStamp.glsl` and
 * `tests/unit/date-stamp.test.ts` parses that file and compares them, because a
 * mirrored constant with nothing checking it is a divergence waiting for
 * someone to make it.
 */

/**
 * Which segments each digit lights, as a bit mask.
 *
 *       --a--
 *      |     |
 *      f     b
 *      |     |
 *       --g--
 *      |     |
 *      e     c
 *      |     |
 *       --d--
 *
 * Bit 0 is `a` and bit 6 is `g`, in that order, which is the order
 * {@link SEGMENT_BOXES} is written in.
 */
export const DIGIT_SEGMENTS: readonly number[] = [
  0b0111111, // 0: a b c d e f
  0b0000110, // 1: b c
  0b1011011, // 2: a b g e d
  0b1001111, // 3: a b g c d
  0b1100110, // 4: f g b c
  0b1101101, // 5: a f g c d
  0b1111101, // 6: a f g e c d
  0b0000111, // 7: a b c
  0b1111111, // 8: every segment
  0b1101111, // 9: a b c d f g
]

export const SEGMENT_COUNT = 7

/**
 * Glyph metrics, in units of the **cap height**, with the origin at the bottom
 * left of the digit cell and y increasing upward.
 *
 * Working in cap heights rather than in frame units is what makes the stamp one
 * shape rather than a shape per image: the shader scales the whole local
 * coordinate system by {@link DATE_STAMP_HEIGHT} once, and nothing below has to
 * know what size the frame is.
 */
export const DIGIT_WIDTH = 0.6
export const SEGMENT_THICKNESS = 0.15

/**
 * How much each segment is shrunk on every side.
 *
 * Without it the segments meet at the corners and the digit reads as a solid
 * outline. The gaps are the single most recognisable thing about a
 * seven-segment display, and they come from the physical gap between the LED
 * bars rather than from anything about the drawing.
 */
export const SEGMENT_PAD = 0.024

/**
 * The italic shear, applied to the whole run rather than per glyph.
 *
 * Date backs slant. Applying it to the run and not to each cell is the
 * difference between an italic and six leaning digits, and costs one subtraction
 * either way.
 */
export const DATE_STAMP_SLANT = 0.09

/** Space between adjacent digits, and the extra between year, month and day. */
export const DIGIT_TRACKING = 0.14
export const GROUP_GAP = 0.26

/** The leading apostrophe, which is what makes `26` read as a year. */
export const TICK_CENTRE: readonly [number, number] = [0.06, 0.88]
export const TICK_HALF: readonly [number, number] = [0.05, 0.1]
export const TICK_ADVANCE = 0.24

/**
 * Cap height as a fraction of the frame's **long edge**.
 *
 * The long edge and not the height, because a date back prints a fixed physical
 * size onto a 35mm negative and the long edge is the dimension that is always
 * 36mm. Sizing against the height instead would make the stamp grow when a
 * portrait frame is loaded, which no camera does.
 *
 * This is also the whole of the pass's resolution independence: one fraction of
 * one source dimension, and the shader multiplies by it. There is no pixel
 * anywhere in the geometry.
 */
export const DATE_STAMP_HEIGHT = 0.028

/** `[centreX, centreY, halfWidth, halfHeight]` per segment, in cap heights. */
export const SEGMENT_BOXES: readonly (readonly [number, number, number, number])[] = (() => {
  const t = SEGMENT_THICKNESS
  const w = DIGIT_WIDTH
  const p = SEGMENT_PAD
  /** Horizontal bars inset by half a thickness at each end, so the corners clear. */
  const hx = (w - t) / 2 - p
  const hy = t / 2 - p
  const vx = t / 2 - p
  /*
   * A vertical runs from the FAR EDGE of one horizontal bar to the far edge of
   * the next, not from centre to centre — which is what it was first written as,
   * and the corner-gap assertion in `tests/unit/date-stamp.test.ts` is what
   * caught it. Centre to centre makes the upper vertical reach halfway into the
   * top bar, so `a` and `f` fuse into a solid L and the digit reads as an
   * outline rather than as segments. Nothing about the numbers looked wrong.
   *
   * So the upper vertical spans `0.5 + t/2` up to `1 - t`: half-height
   * `(0.5 - 1.5t) / 2`, centred a quarter of a thickness below the midpoint.
   */
  const vy = (0.5 - 1.5 * t) / 2 - p
  const upper = 0.75 - t / 4
  const lower = 0.25 + t / 4
  return [
    [w / 2, 1 - t / 2, hx, hy], // a, top
    [w - t / 2, upper, vx, vy], // b, upper right
    [w - t / 2, lower, vx, vy], // c, lower right
    [w / 2, t / 2, hx, hy], // d, bottom
    [t / 2, lower, vx, vy], // e, lower left
    [t / 2, upper, vx, vy], // f, upper left
    [w / 2, 0.5, hx, hy], // g, middle
  ]
})()

/** Digits are grouped year, month, day — two each. */
export const DATE_DIGIT_COUNT = 6

/**
 * The six digits, most significant first, as `'YY MM DD`.
 *
 * Two-digit year because that is what the hardware showed. The modulo is written
 * to survive a negative year rather than to be defended against one: the
 * parameter range makes it unreachable, and a silent `-6` rendering as a blank
 * cell would be a worse way to find that out than a wrong-but-present digit.
 */
export function dateDigits(year: number, month: number, day: number): number[] {
  const twoDigit = (value: number): number[] => {
    const v = ((Math.trunc(value) % 100) + 100) % 100
    return [Math.floor(v / 10), v % 10]
  }
  return [...twoDigit(year), ...twoDigit(month), ...twoDigit(day)]
}

/**
 * Where the tick's cell starts.
 *
 * Zero, because the run begins with it — written down rather than left implicit
 * so that the layout has exactly one place that says where anything is. The
 * shader reads it as a uniform like every other origin and holds no opinion.
 */
export const TICK_ORIGIN = 0

/**
 * Where each digit cell starts, in cap heights from the left end of the run.
 *
 * The only arithmetic in the layout, and the reason it is here rather than in
 * GLSL: it is testable here, and there is one of it.
 */
export function digitOrigins(): number[] {
  const advance = DIGIT_WIDTH + DIGIT_TRACKING
  const origins: number[] = []
  let x = TICK_ADVANCE
  for (let i = 0; i < DATE_DIGIT_COUNT; i++) {
    origins.push(x)
    x += advance
    // After the second and fourth digit, the gap that separates the groups.
    if (i === 1 || i === 3) x += GROUP_GAP
  }
  return origins
}

/** Total advance of the run, in cap heights. The stamp is right-anchored to it. */
export function stampWidth(): number {
  const origins = digitOrigins()
  return origins[origins.length - 1]! + DIGIT_WIDTH
}

/**
 * Thinnest drawn feature, in cap heights: the short side of a segment.
 *
 * Quoted by the resolution-floor measurement, which is the same question grain
 * and halation both answer — below some buffer size the preview cannot represent
 * the feature and stops being a preview of it.
 */
export const THINNEST_FEATURE = SEGMENT_THICKNESS - 2 * SEGMENT_PAD

/**
 * The buffer long edge, in pixels, at which the thinnest feature is `pixels`
 * buffer pixels across.
 *
 * Stated as a function rather than as a single number because "the floor"
 * depends on what is being asked of it: two pixels to be a visible bar, rather
 * more to be legible as a digit.
 */
export function bufferEdgeForFeature(pixels: number): number {
  return pixels / (THINNEST_FEATURE * DATE_STAMP_HEIGHT)
}
