import { test, expect } from '@playwright/test';

// Minimal module-load smoke: the playground boots without console errors and
// the 2D | Split | 3D control drives the divider's visibility.
test('playground loads and the view-mode control toggles the divider', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('http://localhost:8765/web/playground.html');
  await page.waitForFunction(() => document.getElementById('stage')?.style.getPropertyValue('--split') !== '');

  const buttons = page.locator('#view-mode button[data-mode]');
  await expect(buttons).toHaveCount(3);
  await expect(page.locator('#view-mode button[data-mode="2d"]')).toBeVisible();
  await expect(page.locator('#view-mode button[data-mode="split"]')).toBeVisible();
  await expect(page.locator('#view-mode button[data-mode="3d"]')).toBeVisible();

  const divider = page.locator('#stage-divider');
  await expect(divider).toBeVisible();

  // The new-scene popup carries the venue picker with "New venue…" selected
  // by default. It opens by itself only on a fresh server; once earlier runs
  // have created scenes, open it from the header button.
  if (!(await page.locator('#ns-name').isVisible())) {
    await page.locator('#new-scene-btn').dispatchEvent('click');
  }
  const venuePick = page.locator('#ns-venue');
  await expect(venuePick).toBeVisible();
  await expect(venuePick.locator('option').first()).toHaveText('New venue…');
  await expect(venuePick).toHaveValue('');
  const cancel = page.locator('#ns-cancel');
  if (await cancel.count()) await cancel.dispatchEvent('click');

  // A fresh server has no scenes, so the (non-cancellable) new-scene modal
  // overlays the header. Dispatch the click straight to the buttons; the
  // modal is not what this smoke test covers.
  await page.locator('#view-mode button[data-mode="3d"]').dispatchEvent('click');
  await expect(divider).toBeHidden();
  await expect(page.locator('#view-mode button[data-mode="3d"]')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#view-mode button[data-mode="split"]').dispatchEvent('click');
  await expect(divider).toBeVisible();
  await expect(page.locator('#view-mode button[data-mode="split"]')).toHaveAttribute('aria-pressed', 'true');

  expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
});
