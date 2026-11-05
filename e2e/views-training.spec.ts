import { expect, test } from '@playwright/test';
import { clickAction } from './helpers';

// 訓練モード（mock の部署役）を、開始から振り返りまで通す。
// 「このツールを使った訓練」：部署（救急外来・手術室・病棟）は端末で記録するので、患者や受け入れの返事は本部のボードに入ってくる。
// 本部（参加者）は搬送と支援要請を調整し、無線でやりとりするのは搬送要員だけ

test('訓練を始めると部署の記録がボードに入り、搬送を調整して搬送要員と無線でやりとりし、終えて振り返る', async ({ browser }) => {
  test.setTimeout(120_000);
  const hq = await (await browser.newContext()).newPage();
  await hq.goto('/?hospital=claude&terminal=hq&mode=training');
  await expect(hq.getByTestId('mode-badge')).toHaveText(/訓練/);
  await hq.getByRole('button', { name: /青木 はるか/ }).click();

  // シナリオを選んで始め、2倍速にする
  await hq.getByRole('tab', { name: /訓練/ }).click();
  const scenario = hq.getByTestId('scenario-claude-red-to-or');
  await expect(scenario).toContainText('赤ゾーンから手術室へ');
  await expect(scenario).toContainText('搬送要員（佐藤）（無線）');
  await scenario.getByRole('button', { name: 'この訓練を選ぶ' }).click();
  await scenario.getByRole('button', { name: 'この訓練を始める' }).click();
  await expect(hq.getByTestId('training-run')).toContainText('進行中');
  await hq.getByRole('button', { name: /2倍速/ }).click();
  await expect(hq.getByTestId('training-run')).toContainText('2倍速');
  // 無線で連絡できるのは搬送要員だけ
  await expect(hq.getByRole('heading', { name: '搬送要員へ無線で連絡する' })).toBeVisible();

  // 救急外来の端末から、運ばれてきた患者が登録される（無線では届かない）
  await hq.getByRole('tab', { name: /^(● )?患者/ }).click();
  const p1 = hq.getByTestId('patient-P-001');
  await expect(p1).toContainText('紺の作業着', { timeout: 30_000 });
  await expect(hq.getByTestId('radio-inbox')).toContainText('聞いていない 0件');

  // 本部が手術室への搬送を依頼する → 手術室の部署役が判断し、手術室の端末から了承が記録される
  await p1.getByRole('button', { name: '搬送を依頼する' }).click();
  const tf = hq.getByRole('form', { name: '搬送を依頼する' });
  await tf.getByLabel(/^到着先/).selectOption({ label: '手術室' });
  await tf.getByRole('button', { name: '搬送を依頼する' }).click();
  await hq.getByRole('tab', { name: /搬送/ }).click();
  const card = hq.getByTestId('transport-T-001');
  await expect(card).toContainText('了承済み', { timeout: 30_000 });
  await expect(card).toContainText('手術室責任者');

  // 搬送要員に無線で指示する → 「出発しました」が無線で届く。聞いて出発を記録する
  await hq.getByRole('tab', { name: /訓練/ }).click();
  await hq.getByRole('form', { name: '部署への連絡' }).getByLabel('伝えること').fill('T-001、救急外来から手術室へお願いします');
  await hq.getByRole('button', { name: '無線で伝える' }).click();
  const inbox = hq.getByTestId('radio-inbox');
  await expect(inbox.locator('.radio-row', { hasText: '出発しました' })).toContainText('搬送要員（佐藤）', { timeout: 30_000 });
  await hq.getByRole('tab', { name: /搬送/ }).click();
  await clickAction(card, '出発を記録');
  await hq.screenshot({ path: 'test-results/training-running.png', fullPage: true });

  // 訓練を終えると振り返りが出る（受領確認を取らなかったことなどが出る）
  await hq.getByRole('tab', { name: /訓練/ }).click();
  await hq.getByRole('button', { name: '訓練を終える' }).click();
  await hq.getByRole('button', { name: '終了する' }).click();
  const review = hq.getByTestId('review');
  await expect(review).toBeVisible({ timeout: 10_000 });
  await expect(review.getByTestId('check-request-red')).toContainText('満たした');
  await expect(review.getByTestId('check-departure-recorded')).toContainText('満たした');
  await expect(review.getByTestId('check-transport-ack')).toContainText('満たしていない');
  // 途中で終えたので、まだ起きていない場面の確認項目は「満たしていない」ではなく「起きなかった」と出す
  await expect(review.getByTestId('check-support-dispatched')).toContainText('訓練の時間内に起きなかった');
  const noAck = review.locator('.finding', { hasText: 'T-001 の指示の受領確認がない' });
  await expect(review).toContainText('決まった文（mock）');

  // 補足を残せる
  const target = (await noAck.count()) ? noAck : review.locator('.finding').first();
  await target.getByRole('button', { name: '補足を書く' }).click();
  await target.getByLabel(/補足/).fill('手術室に電話で確認していた');
  await target.getByRole('button', { name: '補足を残す' }).click();
  await expect(target).toContainText('参加者の補足：手術室に電話で確認していた');
  await hq.screenshot({ path: 'test-results/training-review.png', fullPage: true });

  // 災害運用の記録には、訓練で入力した患者は入らない
  const live = await (await hq.request.get('/api/h/claude/live/events')).json();
  expect(live.events.some((e: { payload: { tagNumber?: string; features?: string } }) => e.payload.features === '紺の作業着')).toBe(false);
});
