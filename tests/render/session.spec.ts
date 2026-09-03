import { expect, test } from '@playwright/test'

/**
 * Work in progress survives a reload, and reattaches to the right photograph.
 *
 * The unit tests cover the store and the boundary. This covers the part that
 * only exists once the loader, the store and IndexedDB are wired together —
 * including the decision that matters most, which is what happens when the
 * application is reopened without the source.
 */

const IMAGE = `async ({ name, tint }) => {
  const canvas = new OffscreenCanvas(320, 240)
  const context = canvas.getContext('2d')
  context.fillStyle = 'rgb(' + tint + ', 120, 140)'
  context.fillRect(0, 0, 320, 240)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  // A fixed lastModified, so reopening "the same file" really is the same key.
  const file = new File([blob], name, { type: 'image/png', lastModified: 1000 })
  const input = document.querySelector('[data-testid="image-input"]')
  const dt = new DataTransfer(); dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}`

async function open(page: import('@playwright/test').Page, name: string, tint: number) {
  await page.evaluate(`(${IMAGE})(${JSON.stringify({ name, tint })})`)
  await expect(page.getByTestId('image-label')).toContainText(name, { timeout: 30_000 })
  await page.waitForTimeout(300)
}

const exposureOf = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    (window as unknown as { __photolabStore: { getState(): { edit: { exposure: number } } } })
      .__photolabStore.getState().edit.exposure,
  )

test.describe('a session', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => '__photolabRenderer' in window)
    await page.evaluate(() => {
      indexedDB.deleteDatabase('photolab-session')
    })
    await page.reload()
    await page.waitForFunction(() => '__photolabRenderer' in window)
  })

  test('restores an edit when the same photograph is reopened', async ({ page }) => {
    await open(page, 'a.png', 200)
    await page.evaluate(() => {
      (window as unknown as { __photolabStore: { getState(): { applyPatch(p: unknown): void } } })
        .__photolabStore.getState().applyPatch({ exposure: 1.25, contrast: 1.3 })
    })
    // The store writes after a short coalescing delay, so a drag does not
    // produce sixty writes a second.
    await page.waitForTimeout(900)

    await page.reload()
    await page.waitForFunction(() => '__photolabRenderer' in window)
    // Nothing is restored before a photograph is opened: the edit has nothing to
    // apply to and waits rather than being applied to whatever comes next.
    expect(await exposureOf(page)).toBe(0)

    await open(page, 'a.png', 200)
    expect(await exposureOf(page)).toBeCloseTo(1.25, 6)
    await expect(page.getByTestId('restored-note')).toBeVisible()
  })

  test('does not apply one photograph edit to another', async ({ page }) => {
    // The decision this exists to hold. Exposure and white balance are decisions
    // about the light in *that* scene; carrying them to a different file is not
    // restoring work, it is corrupting a new photograph with an old one's edit.
    await open(page, 'a.png', 200)
    await page.evaluate(() => {
      (window as unknown as { __photolabStore: { getState(): { applyPatch(p: unknown): void } } })
        .__photolabStore.getState().applyPatch({ exposure: 1.25 })
    })
    await page.waitForTimeout(900)

    await page.reload()
    await page.waitForFunction(() => '__photolabRenderer' in window)
    await open(page, 'b.png', 60)
    expect(await exposureOf(page)).toBe(0)
    await expect(page.getByTestId('restored-note')).toHaveCount(0)
  })

  test('keeps both photographs edits apart', async ({ page }) => {
    await open(page, 'a.png', 200)
    await page.evaluate(() => {
      (window as unknown as { __photolabStore: { getState(): { applyPatch(p: unknown): void } } })
        .__photolabStore.getState().applyPatch({ exposure: 1.25 })
    })
    await page.waitForTimeout(900)

    await open(page, 'b.png', 60)
    await page.evaluate(() => {
      (window as unknown as { __photolabStore: { getState(): { applyPatch(p: unknown): void } } })
        .__photolabStore.getState().applyPatch({ exposure: -0.75 })
    })
    await page.waitForTimeout(900)

    await page.reload()
    await page.waitForFunction(() => '__photolabRenderer' in window)
    await open(page, 'a.png', 200)
    expect(await exposureOf(page)).toBeCloseTo(1.25, 6)
    await open(page, 'b.png', 60)
    expect(await exposureOf(page)).toBeCloseTo(-0.75, 6)
  })

  test('does not persist how you were looking at it', async ({ page }) => {
    // ViewState is the session, not the photograph. The inspector's position and
    // the debug display modes describe how you were looking, and restoring them
    // would make a debug toggle stick across reloads with nothing saying why.
    await open(page, 'a.png', 200)
    await page.evaluate(() => {
      const r = (window as unknown as {
        __photolabRenderer: { setView(v: Record<string, unknown>): void }
      }).__photolabRenderer
      r.setView({ inspect: true, inspectCentre: [0.2, 0.8], toneMap: false })
      ;(window as unknown as { __photolabStore: { getState(): { applyPatch(p: unknown): void } } })
        .__photolabStore.getState().applyPatch({ exposure: 0.5 })
    })
    await page.waitForTimeout(900)

    await page.reload()
    await page.waitForFunction(() => '__photolabRenderer' in window)
    await open(page, 'a.png', 200)

    const view = await page.evaluate(() =>
      (window as unknown as { __photolabRenderer: { view: Record<string, unknown> } })
        .__photolabRenderer.view,
    )
    // The edit came back; the viewing settings did not.
    expect(await exposureOf(page)).toBeCloseTo(0.5, 6)
    expect(view.inspect).toBe(false)
    expect(view.toneMap).toBe(true)
    expect(view.inspectCentre).toEqual([0.5, 0.5])
  })
})
