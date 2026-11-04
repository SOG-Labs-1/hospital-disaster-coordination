import { expect, test, type Page } from '@playwright/test';
import { clickAction } from './helpers';

// 病院B（Hackathon中央病院(仮)）：同じ仕組みが設定だけで動くことを確かめる
// 待合を黄・緑の両方に使う、本部長が搬送調整を兼任、受け入れは担当者なら誰でも、到着と引き渡しを分ける

async function open(page: Page, query: string, staff?: string) {
  await page.goto(`/?${query}`);
  await expect(page.getByTestId('sync-status')).toContainText('同期中');
  if (staff) await page.getByRole('button', { name: new RegExp(staff) }).click();
}

test('病院を選ぶ画面から病院Bを選び、記録は病院Aと分かれている', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/?hospital=');
  await expect(page.getByRole('heading', { name: '病院を選んでください' })).toBeVisible();
  await page.locator('.hospital-choice', { hasText: 'Hackathon中央病院(仮)' }).getByRole('button', { name: /災害運用で開く/ }).click();
  await expect(page.getByRole('heading', { name: 'このパソコンを置いた場所を選んでください' })).toBeVisible();
  await expect(page.getByText('病院：Hackathon中央病院(仮)')).toBeVisible();
  await page.getByRole('button', { name: '本部（1階事務室）' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('同期中');
  await expect(page.getByRole('banner')).toContainText('Hackathon中央病院(仮)');
  await page.getByRole('tab', { name: /^(▼ )?患者/ }).click();
  await expect(page.getByTestId('patient-count')).toHaveText('0人'); // 病院Aの患者は出ない
});

test('病院Bの設定で、登録から搬送・引き渡しまでが動く', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await open(hq, 'hospital=hackathon&terminal=hq', '内田 千夏');
  await hq.getByRole('tab', { name: /^(▼ )?患者/ }).click();

  // 待合は黄ゾーンと緑ゾーンの両方
  const form = hq.getByRole('form', { name: '患者を登録する' });
  await expect(form.getByLabel(/所在/).locator('option')).toHaveText(['選んでください', '本部（1階事務室）', '外来処置室', '外来待合', '手術室', '2階病棟', '3階病棟']);
  await form.locator('label.triage-choice', { hasText: '黄' }).click();
  await form.getByLabel(/所在/).selectOption({ label: '外来待合' });
  await form.getByLabel('タッグ番号').fill('B-1');
  await form.getByRole('button', { name: '登録する' }).click();
  const patientId = (await hq.getByTestId('notice').filter({ hasText: 'を登録しました' }).innerText()).match(/P-\d+/)![0];

  await hq.getByTestId(`patient-${patientId}`).getByRole('button', { name: '搬送を依頼する' }).click();
  const tf = hq.getByRole('form', { name: '搬送を依頼する' });
  await expect(tf).toContainText('外来待合（黄ゾーン・緑ゾーン）');
  await tf.getByLabel(/^到着先/).selectOption({ label: '2階病棟' });
  await tf.getByRole('button', { name: '搬送を依頼する' }).click();
  const transportId = (await hq.getByTestId('notice').filter({ hasText: '搬送依頼を記録しました' }).innerText()).match(/T-\d+/)![0];
  const card = hq.getByTestId(`transport-${transportId}`);
  // 病院Bでは要員の割り当ても省略可、段階名も設定から
  await expect(card.getByTestId('step-staffAssigned')).toContainText('未記録（省略可）');
  await expect(card.getByTestId('step-ordered')).toContainText('本部の指示');

  // 2階病棟の端末：受け入れは担当者なら誰でも判断できる（職員の名前で選ぶ）
  const ward = await (await browser.newContext()).newPage();
  await open(ward, 'hospital=hackathon&terminal=ward-2', '坂本 由香');
  const row = ward.getByTestId(`pinned-accept-${transportId}`);
  await row.getByRole('button', { name: '対応する' }).click();
  await row.getByRole('button', { name: '了承を記録' }).click();
  const accept = row.getByRole('form', { name: '受け入れ了承の記録' });
  await accept.getByLabel(/判断した人/).selectOption({ label: '坂本 由香' });
  await accept.getByRole('button', { name: '了承を記録する' }).click();
  await expect(card.getByTestId('step-accepted')).toContainText('坂本 由香', { timeout: 5000 });

  // 本部長（搬送調整を兼任）が指示
  // 病院Bは要員の割り当てを省略できる設定なので、了承の次は「指示を記録」が大きく出る
  await expect(card.getByRole('group', { name: /次にすること/ })).toContainText('指示を記録');
  await clickAction(card, '指示を記録');
  await card.getByRole('form', { name: '指示の記録' }).getByRole('button', { name: '指示を記録する' }).click();
  await expect(card.getByTestId('step-ordered')).toContainText('本部長（搬送調整を兼任）');

  // 到着しても担当部署はまだ移らず、引き渡しを別に記録する
  await card.getByRole('button', { name: '出発を記録' }).click();
  await card.getByRole('button', { name: '到着を記録' }).click();
  // 引き渡しが未記録のあいだは、調整中の一覧に残る
  const done = hq.getByTestId('transport-list').getByTestId(`transport-${transportId}`);
  await expect(done).toContainText('引き渡し未記録');
  await hq.getByRole('tab', { name: /^(▼ )?患者/ }).click();
  await expect(hq.getByTestId(`patient-${patientId}`)).toContainText('担当外来待合');
  // 2階病棟の上部の依頼欄に「引き渡しの記録」が出て、そこから記録できる
  const handover = ward.getByTestId(`pinned-handover-${transportId}`);
  await expect(handover).toContainText('到着済み', { timeout: 5000 });
  await handover.getByRole('button', { name: '対応する' }).click();
  await handover.getByRole('button', { name: '引き渡しを記録' }).click();
  await expect(ward.getByTestId(`pinned-handover-${transportId}`)).toHaveCount(0);
  await hq.getByRole('tab', { name: /^(▼ )?患者/ }).click();
  await expect(hq.getByTestId(`patient-${patientId}`)).toContainText('2階病棟');
  await expect(hq.getByTestId(`patient-${patientId}`)).not.toContainText('担当');
});

test('病院Bの掲示用画面', async ({ browser }) => {
  const board = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await board.goto('/?hospital=hackathon&view=board');
  await expect(board.getByTestId('display-board')).toContainText('Hackathon中央病院(仮)');
  await expect(board.getByTestId('board-place-waiting')).toContainText('外来待合（黄ゾーン・緑ゾーン）');
  await board.screenshot({ path: 'test-results/board-hackathon.png' });
});

test('入力者を選んでいなくても、上部の「端末の設定」から病院や場所を選び直せる。災害運用と訓練の切り替えは病院を選ぶ画面だけで行う', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/?hospital=');
  // 病院を選ぶ画面から、訓練モードで開ける
  await page.locator('.hospital-choice', { hasText: 'Claude総合病院(仮)' }).getByRole('button', { name: /訓練モードで開く/ }).click();
  await expect(page.getByText('モード：◇ 訓練')).toBeVisible();
  await page.getByRole('button', { name: '災害対策本部（2階会議室）' }).click();
  await expect(page.getByTestId('mode-badge')).toHaveText(/訓練/);

  // 端末の設定には災害運用と訓練の切り替えを置かない（誤操作を防ぐ）。病院を選び直して災害運用で開く
  await page.getByRole('button', { name: /端末の設定/ }).click();
  const panel = page.getByRole('dialog', { name: '端末の設定' });
  await expect(panel.getByRole('button', { name: /訓練モードに切り替える|災害運用に戻す/ })).toHaveCount(0);
  await panel.getByRole('button', { name: '病院を変える' }).click();
  await expect(panel).toContainText('「災害運用で開く」を押します');
  await panel.getByRole('button', { name: '病院を選び直す' }).click();
  await page.locator('.hospital-choice', { hasText: 'Claude総合病院(仮)' }).getByRole('button', { name: /災害運用で開く/ }).click();
  // 端末の場所は覚えているので、選び直さずに災害運用で開く
  await expect(page.getByTestId('mode-badge')).toHaveText(/災害運用/);

  // 場所を選び直す
  await page.getByRole('button', { name: /端末の設定/ }).click();
  await page.getByRole('dialog', { name: '端末の設定' }).getByRole('button', { name: '端末の場所を変える' }).click();
  await page.getByRole('dialog', { name: '端末の設定' }).getByRole('button', { name: '場所を選び直す' }).click();
  await expect(page.getByRole('heading', { name: 'このパソコンを置いた場所を選んでください' })).toBeVisible();
});

test('前回この端末で訓練を開いていたら、アドレスに mode がないときは黙って災害運用で開かず、選び直させる', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/?hospital=claude&terminal=hq&mode=training');
  await expect(page.getByTestId('mode-badge')).toHaveText(/訓練/);
  await page.goto('/?hospital=claude&terminal=hq');
  await expect(page.getByRole('heading', { name: '災害運用か訓練かを選んでください' })).toBeVisible();
  await expect(page.getByText('前回この端末では訓練モードを開いていました')).toBeVisible();
  await page.getByRole('button', { name: /災害運用で開く/ }).click();
  await expect(page.getByTestId('mode-badge')).toHaveText(/災害運用/);
  // 災害運用を選んだあとは、mode がなくても災害運用で開く
  await page.goto('/?hospital=claude&terminal=hq');
  await expect(page.getByTestId('mode-badge')).toHaveText(/災害運用/);
});
