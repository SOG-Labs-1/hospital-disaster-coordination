import { expect, test } from '@playwright/test';

// 訓練モード（mock の部署役）を、開始から振り返りまで通す。
// 部署役の連絡は「無線の受信」に届き、ボードは自動で変わらない。参加者が聞いて自分で入力する

test('訓練を始め、無線の連絡を聞いてボードに入力し、終えて振り返る', async ({ browser }) => {
  test.setTimeout(120_000);
  const hq = await (await browser.newContext()).newPage();
  await hq.goto('/?hospital=claude&terminal=hq&mode=training');
  await expect(hq.getByTestId('mode-badge')).toHaveText(/訓練/);
  await hq.getByRole('button', { name: /青木 はるか/ }).click();

  // シナリオを選んで始め、2倍速にする
  await hq.getByRole('tab', { name: /訓練/ }).click();
  const scenario = hq.getByTestId('scenario-claude-red-to-or');
  await expect(scenario).toContainText('赤ゾーンから手術室へ');
  await scenario.getByRole('button', { name: 'この訓練を選ぶ' }).click();
  await scenario.getByRole('button', { name: 'この訓練を始める' }).click();
  await expect(hq.getByTestId('training-run')).toContainText('進行中');
  await hq.getByRole('button', { name: /2倍速/ }).click();
  await expect(hq.getByTestId('training-run')).toContainText('2倍速');

  // 救急外来の部署役から無線で報告が届く。ボードには何も増えない
  const inbox = hq.getByTestId('radio-inbox');
  const first = inbox.locator('.radio-row', { hasText: 'タッグ101' });
  await expect(first).toContainText('救急外来', { timeout: 40_000 });
  await hq.getByRole('tab', { name: /^(▼ )?患者/ }).click();
  await expect(hq.getByTestId('patient-count')).toHaveText('0人');

  // 聞いた連絡をクロノロジーに残し、患者を登録して、手術室への搬送を依頼する
  await first.getByRole('button', { name: '連絡メモに残す' }).click();
  await expect(hq.getByTestId('notice')).toContainText('連絡メモ');
  await expect(inbox.locator('.radio-row', { hasText: 'タッグ101' }).getByRole('button', { name: '聞いた' })).toHaveCount(0);
  const form = hq.getByRole('form', { name: '患者を登録する' });
  await form.locator('label.triage-choice', { hasText: '赤' }).click();
  await form.getByLabel(/所在/).selectOption({ label: '救急外来' });
  await form.getByLabel('タッグ番号').fill('101');
  await form.getByLabel(/特徴メモ/).fill('紺の作業着');
  await form.getByRole('button', { name: '登録する' }).click();
  await hq.getByTestId('patient-P-001').getByRole('button', { name: '搬送を依頼する' }).click();
  const tf = hq.getByRole('form', { name: '搬送を依頼する' });
  await tf.getByLabel(/^到着先/).selectOption({ label: '手術室' });
  await tf.getByRole('button', { name: '搬送を依頼する' }).click();

  // 手術室の部署役が、参加者の記録した依頼に返事をする
  await expect(inbox.locator('.radio-row', { hasText: 'T-001' })).toContainText('受け入れできます', { timeout: 30_000 });
  await hq.screenshot({ path: 'test-results/training-running.png', fullPage: true });

  // 訓練を終えると振り返りが出る（了承をボードに記録しなかったことが「記録がない」として出る）
  await hq.getByRole('tab', { name: /訓練/ }).click();
  await hq.getByRole('button', { name: '訓練を終える' }).click();
  await hq.getByRole('button', { name: '終了する' }).click();
  const review = hq.getByTestId('review');
  await expect(review).toBeVisible({ timeout: 10_000 });
  await expect(review.getByTestId('check-register-red')).toContainText('満たした');
  // 途中で終えたので、まだ起きていない場面の確認項目は「満たしていない」ではなく「起きなかった」と出す
  await expect(review.getByTestId('check-duplicate-tag')).toContainText('訓練の時間内に起きなかった');
  await expect(review.getByTestId('check-transport-ack')).toContainText('満たしていない');
  const notAccepted = review.locator('.finding', { hasText: 'T-001 の受け入れ了承が記録されていない' });
  await expect(notAccepted).toContainText('記録がない');
  await expect(notAccepted).toContainText('根拠：T-001');
  await expect(review).toContainText('決まった文（mock）');

  // 補足を残せる
  await notAccepted.getByRole('button', { name: '補足を書く' }).click();
  await notAccepted.getByLabel(/補足/).fill('手術室に電話で確認していた');
  await notAccepted.getByRole('button', { name: '補足を残す' }).click();
  await expect(notAccepted).toContainText('参加者の補足：手術室に電話で確認していた');
  await hq.screenshot({ path: 'test-results/training-review.png', fullPage: true });

  // 実運用の記録には、訓練で入力した患者は入らない
  const live = await (await hq.request.get('/api/h/claude/live/events')).json();
  expect(live.events.some((e: { payload: { tagNumber?: string; features?: string } }) => e.payload.features === '紺の作業着')).toBe(false);
});
