/**
 * Where every pass is registered, and the one place registration order lives.
 *
 * Extracted from the renderer so that `tests/unit/graph-order.test.ts` can assert
 * the real list rather than a copy of it. A test that restates the array proves
 * only that someone typed the same thing twice — and the defect this exists to
 * catch was an **ordering defect between individually correct passes**, which no
 * agreement test can see because every pass in it is right.
 *
 * The order here is deliberately not the execution order. The graph sorts by
 * physical stage, so registration order decides only *within* a stage, and
 * shuffling the list here is what makes the ordering test assert the sort instead
 * of restating an already-sorted array.
 */

import type { Pass } from './types'

import { contrastPass } from './contrast'
import { displayPass } from './display'
import { exposurePass } from './exposure'
import { grainPass } from './grain'
import { HALATION_PASSES } from './halation'
import { hslPass } from './hsl'
import { imageSourcePass } from './imageSource'
import { ingestPass } from './ingest'
import { LENS_PASSES } from './lens'
import { splitTonePass } from './splitTone'
import { testPatternPass } from './testPattern'
import { wheelsPass } from './wheels'
import { whiteBalancePass } from './whiteBalance'

/**
 * The full pass list.
 *
 * The two curve passes are handed in rather than constructed here: they own baked
 * lookup tables and GL resources, and the renderer holds the same instances to
 * read their bake counts.
 */
export function registeredPasses(curvePass: Pass, filmCurvesPass: Pass): readonly Pass[] {
  return [
    // Registration order is not execution order; the graph sorts by stage.
    // Deliberately listed out of order here so that the ordering test is
    // asserting something rather than restating the array.
    displayPass,
    // The grade stage, in registration order: tonal shaping first, colour trim
    // after.
    //
    // Contrast used to run LAST, which put the two tonal controls on opposite
    // sides of the three colour controls. That is incoherent on its own, and it
    // had a measurable cost: contrast is a slope about grey in ACEScct and the
    // wheels add offsets in the same space, so a later contrast scaled every
    // wheel exactly in proportion — a lift set at 0.04 became 0.024 at contrast
    // 0.6 and 0.064 at 1.6. A colourist who set a lift and then raised contrast
    // found the lift stronger than they left it, which is precisely the fussy
    // interaction a grade stage should not have. It also moved middle grey away
    // from the pivot contrast was about to use.
    //
    // Shaping tone and then trimming colour is also the order people work in.
    curvePass,
    contrastPass,
    wheelsPass,
    hslPass,
    splitTonePass,
    // Halation before the curves, within the film stage. Registration order
    // decides inside a stage, and this one is physical: halation adds light to
    // the emulsion, so it happens before the curves turn exposure into
    // density. Listed here rather than left to chance.
    // The lens stage, in physical order: the glass bends the image, splits it by
    // wavelength, scatters it, and falls off toward the corners.
    ...LENS_PASSES,
    ...HALATION_PASSES,
    filmCurvesPass,
    // Grain last inside the film stage, and registration order is what decides
    // that: its magnitude depends on the developed density, which does not
    // exist until the curves have produced it.
    grainPass,
    testPatternPass,
    imageSourcePass,
    whiteBalancePass,
    exposurePass,
    ingestPass,
      ]
}
