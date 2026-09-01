import { expect, test } from '@playwright/test'

/**
 * The curve editor: placing, dragging and removing control points.
 *
 * The `EditState` parameter is an array, the first non-scalar in the system, so
 * these also check that snapshot undo still holds for it — an array is shared by
 * reference, and a control that mutated it in place would rewrite history rather
 * than adding to it.
 */

interface StoreLike {
  getState(): {
    edit: { toneCurve: number[] }
    past: readonly unknown[]
    interactionBaseline: unknown
    reset(): void
    undo(): void
  }
}

test.describe('curve editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabStore' in window)
    await page.evaluate(() => {
      ;(window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().reset()
    })
  })

  test('starts at the two-point identity', async ({ page }) => {
    await expect(page.getByTestId('curve-editor')).toBeVisible()
    const points = await page.evaluate(
      () =>
        (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().edit
          .toneCurve.length / 2,
    )
    expect(points).toBe(2)
  })

  test('adds a point where the pointer goes down, and drags it', async ({ page }) => {
    const editor = page.getByTestId('curve-editor')
    const box = await editor.boundingBox()
    expect(box).not.toBeNull()
    if (!box) return

    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * (0.4 - i * 0.02))
    }
    await page.mouse.up()

    const after = await page.evaluate(() => {
      const s = (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState()
      return { points: s.edit.toneCurve.length / 2, entries: s.past.length, baseline: s.interactionBaseline }
    })

    expect(after.points, 'a point was added').toBe(3)
    // The whole gesture is one undo entry, as for a slider drag.
    expect(after.entries).toBe(1)
    expect(after.baseline).toBeNull()
  })

  test('undo restores the curve as it was, not a mutated copy', async ({ page }) => {
    // An array parameter is shared by reference across history. A control that
    // mutated it in place would rewrite the past rather than adding to it, and
    // undo would return to a curve that had silently changed underneath it.
    const editor = page.getByTestId('curve-editor')
    const box = await editor.boundingBox()
    if (!box) return

    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3)
    await page.mouse.up()

    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().edit
            .toneCurve.length / 2,
      ),
    ).toBe(3)

    await page.getByTestId('undo').click()
    const restored = await page.evaluate(
      () =>
        (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().edit
          .toneCurve,
    )
    expect(restored.length / 2, 'back to the two-point identity').toBe(2)
  })

  test('removes an interior point on double click', async ({ page }) => {
    const editor = page.getByTestId('curve-editor')
    const box = await editor.boundingBox()
    if (!box) return

    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await page.mouse.down()
    await page.mouse.up()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().edit
            .toneCurve.length / 2,
      ),
    ).toBe(3)

    await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.5)
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().edit
            .toneCurve.length / 2,
      ),
    ).toBe(2)
  })
})
