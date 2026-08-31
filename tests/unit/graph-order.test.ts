import { describe, expect, it } from 'vitest'

import { RenderGraphError, orderPasses } from '../../src/render/graph'
import { STAGES } from '../../src/render/passes/types'
import type { Pass, Stage } from '../../src/render/passes/types'
import { displayPass } from '../../src/render/passes/display'
import { ingestPass } from '../../src/render/passes/ingest'
import { testPatternPass } from '../../src/render/passes/testPattern'

function fakePass(id: string, stage: Stage): Pass {
  return {
    id,
    stage,
    fragmentSource: () => `// ${id}`,
    variantKey: () => 'default',
    enabled: () => true,
    bindUniforms: () => undefined,
  }
}

describe('pass ordering', () => {
  it('lists the physical stages in the order the phenomena occur', () => {
    // The array is the execution order, so it is worth asserting directly. Light
    // leaves the scene, passes through a lens, lands on film, and only then is
    // graded and shown.
    expect([...STAGES]).toEqual(['ingest', 'scene', 'lens', 'film', 'grade', 'display'])
  })

  it('executes in stage order regardless of registration order', () => {
    // The failure this prevents is registering an effect late and having it run
    // late — a vignette after the grade darkens an already-graded image and
    // behaves like a post effect rather than an aperture.
    const registered = [
      fakePass('splitTone', 'grade'),
      fakePass('display', 'display'),
      fakePass('grain', 'film'),
      fakePass('ingest', 'ingest'),
      fakePass('vignette', 'lens'),
      fakePass('exposure', 'scene'),
    ]

    expect(orderPasses(registered).map((p) => p.id)).toEqual([
      'ingest',
      'exposure',
      'vignette',
      'grain',
      'splitTone',
      'display',
    ])
  })

  it('preserves registration order within a single stage', () => {
    // Within a stage the order is still meaningful — halation precedes the
    // characteristic curves, which precede grain — and the sort must not
    // reshuffle it.
    const registered = [
      fakePass('halation', 'film'),
      fakePass('curves', 'film'),
      fakePass('grain', 'film'),
    ]
    expect(orderPasses(registered).map((p) => p.id)).toEqual(['halation', 'curves', 'grain'])
  })

  it('is stable when the same set is ordered twice', () => {
    const registered = [
      fakePass('b', 'film'),
      fakePass('a', 'ingest'),
      fakePass('c', 'film'),
    ]
    expect(orderPasses(registered).map((p) => p.id)).toEqual(
      orderPasses(orderPasses(registered)).map((p) => p.id),
    )
  })

  it('rejects a pass declaring a stage that is not in the physical ordering', () => {
    const rogue = { ...fakePass('rogue', 'film'), stage: 'postprocess' as Stage }
    expect(() => orderPasses([rogue])).toThrow(RenderGraphError)
  })

  it('places the real passes correctly from a deliberately shuffled registration', () => {
    // The renderer registers these out of order on purpose, so that this asserts
    // the sort rather than restating an already-ordered array.
    expect(orderPasses([displayPass, testPatternPass, ingestPass]).map((p) => p.id)).toEqual([
      'testPattern',
      'ingest',
      'display',
    ])
  })

  it('has every stage available as an insertion point from the start', () => {
    // Adding an effect later must be registering against a stage that already
    // exists, not introducing a new position in the chain.
    for (const stage of STAGES) {
      expect(() => orderPasses([fakePass('probe', stage)])).not.toThrow()
    }
  })
})
