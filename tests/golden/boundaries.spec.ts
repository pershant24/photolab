import { expect, test } from '@playwright/test'

/**
 * Every discontinuity the pipeline contains, with a fixture that straddles it.
 *
 * # Why this exists
 *
 * The gamut compressor carried a **63 code value cliff** at the gamut boundary
 * for the length of a change, and every golden test passed throughout —
 * two-resolution and tile overlap included. The synthetic fixtures those tests
 * use are gradients and patches, and none of them put a pixel within 1e-3 of the
 * boundary. The defect was found by a census on a photograph and by an agreement
 * test between two precisions; no golden image was ever going to see it.
 *
 * That is the occupancy rule — "does this sample cover where the data actually
 * is?" — applied to a test's *fixture* rather than to a parameter's domain. The
 * same question had been asked of parameters three times and of a test's input
 * space once, and never of the fixtures themselves.
 *
 * # What is asserted, and why it is continuity rather than a stored image
 *
 * The failure mode is a **step**: correct behaviour either side of a boundary
 * and a jump across it. So this renders a dense ramp through each boundary and
 * asserts the output has no step in it. A stored reference image would catch the
 * same thing, but only after someone regenerated it, and it would fail for a
 * dozen unrelated reasons first — which is the reasoning `two-resolution.spec.ts`
 * already records for this directory.
 *
 * Adjacent-sample difference is the statistic. A smooth pass moves a 1024-sample
 * ramp across at most the full output range, so neighbouring samples differ by
 * about a quarter of a code value; 8-bit quantisation puts a floor of 1 under
 * that. A cliff is two orders larger. The bound is set well above the measured
 * smooth case and far below the cliff, and both numbers are recorded per case.
 *
 * # The enumeration
 *
 * Taken from the source rather than from memory, and it turned up more than the
 * obvious ones:
 *
 *   - the gamut gate at zero                    display.ts, isOutOfGamut
 *   - the tone map knee                         TONE_MAP_KNEE, 0.85 linear
 *   - the ACEScct break                         ACESCCT_X_BRK, 0.0078125 linear
 *   - the sRGB piecewise break                  SRGB_LINEAR_BREAK / _ENCODED_BREAK
 *   - halation's smoothstep window, both edges  halation.ts
 *   - the six HSL band edges                    HSL_BAND_SPACING, 60 degrees
 *   - the curve domain endpoints                TONE_CURVE_DOMAIN, FILM_DOMAIN
 *   - the colour wheels' four zone edges        ZONE_A_LOW/HIGH, ZONE_B_LOW/HIGH
 *   - the split tone balance window             SPLIT_TRANSITION_STOPS
 *   - the display clamp, at 0 and at 1
 *
 * Most are continuous by construction — a smoothstep, or a transfer function
 * whose two pieces meet. That is the point: this is what checks the claim rather
 * than restating it, and the one that was *not* continuous is the one that
 * shipped broken.
 */

/** Wide enough that a smooth ramp moves in fractions of a code value per step. */
const WIDTH = 1024
const HEIGHT = 8

/** Everything with a spatial kernel, off unless a case turns one on. */
const SPATIAL_OFF = {
  distortion: 0,
  aberration: 0,
  diffusionStrength: 0,
  vignette: 0,
  halationStrength: 0,
  grainStrength: 0,
}

type Fill = 'neutral-ramp' | 'shadow-ramp' | 'hue-sweep' | 'bright-spot-ramp' | 'saturation-ramp'

interface Case {
  readonly name: string
  /** Which boundaries this fixture is built to carry values across. */
  readonly straddles: string
  readonly fill: Fill
  readonly edit: Record<string, unknown>
  /**
   * Largest adjacent-sample difference allowed, in 8-bit code values.
   *
   * A grossness check, not a proof of continuity, and the difference is worth
   * being exact about. An 8-bit source is a fixed lattice of 1/255, so this
   * statistic cannot separate a discontinuity from a place where the pipeline
   * is merely **steep** — the HSL sweep reads 31 with a correct operator, and
   * that is the sRGB encode's slope near black reached smoothly over four
   * columns. Continuity is asserted in `tests/unit/boundaries.test.ts`, where
   * the input is a real number and epsilon can be 1e-9.
   *
   * What this catches is a step large enough to swamp the local slope. Both
   * figures are recorded beside each case: what the correct pipeline measures,
   * and what the shouldered operator measured when it was reintroduced.
   */
  readonly bound: number
}

const CASES: Case[] = [
  {
    name: 'the gamut gate at zero',
    straddles: 'isOutOfGamut, and the display clamp at 0',
    // A full-saturation hue sweep pushed further by HSL until channels go
    // negative. This is the exact population the cliff lived in: the sweep
    // crosses the gamut boundary many times, once per hue where a channel
    // changes sign.
    // A saturation ramp, not a hue sweep, and the difference is the whole point.
    //
    // The cliff the shoulder produces is 0.05 of the *achromatic* value, and it
    // only appears on pixels sitting within a hair of the boundary. A hue sweep
    // crosses the boundary at a handful of columns and at whatever brightness
    // those hues happen to have: measured, it read 7 with the correct operator
    // and **3 with the broken one**, so it was not merely insensitive, it
    // pointed the wrong way.
    //
    // This ramps white to a saturated primary at high value, so the minimum
    // channel sweeps smoothly through zero, densely, with the achromatic value
    // held high — the configuration the census's worst pixel was in (achromatic
    // 2.75, min -6.1e-5, 104 code values wrong).
    fill: 'saturation-ramp',
    edit: { hslSaturation: [0.6, 0.6, 0.6, 0.6, 0.6, 0.6], exposure: 1.2 },
    bound: 40, // measured: 18 correct, 107 with the shouldered operator
  },
  {
    name: 'the tone map knee and the sRGB encode break',
    straddles: 'TONE_MAP_KNEE at 0.85 linear, SRGB_LINEAR_BREAK at 0.0031308',
    // A neutral ramp from black to white, lifted two stops so the top half sits
    // above the knee and the bottom still resolves the encode break.
    fill: 'neutral-ramp',
    edit: { exposure: 2 },
    bound: 8, // measured: 4
  },
  {
    name: 'the ACEScct break and the film curve domain endpoints',
    straddles: 'ACESCCT_X_BRK at 0.0078125 linear, FILM_DOMAIN at both ends',
    // A shadow ramp, where ACEScct's log/linear splice falls, through the film
    // characteristic curves — which are sampled from a LUT baked over
    // FILM_DOMAIN and clamped outside it.
    fill: 'shadow-ramp',
    edit: { filmStrength: 1, contrast: 1.3 },
    bound: 8, // measured: 3
  },
  {
    name: 'the six HSL band edges',
    straddles: 'HSL_BAND_SPACING, every 60 degrees of hue',
    // Alternating adjustments per band, so each edge has the largest possible
    // disagreement across it. If the raised-cosine weights did not reach zero at
    // the edge this is where it would show.
    fill: 'hue-sweep',
    edit: {
      hslHue: [1, -1, 1, -1, 1, -1],
      hslSaturation: [0.6, -0.6, 0.6, -0.6, 0.6, -0.6],
      hslLuminance: [0.3, -0.3, 0.3, -0.3, 0.3, -0.3],
    },
    bound: 45, // measured: 31 correct, 64 with the shouldered operator
  },
  {
    name: 'the colour wheel zone edges and the split tone window',
    straddles: 'ZONE_A_LOW/HIGH, ZONE_B_LOW/HIGH, SPLIT_TRANSITION_STOPS',
    // A full neutral ramp spans the stops range the zones are defined over.
    // Opposing wheels and tints make any weight discontinuity visible as a step
    // in the ramp rather than cancelling out.
    fill: 'neutral-ramp',
    edit: {
      lift: [0.03, -0.02, 0.03],
      gamma: [-0.02, 0.03, -0.02],
      gain: [0.03, -0.02, -0.03],
      splitShadowTint: [-0.02, 0.01, 0.03],
      splitHighlightTint: [0.03, 0.01, -0.02],
      splitBalance: -0.5,
    },
    bound: 8, // measured: 3
  },
  {
    name: 'the tone curve domain endpoints',
    straddles: 'TONE_CURVE_DOMAIN at both ends, and the LUT clamp outside it',
    fill: 'neutral-ramp',
    edit: {
      toneCurve: [-0.3584474885844749, -0.3584474885844749, 0.25, 0.42, 0.75, 0.6, 1, 1],
      exposure: 1,
    },
    bound: 8, // measured: 4
  },
  {
    name: "halation's smoothstep window, both edges",
    straddles: 'the halation threshold window',
    // The one case that leaves a spatial pass on. A blurred ramp is still a
    // ramp, so the statistic survives; what it is looking for is the threshold
    // window's edges producing a step in how much light is added.
    fill: 'bright-spot-ramp',
    edit: {
      ...SPATIAL_OFF,
      halationStrength: 0.9,
      halationThreshold: 1.2,
      halationRadius: 0.01,
    },
    bound: 10, // measured: 7
  },
]

test.describe('every boundary in the pipeline has a fixture across it', () => {
  for (const testCase of CASES) {
    test(`${testCase.name} is crossed without a step`, async ({ page }) => {
      test.setTimeout(120_000)

      await page.goto('/')
      await page.waitForFunction(
        () => '__photolabRenderer' in window && '__photolabExport' in window,
      )

      const result = await page.evaluate(
        async ({ width, height, fill, edit, spatialOff }) => {
          const w = window as unknown as {
            __photolabRenderer: {
              stop(): void
              input: { edit: Record<string, unknown>; view: Record<string, unknown> }
            }
            __photolabExport: { run(job: Record<string, unknown>): Promise<{ blob: Blob }> }
          }
          w.__photolabRenderer.stop()

          const hueToRgb = (h: number, v: number): [number, number, number] => {
            const hp = (h % 360) / 60
            const x = v * (1 - Math.abs((hp % 2) - 1))
            if (hp < 1) return [v, x, 0]
            if (hp < 2) return [x, v, 0]
            if (hp < 3) return [0, v, x]
            if (hp < 4) return [0, x, v]
            if (hp < 5) return [x, 0, v]
            return [v, 0, x]
          }
          const make = (x: number): [number, number, number] => {
            const t = x / (width - 1)
            if (fill === 'neutral-ramp') return [t * 255, t * 255, t * 255]
            // The bottom eighth of the range, where the ACEScct splice lives.
            if (fill === 'shadow-ramp') return [t * 32, t * 32, t * 32]
            if (fill === 'hue-sweep') {
              const [r, g, b] = hueToRgb(t * 360, 235)
              return [r + 20, g + 20, b + 20]
            }
            // White to a saturated primary at high value: the minimum channel
            // sweeps smoothly through zero with the achromatic value held high.
            if (fill === 'saturation-ramp') {
              // Neutral at one end, a primary at the other. Both ends matter:
              // starting at a colour that is *already* saturated puts the whole
              // ramp outside the gamut and there is no crossing to observe,
              // which is what the first two attempts at this fixture did.
              const lo = 250 * (1 - t)
              return [250, lo, lo]
            }
            // Climbs through the halation threshold and back down, so both edges
            // of the smoothstep window are crossed.
            const v = 255 * Math.exp(-((t - 0.5) * (t - 0.5)) / 0.02)
            return [v, v * 0.9, v * 0.8]
          }

          const canvas = new OffscreenCanvas(width, height)
          const ctx = canvas.getContext('2d')!
          const image = ctx.createImageData(width, height)
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const [r, g, b] = make(x)
              const i = (y * width + x) * 4
              image.data[i] = Math.max(0, Math.min(255, Math.round(r)))
              image.data[i + 1] = Math.max(0, Math.min(255, Math.round(g)))
              image.data[i + 2] = Math.max(0, Math.min(255, Math.round(b)))
              image.data[i + 3] = 255
            }
          }
          ctx.putImageData(image, 0, 0)
          const blob = await canvas.convertToBlob({ type: 'image/png' })

          const out = await w.__photolabExport.run({
            blob,
            edit: { ...w.__photolabRenderer.input.edit, ...spatialOff, ...edit },
            view: { ...w.__photolabRenderer.input.view, inspect: false },
            sourceWidth: width,
            sourceHeight: height,
            format: 'image/png',
          })

          const bitmap = await createImageBitmap(out.blob)
          const read = new OffscreenCanvas(width, height)
          const rctx = read.getContext('2d')!
          rctx.drawImage(bitmap, 0, 0)
          const data = rctx.getImageData(0, Math.floor(height / 2), width, 1).data

          // Adjacent-sample difference along the ramp, per channel.
          let worst = 0
          let worstAt = 0
          const deltas: number[] = []
          for (let x = 1; x < width; x++) {
            for (let c = 0; c < 3; c++) {
              const d = Math.abs(data[x * 4 + c]! - data[(x - 1) * 4 + c]!)
              deltas.push(d)
              if (d > worst) {
                worst = d
                worstAt = x
              }
            }
          }
          deltas.sort((a, b) => a - b)
          return {
            worst,
            worstAt,
            p99: deltas[Math.floor(deltas.length * 0.99)] ?? 0,
            median: deltas[Math.floor(deltas.length * 0.5)] ?? 0,
          }
        },
        {
          width: WIDTH,
          height: HEIGHT,
          fill: testCase.fill,
          edit: testCase.edit,
          spatialOff: SPATIAL_OFF,
        },
      )

      process.stdout.write(
        `\n  ${testCase.name}\n    straddles: ${testCase.straddles}\n` +
          `    adjacent delta — median ${result.median}, p99 ${result.p99}, ` +
          `worst ${result.worst} at column ${result.worstAt} (bound ${testCase.bound})\n`,
      )

      expect(
        result.worst,
        `a step at ${testCase.straddles} — column ${result.worstAt}`,
      ).toBeLessThanOrEqual(testCase.bound)
    })
  }
})
