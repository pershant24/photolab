/**
 * The presets that ship.
 *
 * Four, built from the grade controls and the film stocks together now that both
 * exist. Each is a starting point rather than a finished look: they touch the
 * grade and the film stage and deliberately leave exposure and white balance
 * alone, which is the whole argument for a sparse preset in `presets.ts`.
 *
 * Described rather than named after anything. Real stock names are trademarks,
 * and `filmStock.ts` already carries that reasoning for the curves these build on.
 *
 * The numbers come from the look sessions recorded in `tests/README.md`: the
 * teal-and-orange trim is the one measured there, and the warmth is kept below
 * what three stacking warm controls produced, since that combination was noted as
 * compounding without saying so.
 */

import { findFilmStock } from '../colour/filmStock'
import { filmStockPatch } from '../state/editState'
import type { EditState } from '../state/editState'
import type { Preset } from '../state/presets'

function stock(id: string): Partial<EditState> {
  const found = findFilmStock(id)
  if (!found) throw new RangeError(`no film stock "${id}"`)
  return filmStockPatch(found)
}

export const BUILT_IN_PRESETS: readonly Preset[] = [
  {
    id: 'builtin-soft-portrait',
    name: 'Soft portrait',
    builtIn: true,
    patch: {
      ...stock('warm-portrait'),
      filmStrength: 0.7,
      contrast: 0.94,
      // Cool the shadows a little and warm the top, but gently: the stock is
      // already warm in the highlights and the two add.
      lift: [-0.006, 0.001, 0.008],
      gain: [0.008, 0.002, -0.006],
      // Skin sits in the red and yellow bands. A little luminance and a little
      // less saturation reads as flattering rather than as a filter.
      hslSaturation: [-0.06, -0.04, 0, 0, 0, 0],
      hslLuminance: [0.04, 0.04, 0, 0, 0, 0],
      halationStrength: 0.35,
      halationThreshold: 2.05,
      halationRadius: 0.005,
      // grainSize is left at the default here deliberately, so it is not listed:
      // a preset entry equal to the default carries nothing and is dropped on the
      // way in, which would make the file disagree with what loading it produces.
      grainStrength: 0.35,
    },
  },
  {
    id: 'builtin-teal-and-orange',
    name: 'Teal shadows, warm skin',
    builtIn: true,
    patch: {
      ...stock('punchy-reversal'),
      filmStrength: 0.8,
      contrast: 1.18,
      lift: [-0.012, 0.002, 0.016],
      gain: [0.018, 0.004, -0.014],
      hslSaturation: [0.08, 0.12, 0, 0, -0.12, 0],
      halationStrength: 0.5,
      grainStrength: 0.3,
      grainSize: 0.0008,
    },
  },
  {
    id: 'builtin-faded-document',
    name: 'Faded document',
    builtIn: true,
    patch: {
      ...stock('muted-documentary'),
      contrast: 0.86,
      // Lifted, slightly green shadows and a paper-white top: the look of a print
      // that has been in a drawer.
      lift: [0.012, 0.016, 0.01],
      splitShadowTint: [-0.004, 0.006, -0.002],
      splitHighlightTint: [0.008, 0.006, 0.001],
      splitBalance: -0.5,
      hslSaturation: [-0.2, -0.2, -0.25, -0.2, -0.2, -0.2],
      grainStrength: 0.6,
      grainSize: 0.0012,
    },
  },
  {
    id: 'builtin-night-push',
    name: 'Pushed night',
    builtIn: true,
    patch: {
      ...stock('punchy-reversal'),
      filmStrength: 0.6,
      contrast: 1.3,
      // Built for a low-key frame, where lift owns most of the picture. The blue
      // is deliberately small for that reason: on a night photograph a lift acts
      // on more than half the frame by weight.
      lift: [-0.004, 0, 0.007],
      gamma: [0.004, 0, -0.003],
      splitShadowTint: [-0.006, -0.001, 0.01],
      splitBalance: -1.5,
      halationStrength: 0.7,
      halationThreshold: 1.95,
      halationRadius: 0.008,
      // Heavier and coarser, as a pushed film would be.
      grainStrength: 0.75,
      grainSize: 0.0013,
    },
  },
]
