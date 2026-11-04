import { expect, test, type Browser, type Page } from '@playwright/test';

// 各部署の画面（上部に依頼を固定表示）と、掲示用画面（操作なし・自動更新）

async function openTerminal(browser: Browser, terminal: string, staffName: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/?terminal=${terminal}`);
  await expect(page.getByTestId('sync-status')).toContainText('同期中');
  await page.getByRole('button', { name: new RegExp(staffName) }).click();
  return page;
}

async function registerAndRequest(hq: Page, tag: string, to: string): Promise<{ patientId: string; transportId: string }> {
  await hq.getByRole('tab', { name: /^(▼ )?患者/ }).click();
  const form = hq.getByRole('form', { name: '患者を登録する' });
  await form.locator('label.triage-choice', { hasText: '赤' }).click();
  await form.getByLabel(/所在/).selectOption({ label: '救急外来' });
  await form.getByLabel('タッグ番号').fill(tag);
  await form.getByRole('button', { name: '登録する' }).click();
  const patientId = (await hq.getByTestId('notice').filter({ hasText: 'を登録しました' }).innerText()).match(/P-\d+/)![0];
  await hq.getByTestId(`patient-${patientId}`).getByRole('button', { name: '搬送を依頼する' }).click();
  const tf = hq.getByRole('form', { name: '搬送を依頼する' });
  await tf.getByLabel(/^到着先/).selectOption({ label: to });
  await tf.getByRole('button', { name: '搬送を依頼する' }).click();
  const transportId = (await hq.getByTestId('notice').filter({ hasText: '搬送依頼を記録しました' }).innerText()).match(/T-\d+/)![0];
  return { patientId, transportId };
}

test('部署の画面：届いた依頼が上部に固定表示され、その場で了承・到着を記録できる', async ({ browser }) => {
  const or = await openTerminal(browser, 'or', '田村 由紀');
  const hq = await openTerminal(browser, 'hq', '青木 はるか');

  // 部署の端末は「この部署」タブが先頭で、上部に依頼の欄がある。本部の端末にはない
  await expect(or.getByRole('tab', { name: /この部署/ })).toHaveAttribute('aria-selected', 'true');
  await expect(hq.getByTestId('pinned-requests')).toHaveCount(0);

  const { patientId, transportId } = await registerAndRequest(hq, '301', '手術室');
  const acceptRow = or.getByTestId(`pinned-accept-${transportId}`);
  await expect(acceptRow).toContainText('受け入れの判断', { timeout: 5000 });
  await expect(acceptRow).toContainText('救急外来から');

  // 別のタブを開いていても上部の依頼は表示されたまま
  await or.getByRole('tab', { name: /院内の状況/ }).click();
  await expect(acceptRow).toBeVisible();
  await acceptRow.getByRole('button', { name: '対応する' }).click();
  await acceptRow.getByRole('button', { name: '了承を記録' }).click();
  await acceptRow.getByRole('form', { name: '受け入れ了承の記録' }).getByRole('button', { name: '了承を記録する' }).click();
  await expect(or.getByTestId(`pinned-accept-${transportId}`)).toHaveCount(0);

  // 本部が出発を記録すると、手術室に「到着の記録」が出る
  await hq.getByRole('tab', { name: /搬送/ }).click();
  await hq.getByTestId(`transport-${transportId}`).getByRole('button', { name: '出発を記録' }).click();
  const arriveRow = or.getByTestId(`pinned-arrive-${transportId}`);
  await expect(arriveRow).toContainText('救急外来から移動中', { timeout: 5000 });
  await arriveRow.getByRole('button', { name: '対応する' }).click();
  await arriveRow.getByRole('button', { name: '到着を記録' }).click();
  await expect(or.getByTestId(`pinned-arrive-${transportId}`)).toHaveCount(0);

  // 「この部署」タブに、到着した患者が出る
  await or.getByRole('tab', { name: /この部署/ }).click();
  await expect(or.getByTestId(`patient-${patientId}`)).toBeVisible();
  await expect(or.getByTestId('location-or')).toBeVisible();
  await or.screenshot({ path: 'test-results/department.png', fullPage: true });
});

test('掲示用画面：操作できる部品がなく、記録が変わると自動で更新される', async ({ browser }) => {
  const board = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await board.goto('/?view=board');
  await expect(board.getByTestId('display-board')).toBeVisible();
  await expect(board.getByTestId('sync-status')).toContainText('同期中');
  await expect(board.getByTestId('mode-badge')).toHaveText(/実運用/);
  // 操作なし：ボタン・入力欄・リンクを置かない
  await expect(board.locator('button, input, select, textarea, a')).toHaveCount(0);

  const before = Number(await board.getByTestId('board-count-red').locator('.board-number').innerText());
  const url = board.url();

  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const { transportId } = await registerAndRequest(hq, '302', '3階東病棟');
  await expect(board.getByTestId('board-count-red').locator('.board-number')).toHaveText(String(before + 1), { timeout: 5000 });
  await expect(board.getByTestId('board-attention')).toContainText(`受け入れ判断待ち　${transportId}`);

  await hq.getByRole('tab', { name: /搬送/ }).click();
  await hq.getByTestId(`transport-${transportId}`).getByRole('button', { name: '出発を記録' }).click();
  await expect(board.getByTestId('board-moving')).toContainText('救急外来（赤ゾーン） ▶ 3階東病棟', { timeout: 5000 });
  await expect(board.getByTestId('board-acceptance')).toContainText('救急外来（赤ゾーン）');

  // 勝手に画面が切り替わらない
  expect(board.url()).toBe(url);
  await board.screenshot({ path: 'test-results/board.png' });
});
