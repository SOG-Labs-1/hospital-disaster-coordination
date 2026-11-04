import { expect, test, type Browser, type Page } from '@playwright/test';

// 2台の端末（別々のブラウザコンテキスト＝別の端末の保存領域）で、片方の登録がもう片方に即時に反映されることを確かめる

async function openTerminal(browser: Browser, terminal: string, staffName: string, mode = 'live'): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/?terminal=${terminal}&mode=${mode}`);
  await expect(page.getByTestId('sync-status')).toContainText('つながっています');
  await page.getByRole('button', { name: new RegExp(staffName) }).click();
  await expect(page.getByTestId('entered-by')).toHaveText(staffName);
  // 部署の端末は「この部署」タブが先頭なので、患者のタブを開く
  await page.getByRole('tab', { name: /^(● )?患者/ }).click();
  return page;
}

async function register(page: Page, opts: { tag: string; triage: string; location: string; features?: string }) {
  const form = page.getByRole('form', { name: '患者を登録する' });
  await form.locator('label.triage-choice', { hasText: opts.triage }).click();
  await form.getByLabel(/所在/).selectOption({ label: opts.location });
  await form.getByLabel('タッグ番号').fill(opts.tag);
  if (opts.features) await form.getByLabel(/特徴メモ/).fill(opts.features);
  await form.getByRole('button', { name: '登録する' }).click();
}

test('片方の端末で登録した患者が、もう片方の端末に即時に表示される', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const er = await openTerminal(browser, 'er', '川口 直子');

  await expect(hq.getByTestId('mode-badge')).toHaveText(/災害運用/);
  await expect(er.getByTestId('patient-count')).toHaveText('0人');

  await register(er, { tag: '101', triage: '赤', location: '救急外来', features: '紺の上着、眼鏡' });
  await expect(er.getByTestId('notice')).toContainText('P-001 を登録しました');

  // 本部の画面は再読み込みせずに更新される
  const row = hq.getByTestId('patient-P-001');
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row).toContainText('101');
  await expect(row).toContainText('赤');
  await expect(row).toContainText('救急外来');
  await expect(row).toContainText('紺の上着、眼鏡');
  await expect(hq.getByTestId('patient-count')).toHaveText('1人');
  await hq.screenshot({ path: 'test-results/hq-after-sync.png', fullPage: true });
});

test('同じタッグ番号は警告し、理由を記録すれば登録でき、他の端末にも届く', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const er = await openTerminal(browser, 'er', '川口 直子');
  await expect(hq.getByTestId('patient-P-001')).toBeVisible();

  await register(hq, { tag: '101', triage: '黄', location: '外来ホール', features: '赤い帽子' });
  const dialog = hq.getByRole('dialog', { name: '確認してください' });
  await expect(dialog).toContainText('同じタッグ番号「101」の患者がすでにいます（P-001）');
  // 同じ人か判断できるよう、既存の患者の要点が警告画面に出る
  const existing = dialog.getByTestId('existing-P-001');
  await expect(existing).toContainText('救急外来');
  await expect(existing).toContainText('紺の上着、眼鏡');
  await expect(existing.getByRole('button', { name: '同じ患者なので P-001 を開く（記録しない）' })).toBeVisible();
  await hq.screenshot({ path: 'test-results/hq-duplicate-warning.png' });

  const confirm = dialog.getByRole('button', { name: '別の患者として登録する' });
  await expect(confirm).toBeDisabled();
  await expect(dialog).toContainText('理由を1つ選ぶと押せます。');
  await dialog.getByLabel('別の患者であることを確認した').check();
  await confirm.click();

  await expect(hq.getByTestId('notice')).toContainText('P-002 を登録しました');
  const row = er.getByTestId('patient-P-002');
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row).toContainText('重複を承知で登録：別の患者であることを確認した');
  // 同じタッグ番号の患者には、どちらの行にも印が付く
  await expect(row.getByTestId('same-tag')).toContainText('P-001');
  await expect(er.getByTestId('patient-P-001').getByTestId('same-tag')).toContainText('P-002');
});

test('区分の変更が他の端末に届き、履歴に残る', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const er = await openTerminal(browser, 'er', '川口 直子');
  const erRow = er.getByTestId('patient-P-001');
  await erRow.getByRole('button', { name: '区分を変える' }).click();
  await erRow.getByRole('group', { name: 'P-001 の区分を変える' }).getByRole('button', { name: /黄/ }).click();

  const hqRow = hq.getByTestId('patient-P-001');
  await expect(hqRow.locator('.patient-triage')).toContainText('黄', { timeout: 5000 });
  await hqRow.getByText(/区分の履歴（2件）/).click();
  await expect(hqRow.locator('.history li')).toHaveCount(2);
});

test('訓練モードは災害運用と記録が分かれ、常に「訓練」と表示される', async ({ browser }) => {
  const page = await openTerminal(browser, 'hq', '青木 はるか', 'training');
  await expect(page.getByTestId('mode-badge')).toHaveText(/訓練/);
  await expect(page).toHaveTitle(/【訓練】/);
  await expect(page.getByTestId('patient-count')).toHaveText('0人');
});

test('区分の変更は「元に戻す」で取り消せ、取り消しも記録に残る', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const row = hq.getByTestId('patient-P-001');
  await expect(row.locator('.patient-triage')).toContainText('黄'); // 前のテストで黄に変えた
  await row.getByRole('button', { name: '区分を変える' }).click();
  await row.getByRole('group', { name: 'P-001 の区分を変える' }).getByRole('button', { name: /黒/ }).click();
  await expect(hq.getByTestId('notice')).toContainText('P-001 の区分を');
  await expect(row.locator('.patient-triage')).toContainText('黒');

  await hq.getByTestId('notice').getByRole('button', { name: '元に戻す' }).click();
  await expect(hq.getByTestId('notice')).toContainText('戻しました');
  await expect(row.locator('.patient-triage')).toContainText('黄');
  await expect(row.locator('.patient-triage')).not.toContainText('黒');
  await row.getByText(/区分の履歴/).click();
  await expect(row.locator('.history li.history-retracted')).toContainText('取り消し');
});

test('「同じ患者なので開く」を選ぶと記録せず、入力内容が残ることを知らせる', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  await register(hq, { tag: '101', triage: '緑', location: '講堂', features: '白いシャツ' });
  await hq.getByRole('dialog').getByRole('button', { name: /P-001 を開く/ }).click();
  await expect(hq.getByRole('dialog')).toHaveCount(0);
  await expect(hq.getByTestId('notice')).toContainText('記録はしていません');
  await expect(hq.getByTestId('patient-P-001')).toHaveClass(/is-highlighted/);
  await expect(hq.getByLabel('タッグ番号')).toHaveValue('101');
  await expect(hq.getByTestId('patient-count')).toHaveText('2人');
});

test('本部の端末で所在が未選択なら、登録できない理由を出す', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const form = hq.getByRole('form', { name: '患者を登録する' });
  await expect(form.getByRole('button', { name: '登録する' })).toBeDisabled();
  await expect(form).toContainText('所在（いま患者がいる場所）を選ぶと登録できます');
});

test('絞り込んだまま印刷しても全員が出る', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  await hq.getByRole('group', { name: '区分で絞り込む' }).getByRole('button', { name: /赤/ }).click();
  const rows = hq.getByTestId('patient-list').locator('li.patient');
  await expect(rows.filter({ visible: true })).toHaveCount(0);
  await hq.emulateMedia({ media: 'print' });
  await expect(rows.filter({ visible: true })).toHaveCount(2);
  await expect(hq.locator('.print-header')).toContainText('出力');
  await hq.screenshot({ path: 'test-results/print-filtered.png', fullPage: true });
});

test('mode の指定が正しくなければ記録を開かず、選び直させる', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/?terminal=hq&mode=Training');
  await expect(page.getByRole('heading', { name: '災害運用か訓練かを選んでください' })).toBeVisible();
  await expect(page.getByTestId('mode-badge')).toHaveCount(0);
  await page.getByRole('button', { name: /訓練で開く/ }).click();
  await expect(page.getByTestId('mode-badge')).toHaveText(/訓練/);
});
