import { expect, test, type Browser, type Page } from '@playwright/test';

// 公開デモ（審査用）を、審査員と同じ手順で通す。ブラウザのエラーと、失敗した通信がないことも確かめる

const problems: string[] = [];
function watch(page: Page, name: string) {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${name} console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`${name} ${r.status()} ${r.url()}`);
  });
  return page;
}

async function open(browser: Browser, name: string, path: string): Promise<Page> {
  const page = watch(await (await browser.newContext()).newPage(), name);
  await page.goto(path);
  return page;
}

test.beforeEach(() => {
  problems.length = 0;
});
test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

test('最初の画面：病院を選ぶ画面に、製品名と公開デモの案内が出る', async ({ browser }) => {
  const page = await open(browser, 'top', '/');
  await expect(page.getByText('病院リンクBCP', { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId('demo-guide')).toContainText('タブを3つ');
  await expect(page.getByRole('heading', { name: '病院を選んでください' })).toBeVisible();
  // 病院を選ぶ → 端末の場所を選ぶ → 入力者を選ぶ、の流れ
  await page.locator('.hospital-choice', { hasText: 'Claude総合病院(仮)' }).getByRole('button', { name: /災害運用で開く/ }).click();
  await expect(page.getByRole('heading', { name: 'このパソコンを置いた場所を選んでください' })).toBeVisible();
  await page.getByRole('button', { name: /^災害対策本部/ }).first().click();
  await expect(page.getByTestId('mode-badge')).toHaveText(/災害運用/);
  await expect(page.getByTestId('sync-status')).toContainText('つながっています');
  await page.screenshot({ path: 'test-results/demo-top.png', fullPage: true });
});

test('3つのタブ：本部で登録・依頼すると、手術室と掲示用画面にすぐ届き、了承と出発が同期する', async ({ browser }) => {
  const tag = String(900 + Math.floor(Math.random() * 99));
  const hq = await open(browser, 'hq', '/?hospital=claude&terminal=hq&mode=live');
  const or = await open(browser, 'or', '/?hospital=claude&terminal=or&mode=live');
  const board = watch(await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(), 'board');
  await board.goto('/?hospital=claude&view=board&mode=live');
  for (const p of [hq, or]) await expect(p.getByTestId('sync-status')).toContainText('つながっています');
  await hq.getByRole('button', { name: /青木 はるか/ }).click();
  await or.getByRole('button', { name: /田村 由紀/ }).click();
  await expect(board.getByTestId('display-board')).toBeVisible();
  const redBefore = Number(await board.getByTestId('board-count-red').locator('.board-number').innerText());

  // 本部で患者を登録し、手術室へ搬送を依頼する
  await hq.getByRole('tab', { name: /^(● )?患者/ }).click();
  const form = hq.getByRole('form', { name: '患者を登録する' });
  await form.locator('label.triage-choice', { hasText: '赤' }).click();
  await form.getByLabel(/所在/).selectOption({ label: '救急外来' });
  await form.getByLabel('タッグ番号').fill(tag);
  await form.getByRole('button', { name: '登録する' }).click();
  const notice = hq.getByTestId('notice').filter({ hasText: 'を登録しました' });
  // 同じタッグ番号の警告が出たら（ほかの方の操作と重なったとき）、理由を選んで進める
  const patientId = (await notice.innerText({ timeout: 10_000 })).match(/P-\d+/)![0];
  await expect(board.getByTestId('board-count-red').locator('.board-number')).toHaveText(String(redBefore + 1), { timeout: 10_000 });
  await hq.getByTestId(`patient-${patientId}`).getByRole('button', { name: '搬送を依頼する' }).click();
  const tf = hq.getByRole('form', { name: '搬送を依頼する' });
  await tf.getByLabel(/^到着先/).selectOption({ label: '手術室' });
  await tf.getByRole('button', { name: '搬送を依頼する' }).click();
  const transportId = (await hq.getByTestId('notice').filter({ hasText: '搬送依頼を記録しました' }).innerText()).match(/T-\d+/)![0];

  // 手術室の上部に「受け入れの判断」が出て、了承できる
  const row = or.getByTestId(`pinned-accept-${transportId}`);
  await expect(row).toContainText('受け入れの判断', { timeout: 10_000 });
  await row.getByRole('button', { name: '対応する' }).click();
  await row.getByRole('button', { name: '了承を記録' }).click();
  await row.getByRole('form', { name: '受け入れ了承の記録' }).getByRole('button', { name: '了承を記録する' }).click();
  await expect(or.getByTestId(`pinned-accept-${transportId}`)).toHaveCount(0);

  // 本部の搬送のカードに了承が届き、出発を記録すると、掲示用画面の「移動中」に出る
  await hq.getByRole('tab', { name: /搬送/ }).click();
  const card = hq.getByTestId(`transport-${transportId}`);
  await expect(card).toContainText('了承', { timeout: 10_000 });
  const btn = () => card.getByRole('button', { name: /^出発を記録/ }).filter({ visible: true });
  if ((await btn().count()) === 0) await card.locator('summary', { hasText: 'ほかの操作' }).click();
  await btn().first().click();
  await expect(board.getByTestId('board-moving')).toContainText('手術室', { timeout: 10_000 });
  await hq.screenshot({ path: 'test-results/demo-hq.png', fullPage: true });
  await board.screenshot({ path: 'test-results/demo-board.png' });
});

test('訓練：審査用5分シナリオを始めると、患者は救急外来の端末から入り、手術室（Claude）が判断し、搬送要員（Claude）と無線でやりとりできる', async ({ browser }) => {
  test.setTimeout(300_000);
  const hq = await open(browser, 'training', '/?hospital=claude&terminal=hq&mode=training');
  await expect(hq.getByTestId('mode-badge')).toHaveText(/訓練/);
  await hq.getByRole('button', { name: /青木 はるか/ }).click();
  await hq.getByRole('tab', { name: /訓練/ }).click();
  // ほかの回が進行中なら終える（このテストのやり直しのため）
  if (await hq.getByTestId('training-run').isVisible().catch(() => false)) {
    await hq.getByRole('button', { name: '訓練を終える' }).click();
    await hq.getByRole('button', { name: '終了する' }).click();
  }
  const scenario = hq.getByTestId('scenario-claude-judge-5min');
  await expect(scenario).toContainText('審査用5分シナリオ');
  await expect(hq.getByText('部署役（Claude（AI））', { exact: false }).first()).toBeVisible();
  await scenario.getByRole('button', { name: 'この訓練を選ぶ' }).click();
  await scenario.getByRole('button', { name: 'この訓練を始める' }).click();
  await expect(hq.getByTestId('training-run')).toContainText('進行中');
  await hq.getByRole('button', { name: /2倍速/ }).click();

  // 救急外来の端末から、赤の患者（タッグ201）が登録される
  await hq.getByRole('tab', { name: /^(● )?患者/ }).click();
  const p1 = hq.getByTestId('patient-P-001');
  await expect(p1).toContainText('201', { timeout: 60_000 });

  // 手術室への搬送を依頼する → 手術室の部署役（Claude）が判断し、手術室の端末から記録される
  await p1.getByRole('button', { name: '搬送を依頼する' }).click();
  const tf = hq.getByRole('form', { name: '搬送を依頼する' });
  await tf.getByLabel(/^到着先/).selectOption({ label: '手術室' });
  await tf.getByRole('button', { name: '搬送を依頼する' }).click();
  await hq.getByRole('tab', { name: /搬送/ }).click();
  const card = hq.getByTestId('transport-T-001');
  await expect(card).toContainText(/了承済み|断り/, { timeout: 90_000 });

  // 搬送要員（Claude）に無線で指示すると、無線で返事が届く
  await hq.getByRole('tab', { name: /訓練/ }).click();
  await hq.getByRole('form', { name: '部署への連絡' }).getByLabel('伝えること').fill('T-001、救急外来から手術室へ運んでください');
  await hq.getByRole('button', { name: '無線で伝える' }).click();
  await expect(hq.getByTestId('radio-inbox').locator('.radio-row').first()).toContainText('搬送要員', { timeout: 90_000 });
  await hq.screenshot({ path: 'test-results/demo-training.png', fullPage: true });

  // 終えると振り返りが出る
  await hq.getByRole('button', { name: '訓練を終える' }).click();
  await hq.getByRole('button', { name: '終了する' }).click();
  await expect(hq.getByTestId('review')).toBeVisible({ timeout: 20_000 });
  await hq.screenshot({ path: 'test-results/demo-review.png', fullPage: true });
});
