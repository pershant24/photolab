import { expect, test } from '@playwright/test'

/**
 * Presets through the running application.
 *
 * The unit tests cover the patch arithmetic. These cover the two properties that
 * only exist once the store, the history and the panel are wired together:
 * applying a preset is **one** undo step, and it persists across a reload.
 */

const TESTID = (id: string) => `[data-testid="${id}"]`

test.describe('presets', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
    await page.evaluate(() => {
      const w = window as unknown as { indexedDB: IDBFactory }
      w.indexedDB.deleteDatabase('photolab')
    })
    await page.reload()
    await page.waitForFunction(() => '__photolabRenderer' in window)
  })

  test('applying a preset is a single undo step, however much it changes', async ({ page }) => {
    // The requirement, and the reason it holds is that `applyPatch` commits once
    // rather than that the panel does anything clever. Undoing a preset must not
    // take twenty presses.
    const result = await page.evaluate(() => {
      const store = (window as unknown as {
        __photolabStore: {
          getState(): {
            edit: Record<string, unknown>
            past: readonly unknown[]
            applyPatch(p: Record<string, unknown>): void
            undo(): void
            reset(): void
          }
        }
      }).__photolabStore
      store.getState().reset()
      const before = { ...store.getState().edit }
      const depthBefore = store.getState().past.length

      const preset = {
        contrast: 1.25,
        lift: [-0.01, 0, 0.012],
        gain: [0.014, 0.002, -0.01],
        hslSaturation: [0.1, 0, 0, 0, -0.1, 0],
        splitShadowTint: [-0.006, 0, 0.008],
        grainStrength: 0.4,
        halationStrength: 0.5,
      }
      store.getState().applyPatch(preset)
      const changed = Object.keys(preset).filter(
        (key) => JSON.stringify(store.getState().edit[key]) !== JSON.stringify(before[key]),
      ).length
      const depthAfter = store.getState().past.length

      store.getState().undo()
      const restored = Object.keys(before).every(
        (key) => JSON.stringify(store.getState().edit[key]) === JSON.stringify(before[key]),
      )
      return { changed, entries: depthAfter - depthBefore, restored }
    })

    // It really did change a lot of parameters...
    expect(result.changed).toBeGreaterThan(5)
    // ...and it cost exactly one history entry...
    expect(result.entries).toBe(1)
    // ...which one undo returns from, completely.
    expect(result.restored).toBe(true)
  })

  test('a saved preset survives a reload', async ({ page }) => {
    await page.evaluate(() => {
      const store = (window as unknown as {
        __photolabStore: { getState(): { applyPatch(p: Record<string, unknown>): void } }
      }).__photolabStore
      store.getState().applyPatch({ contrast: 1.4, grainStrength: 0.6 })
    })
    await page.fill(TESTID('preset-name'), 'A saved look')
    await page.click(TESTID('preset-save'))
    await expect(page.locator(TESTID('presets'))).toContainText('A saved look')

    await page.reload()
    await page.waitForFunction(() => '__photolabRenderer' in window)
    await expect(page.locator(TESTID('presets'))).toContainText('A saved look', { timeout: 10_000 })
  })

  test('the shipped presets are all listed and all apply', async ({ page }) => {
    // Every applicable thing in the panel: the four bundles and every preset on
    // each of the three axes. The selector is deliberately one pattern rather
    // than one per group, so a group that stops rendering is a failure here
    // instead of a silently shorter list.
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="apply-"]')].map(
        (node) => node.getAttribute('data-testid') ?? '',
      ),
    )
    // Four bundles, four cameras, three stocks, six grades.
    expect(ids.length, `found: ${ids.join(', ')}`).toBeGreaterThanOrEqual(17)
    for (const axis of ['camera', 'stock', 'grade']) {
      await expect(page.locator(`[data-testid="${axis}-list"] li`).first()).toBeVisible()
    }

    for (const id of ids) {
      // The depth BEFORE, not the absolute depth: `reset()` is itself a commit,
      // so the history grows across the loop and an absolute count would pass on
      // the first preset and fail on every one after it.
      const { before, baseline } = await page.evaluate(() => {
        const store = (window as unknown as {
          __photolabStore: {
            getState(): { reset(): void; past: readonly unknown[]; edit: Record<string, unknown> }
          }
        }).__photolabStore
        store.getState().reset()
        return {
          before: store.getState().past.length,
          baseline: JSON.stringify(store.getState().edit),
        }
      })
      await page.click(`[data-testid="${id}"]`)
      const changed = await page.evaluate(() => {
        const store = (window as unknown as {
          __photolabStore: { getState(): { edit: Record<string, unknown>; past: readonly unknown[] } }
        }).__photolabStore
        return {
          entries: store.getState().past.length,
          // The whole state, not one parameter. This used to read `contrast`,
          // which every compound preset happened to set. On three axes that is
          // no longer true and must not be: contrast belongs to the grade, and a
          // camera preset touching it would break the disjointness the axes
          // exist for. So the check is that the state moved, which is what the
          // assertion always meant.
          edit: JSON.stringify(store.getState().edit),
        }
      })
      // One entry, and it did something.
      expect(changed.entries - before, `${id} history`).toBe(1)
      expect(changed.edit, `${id} changed nothing`).not.toBe(baseline)
    }
  })

  test('a saved preset can be deleted', async ({ page }) => {
    await page.evaluate(() => {
      const store = (window as unknown as {
        __photolabStore: { getState(): { applyPatch(p: Record<string, unknown>): void } }
      }).__photolabStore
      store.getState().applyPatch({ contrast: 1.4 })
    })
    await page.fill(TESTID('preset-name'), 'Temporary')
    await page.click(TESTID('preset-save'))
    await expect(page.locator(TESTID('presets'))).toContainText('Temporary')
    await page.click('[aria-label="Delete Temporary"]')
    await expect(page.locator(TESTID('presets'))).not.toContainText('Temporary')
  })

  test('refuses to save nothing', async ({ page }) => {
    // The default state carries no patch, so saving it would produce a preset
    // that does nothing and looks like it works.
    await page.fill(TESTID('preset-name'), 'Empty')
    await page.click(TESTID('preset-save'))
    await expect(page.locator(TESTID('preset-message'))).toContainText('Nothing to save')
  })
})
