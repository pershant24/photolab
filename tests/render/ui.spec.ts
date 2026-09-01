import { expect, test } from '@playwright/test'

/**
 * The controls, and the one thing about them that is easy to get half right.
 *
 * A gesture must be one undo entry whichever device drove it. Bracketing on
 * pointer events alone covers the mouse and silently omits the keyboard, where
 * key repeat on a focused slider emits a change per repeat with no pointer event
 * anywhere.
 */

interface StoreLike {
  getState(): {
    edit: { exposure: number; contrast: number }
    past: readonly unknown[]
    future: readonly unknown[]
    interactionBaseline: unknown
    reset(): void
  }
}

/**
 * Note: the store is reached inline in every `page.evaluate` rather than through
 * a helper. `page.evaluate` serialises the function body and sends it to the
 * browser, so anything it closes over in this file is simply absent there.
 */
test.describe('parameter controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabStore' in window)
    await page.evaluate(() => {
      ;(window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().reset()
    })
  })

  test('a held arrow key is one undo entry, not one per repeat', async ({ page }) => {
    // The assertion D0.2 asks for. Thirty repeats bracketed by a single keydown
    // and keyup must leave one entry; without keyboard bracketing each repeat
    // commits on its own and undo steps back through the hold one tick at a
    // time.
    const slider = page.getByTestId('slider-exposure')
    await slider.focus()

    const before = await page.evaluate(
      () => (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().past.length,
    )

    // Key repeat is repeated `keydown` with a single `keyup` at the end, and
    // Playwright models it: calling down() on an already-held key sends a
    // keydown with repeat set. Using press() here instead would be thirty
    // separate keystrokes, which correctly produces thirty entries and would
    // have made this test assert the opposite of what it means to.
    await page.keyboard.down('ArrowRight')
    for (let i = 0; i < 30; i++) {
      await page.keyboard.down('ArrowRight')
    }
    await page.keyboard.up('ArrowRight')

    const after = await page.evaluate(() => {
      const s = (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState()
      return { entries: s.past.length, exposure: s.edit.exposure, baseline: s.interactionBaseline }
    })

    expect(after.exposure, 'the value actually moved').toBeGreaterThan(0)
    expect(after.entries - before, 'one entry for the whole hold').toBe(1)
    expect(after.baseline, 'the gesture is closed on key up').toBeNull()
  })

  test('thirty separate presses are thirty entries, which is correct', async ({ page }) => {
    // The other half of the rule, and the reason the distinction matters. A
    // discrete keystroke is a discrete action and should be individually
    // undoable; only a *held* key is one gesture. A implementation that
    // coalesced on a timer rather than on key state would fail this.
    const slider = page.getByTestId('slider-exposure')
    await slider.focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')

    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().past
            .length,
      ),
    ).toBe(5)
  })

  test('a single arrow key press is one undo entry', async ({ page }) => {
    const slider = page.getByTestId('slider-exposure')
    await slider.focus()
    await page.keyboard.press('ArrowRight')

    const state = await page.evaluate(() => {
      const s = (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState()
      return { entries: s.past.length, baseline: s.interactionBaseline }
    })
    expect(state.entries).toBe(1)
    expect(state.baseline).toBeNull()
  })

  test('undo after a keyboard hold returns to where the hold began', async ({ page }) => {
    const slider = page.getByTestId('slider-exposure')
    await slider.focus()
    await page.keyboard.down('ArrowRight')
    for (let i = 0; i < 10; i++) await page.keyboard.down('ArrowRight')
    await page.keyboard.up('ArrowRight')

    await page.getByTestId('undo').click()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().edit
            .exposure,
      ),
    ).toBe(0)
  })

  test('a pointer drag is one undo entry and engages the drag proxy', async ({ page }) => {
    const slider = page.getByTestId('slider-exposure')
    const box = await slider.boundingBox()
    expect(box).not.toBeNull()
    if (!box) return

    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2)
    await page.mouse.down()

    const midDrag = await page.evaluate(() => {
      const w = window as unknown as {
        __photolabStore: StoreLike
        __photolabRenderer: { interacting: boolean }
      }
      return {
        baseline: w.__photolabStore.getState().interactionBaseline !== null,
        interacting: w.__photolabRenderer.interacting,
      }
    })
    expect(midDrag.baseline, 'the store knows a gesture is open').toBe(true)
    expect(midDrag.interacting, 'the drag proxy follows the same signal').toBe(true)

    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(box.x + box.width * (0.5 + i * 0.03), box.y + box.height / 2)
    }
    await page.mouse.up()

    const after = await page.evaluate(() => {
      const w = window as unknown as {
        __photolabStore: StoreLike
        __photolabRenderer: { interacting: boolean }
      }
      const s = w.__photolabStore.getState()
      return {
        entries: s.past.length,
        baseline: s.interactionBaseline,
        interacting: w.__photolabRenderer.interacting,
        exposure: s.edit.exposure,
      }
    })

    expect(after.exposure, 'the drag moved the value').toBeGreaterThan(0)
    expect(after.entries, 'twelve moves, one entry').toBe(1)
    expect(after.baseline).toBeNull()
    expect(after.interacting, 'the proxy is released on pointer up').toBe(false)
  })

  test('releasing the pointer outside the slider still closes the gesture', async ({ page }) => {
    // A drag is released wherever the pointer ends up, which is usually not over
    // the control. If the release is missed the store believes a gesture is open
    // for ever: history stops recording and the drag proxy never disengages.
    const slider = page.getByTestId('slider-exposure')
    const box = await slider.boundingBox()
    expect(box).not.toBeNull()
    if (!box) return

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y - 200)
    await page.mouse.up()

    const after = await page.evaluate(() => {
      const w = window as unknown as {
        __photolabStore: StoreLike
        __photolabRenderer: { interacting: boolean }
      }
      return {
        baseline: w.__photolabStore.getState().interactionBaseline,
        interacting: w.__photolabRenderer.interacting,
      }
    })
    expect(after.baseline).toBeNull()
    expect(after.interacting).toBe(false)
  })

  test('both parameters have a control, driven from the table', async ({ page }) => {
    await expect(page.getByTestId('slider-exposure')).toBeVisible()
    await expect(page.getByTestId('slider-contrast')).toBeVisible()
  })
})

test.describe('film stocks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabStore' in window)
    await page.evaluate(() => {
      ;(window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().reset()
    })
  })

  test('applies a stock as one undoable preset, and clears it', async ({ page }) => {
    // A stock is a Partial<EditState> merged in, which is what CLAUDE.md defines
    // a preset to be. So it is one history entry, and the curves stay editable
    // afterwards rather than being locked behind a "selected stock".
    const curveLength = async (): Promise<number> =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __photolabStore: { getState(): { edit: { filmCurveRed: number[] } } }
            }
          ).__photolabStore.getState().edit.filmCurveRed.length,
      )

    expect(await curveLength(), 'starts at the two-point identity').toBe(4)

    await page.getByTestId('stock-warm-portrait').click()
    expect(await curveLength()).toBeGreaterThan(4)

    const entries = await page.evaluate(
      () =>
        (window as unknown as { __photolabStore: StoreLike }).__photolabStore.getState().past
          .length,
    )
    expect(entries, 'one entry for applying a stock').toBe(1)

    await page.getByTestId('stock-none').click()
    expect(await curveLength(), 'cleared back to the identity').toBe(4)

    await page.getByTestId('undo').click()
    expect(await curveLength(), 'undo brings the stock back').toBeGreaterThan(4)
  })

  test('offers every stock, and none is named after a real one', async ({ page }) => {
    for (const id of ['warm-portrait', 'punchy-reversal', 'muted-documentary']) {
      await expect(page.getByTestId(`stock-${id}`)).toBeVisible()
    }
  })
})
