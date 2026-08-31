/**
 * Ingest: linearise and convert into the ACEScg working space.
 *
 * Registered in the `ingest` stage after the source. Nothing downstream may run
 * before this has, because nothing before it is in a known colour space.
 */

import fragmentSource from '../shaders/ingest.frag'

import type { Pass } from './types'

export const ingestPass: Pass = {
  id: 'ingest',
  stage: 'ingest',

  fragmentSource: () => fragmentSource,
  variantKey: () => 'default',

  // Never disabled. A pipeline that skipped ingest would be feeding encoded
  // values to passes that assume linear light, which produces a plausible image
  // computed entirely wrongly.
  enabled: () => true,

  bindUniforms() {
    // Nothing beyond the contract. The four contract uniforms are bound by the
    // graph for every pass whether or not it uses them, so there is nothing to
    // add here and nothing to forget when a spatial parameter is added later.
  },
}
