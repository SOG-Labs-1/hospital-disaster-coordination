import { expect, test, type Browser, type Page } from '@playwright/test';

// 支援要請：病棟から要請し、本部が受付・手配し、病棟で「届いた」を記録する流れを2端末で確かめる

async function openTerminal(browser: Browser, terminal: string, staffName: string, opts: { fakeClock?: boolean } = {}): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  if (opts.fakeClock) await page.clock.install({ time: new Date() });
  await page.goto(`/?terminal=${terminal}`);
  await expect(page.getByTestId('sync-status')).toContainText('つながっています');
  await page.getByRole('button', { name: new RegExp(staffName) }).click();
  await page.getByRole('tab', { name: /支援要請/ }).click();
  return page;
}

async function requestNurses(page: Page, count: string): Promise<string> {
  const form = page.getByRole('form', { name: '支援を要請する' });
  await expect(form.getByLabel(/^要請した場所/)).toHaveValue('ward-3e'); // 端末の場所が既定
  await form.locator('label.chip', { hasText: '人員' }).click();
  await form.getByLabel('看護師の数', { exact: true }).fill(count);
  await form.getByRole('button', { name: '支援を要請する' }).click();
  const text = await page.getByTestId('notice').filter({ hasText: '支援要請を記録しました' }).innerText();
  return text.match(/S-\d+/)![0];
}

test('病棟からの人員の要請を、本部が受付・手配し、病棟で届いたことを記録する', async ({ browser }) => {
  const ward = await openTerminal(browser, 'ward-3e', '中島 綾');
  const hq = await openTerminal(browser, 'hq', '青木 はるか');

  const id = await requestNurses(ward, '2');
  const card = hq.getByTestId(`support-${id}`);
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText('3階東病棟から：人員');
  await expect(card).toContainText('看護師 2人');
  await expect(card.getByTestId('sstep-assigned')).toContainText('未記録');

  // 本部：受付（担当は入力者が既定）→ 手配の指示
  await card.getByRole('button', { name: '受付（担当を付ける）' }).click();
  await card.getByRole('form', { name: '受付（担当）の記録' }).getByRole('button', { name: '担当を記録する' }).click();
  await expect(card.getByTestId('sstep-assigned')).toContainText('青木 はるか');
  await card.getByRole('button', { name: '手配を指示' }).click();
  const dispatch = card.getByRole('form', { name: '手配の指示の記録' });
  await dispatch.getByLabel('誰に（手配先の場所）').selectOption({ label: '外来ホール' });
  await dispatch.getByRole('button', { name: '手配の指示を記録する' }).click();
  await expect(card.getByTestId('sstep-dispatched')).toContainText('外来ホールから3階東病棟へ');

  // 病棟：届いたことを記録すると、本部の画面に反映される
  const wardCard = ward.getByTestId(`support-${id}`);
  await expect(wardCard.getByTestId('sstep-dispatched')).toContainText('外来ホールから', { timeout: 5000 });
  await wardCard.getByRole('button', { name: '受け取り', exact: true }).click();
  await expect(card.getByTestId('sstep-received')).not.toContainText('未記録', { timeout: 5000 });

  await card.getByRole('button', { name: '完了', exact: true }).click();
  await expect(hq.getByTestId('support-list').getByTestId(`support-${id}`)).toHaveCount(0);
  await hq.locator('details.closed-transports summary').click();
  await expect(hq.locator('details.closed-transports').getByTestId(`support-${id}`)).toContainText('完了');
});

test('担当が付かないまま一定時間が過ぎた要請を「未対応」として目立たせる', async ({ browser }) => {
  const ward = await openTerminal(browser, 'ward-3e', '中島 綾');
  const hq = await openTerminal(browser, 'hq', '青木 はるか', { fakeClock: true });
  const id = await requestNurses(ward, '1');
  const card = hq.getByTestId(`support-${id}`);
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card.getByTestId('support-alert')).toHaveCount(0);

  // 病院設定の「未対応」の閾値（10分）を過ぎるまで時計を進める
  await hq.clock.fastForward('11:00');
  await expect(card.getByTestId('support-alert')).toContainText('未対応');
  await expect(card).toContainText('担当が付かないまま');
  await expect(hq.getByTestId('support-alert-count')).toContainText('未対応・未完了');
  await expect(hq.getByRole('tab', { name: /支援要請/ })).toContainText('⏱');
  await hq.screenshot({ path: 'test-results/support-alert.png', fullPage: true });
});
