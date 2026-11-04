import { expect, test } from '@playwright/test';

// 対応記録：すべての記録が時刻順に並び、取り消しも消さずに印を付けて残る。連絡メモを残せる

test('記録が時刻順に並び、取り消し・連絡メモ・入力の遅れが分かる', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await hq.goto('/?terminal=hq');
  await expect(hq.getByTestId('sync-status')).toContainText('つながっています');
  await hq.getByRole('button', { name: /青木 はるか/ }).click();
  await hq.getByRole('tab', { name: /^(● )?患者/ }).click();

  // 患者を登録し、区分を変えてから「元に戻す」で取り消す
  const form = hq.getByRole('form', { name: '患者を登録する' });
  await form.locator('label.triage-choice', { hasText: '緑' }).click();
  await form.getByLabel(/所在/).selectOption({ label: '講堂' });
  await form.getByLabel('タッグ番号').fill('401');
  await form.getByLabel(/特徴メモ/).fill('杖を持っている');
  await form.getByRole('button', { name: '登録する' }).click();
  const patientId = (await hq.getByTestId('notice').filter({ hasText: 'を登録しました' }).innerText()).match(/P-\d+/)![0];
  const row = hq.getByTestId(`patient-${patientId}`);
  await row.getByRole('button', { name: '区分を変える' }).click();
  await row.getByRole('group', { name: `${patientId} の区分を変える` }).getByRole('button', { name: /黄/ }).click();
  await hq.getByTestId('notice').getByRole('button', { name: '元に戻す' }).click();
  await expect(hq.getByTestId('notice')).toContainText('戻しました');

  // 5分前に無線で受けた連絡を、関係する患者の番号つきで残す
  await hq.getByRole('tab', { name: /対応記録/ }).click();
  const msg = hq.getByRole('form', { name: '連絡メモを残す' });
  await msg.getByLabel('発信元').selectOption({ label: '講堂' });
  await msg.getByLabel(/^内容/).fill('講堂の患者が歩いて外来ホールへ移りたいと言っている');
  await msg.getByLabel(/関係する番号/).fill(patientId.toLowerCase());
  const t = new Date(Date.now() - 5 * 60000);
  await msg.getByLabel(/連絡を受けた時刻/).fill(`${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`);
  await msg.getByRole('button', { name: '連絡メモを記録する' }).click();
  await expect(hq.getByTestId('notice')).toContainText('連絡メモ M-');

  const table = hq.getByTestId('chrono-table');
  await expect(table).toContainText(`患者を登録：●緑　講堂　タッグ401　特徴：杖を持っている`);
  await expect(table.locator('tr', { hasText: '区分を▲黄に変更' }).filter({ hasText: patientId })).toContainText('〔取り消し済み〕');
  await expect(table).toContainText(`${patientId} の「区分の変更」を取り消し`);
  const message = table.locator('tr', { hasText: '講堂の患者が歩いて' });
  await expect(message).toContainText(`［${patientId}］`);
  await expect(message).toContainText('分後）'); // 確認から入力までの遅れ
  await expect(message).toContainText('講堂'); // 報告元

  // 対象の番号で絞り込むと、その患者に関係する記録だけになる（連絡メモも含む）
  await table.locator('tr', { hasText: '患者を登録：●緑　講堂　タッグ401' }).getByRole('button', { name: patientId }).click();
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(4); // 登録・区分の変更・取り消し・連絡メモ
  await hq.getByRole('group', { name: '種類で絞り込む' }).getByRole('button', { name: /^(✓ )?連絡$/ }).click();
  await expect(rows).toHaveCount(1);
  await hq.screenshot({ path: 'test-results/chronology.png', fullPage: true });
});
