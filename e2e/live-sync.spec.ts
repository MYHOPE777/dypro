import { expect, test } from '@playwright/test';

test('keeps operator and presenter views synchronized', async ({ page, browser, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/[^a-z0-9_-]/giu, '-');
  const sessionId = `live-e2e-${suffix}`;
  const roomId = `room-e2e-${suffix}`;
  const created = await request.post('/api/v2/sessions', { data: { sessionId, roomId } });
  expect(created.ok()).toBe(true);
  const started = await request.post(`/api/v2/sessions/${sessionId}/commands`, { data: { command: { type: 'start' } } });
  expect(started.ok()).toBe(true);
  const linkResponse = await request.post(`/api/v2/sessions/${sessionId}/display-link`);
  expect(linkResponse.ok()).toBe(true);
  const link = await linkResponse.json() as { path: string };

  const presenterContext = await browser.newContext({ viewport: testInfo.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
  const presenter = await presenterContext.newPage();
  try {
    await Promise.all([page.goto(`/?session=${sessionId}`), presenter.goto(link.path)]);
    await expect(page.getByRole('heading', { name: '轻透焕亮精华' })).toBeVisible();
    await expect(presenter.getByText('主播提示屏')).toBeVisible();
    await expect(page.getByRole('button', { name: /选择输入设备/u })).toBeVisible();

    const liveProductName = `本场实时精华-${testInfo.project.name}`;
    await page.getByRole('button', { name: '资料管理' }).click();
    await page.getByRole('button', { name: '商品资料' }).click();
    await page.getByRole('button', { name: '编辑 轻透焕亮精华' }).click();
    await page.getByLabel('商品名称').fill(liveProductName);
    await page.screenshot({ path: testInfo.outputPath('product-editor-form.png'), fullPage: true });
    await page.getByRole('button', { name: '保存并同步本场' }).click();
    await expect(page.getByText('商品资料已同步到当前直播间和本场页面')).toBeVisible();
    await expect(presenter.locator('.v2-brand small')).toHaveText(liveProductName);
    await page.screenshot({ path: testInfo.outputPath('product-editor.png'), fullPage: true });
    await page.getByTitle('关闭').click();
    await expect(page.getByRole('heading', { name: liveProductName })).toBeVisible();

    const transcript = '云感降噪耳机适合日常通勤使用';
    await page.getByPlaceholder('粘贴或输入主播话术进行核验').fill(transcript);
    await page.getByTitle('提交').click();

    await expect(page.getByText(transcript)).toBeVisible();
    await expect(presenter.getByText(transcript)).toBeVisible();
    await expect(page.getByRole('heading', { name: '云感降噪耳机' })).toBeVisible();
    await expect(presenter.locator('.v2-brand small')).toHaveText('云感降噪耳机');
    await expect(presenter.locator('.v2-coach-grid article')).toHaveCount(3);
    await expect(presenter.locator('.v2-risk-panel')).toBeVisible();
    await expect(presenter.locator('.v2-coach-board')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('operator.png'), fullPage: true });
    await presenter.screenshot({ path: testInfo.outputPath('presenter.png'), fullPage: true });
  } finally {
    await request.post(`/api/v2/sessions/${sessionId}/commands`, { data: { command: { type: 'end' } } });
    await presenterContext.close();
  }
});
