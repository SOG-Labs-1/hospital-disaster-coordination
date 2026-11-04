import { expect, test, type Browser, type Page } from '@playwright/test';
import { clickAction } from './helpers';

// 各部署の画面（上部に依頼を固定表示）と、掲示用画面（操作なし・自動更新）

async function openTerminal(browser: Browser, terminal: string, staffName: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/?terminal=${terminal}`);
  await expect(page.getByTestId('sync-status')).toContainText('つながっています');
  await page.getByRole('button', { name: new RegExp(staffName) }).click();
  return page;
}

async function registerAndRequest(hq: Page, tag: string, to: string): Promise<{ patientId: string; transportId: string }> {
  await hq.getByRole('tab', { name: /^(● )?患者/ }).click();
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
  await clickAction(hq.getByTestId(`transport-${transportId}`), '出発を記録');
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
  await expect(board.getByTestId('sync-status')).toContainText('つながっています');
  await expect(board.getByTestId('mode-badge')).toHaveText(/災害運用/);
  // 操作なし：ボタン・入力欄・リンクを置かない
  await expect(board.locator('button, input, select, textarea, a')).toHaveCount(0);

  const before = Number(await board.getByTestId('board-count-red').locator('.board-number').innerText());
  const waitingBefore = Number((await board.getByTestId('board-attention').locator('h2').innerText()).match(/(\d+)件/)![1]);
  const url = board.url();

  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const { transportId } = await registerAndRequest(hq, '302', '3階東病棟');
  await expect(board.getByTestId('board-count-red').locator('.board-number')).toHaveText(String(before + 1), { timeout: 5000 });
  await expect(board.getByTestId('board-attention').locator('h2')).toContainText(`対応待ち ${waitingBefore + 1}件`);

  await hq.getByRole('tab', { name: /搬送/ }).click();
  await clickAction(hq.getByTestId(`transport-${transportId}`), '出発を記録');
  await expect(board.getByTestId('board-moving')).toContainText('救急外来（赤ゾーン） ▶ 3階東病棟', { timeout: 5000 });
  await expect(board.getByTestId('board-acceptance')).toContainText('救急外来（赤ゾーン）');
  // 設定の初期値は確認済みの数字に見せず「未確認（目安）」と出す
  await expect(board.getByTestId('board-place-auditorium')).toContainText('空き未確認（目安');

  // 勝手に画面が切り替わらない
  expect(board.url()).toBe(url);
  await board.screenshot({ path: 'test-results/board.png' });
});

test('掲示用画面：切断中は幅いっぱいの警告を出し、受け取っていない数値は出さない', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  // 配信を止めて、サーバーとの接続が切れた状態を作る
  await context.route('**/live/stream', (route) => route.abort());
  const board = await context.newPage();
  await board.goto('/?view=board');
  await expect(board.getByTestId('board-offline')).toContainText('✕ つながっていません');
  await expect(board.getByTestId('sync-status')).toContainText('✕');
  // 一度も記録を受け取っていないので、0 と読み違えないよう数値を出さない
  await expect(board.getByTestId('board-waiting')).toBeVisible();
  await expect(board.getByTestId('board-patients')).toHaveCount(0);
  // 1080px の高さに収まる（はみ出してスクロールが必要にならない）
  expect(await board.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(1080);
  await board.screenshot({ path: 'test-results/board-offline.png' });
});

test('部署の画面：入力者を選ばずに「対応する」を開くと、その場で名前を選べる', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const { transportId } = await registerAndRequest(hq, '303', '4階東病棟');
  const ward = await (await browser.newContext()).newPage();
  await ward.goto('/?terminal=ward-4e');
  const row = ward.getByTestId(`pinned-accept-${transportId}`);
  await expect(row).toContainText('要請から');
  await row.getByRole('button', { name: '対応する' }).click();
  await expect(row).toContainText('記録するには、先に画面上の一覧から自分の名前を押してください');
  await expect(row.getByRole('button', { name: '了承を記録' })).toBeDisabled();
  await row.getByRole('group', { name: '入力する人の名前' }).getByRole('button', { name: '野村 拓也' }).click();
  await expect(ward.getByTestId('entered-by')).toHaveText('野村 拓也');
  await expect(row.getByRole('button', { name: '了承を記録' })).toBeEnabled();
  // 部署でするべき操作だけを出し、本部向けの操作は「ほかの操作」に折りたたむ
  await expect(row.getByRole('button', { name: '指示を記録' })).toBeHidden();
});
