import { expect, test, type Page } from '@playwright/test';

// 患者の登録内容の訂正と、同じ患者の統合。どちらも元の記録を消さずに追記で残す

async function register(page: Page, tag: string, location: string, features: string): Promise<string> {
  const form = page.getByRole('form', { name: '患者を登録する' });
  const before = Number((await page.getByTestId('patient-count').innerText()).replace('人', ''));
  await form.locator('label.triage-choice', { hasText: '黄' }).click();
  await form.getByLabel(/所在/).selectOption({ label: location });
  await form.getByLabel('タッグ番号').fill(tag);
  await form.getByLabel(/特徴メモ/).fill(features);
  await form.getByRole('button', { name: '登録する' }).click();
  // 前の登録の知らせを読まないよう、人数が増えるのを待つ
  await expect(page.getByTestId('patient-count')).toHaveText(`${before + 1}人`);
  return (await page.getByTestId('notice').filter({ hasText: 'を登録しました' }).innerText()).match(/P-\d+/)![0];
}

test('登録内容を理由つきで直し、同じ患者だった2件をまとめる', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await hq.goto('/?hospital=claude&terminal=hq');
  await expect(hq.getByTestId('sync-status')).toContainText('同期中');
  await hq.getByRole('button', { name: /青木 はるか/ }).click();
  await hq.getByRole('tab', { name: /^(▼ )?患者/ }).click();

  // 聞き間違いでタッグ番号と場所を誤って登録した
  const a = await register(hq, '610', '講堂', '緑のリュック');
  const row = hq.getByTestId(`patient-${a}`);
  await row.getByRole('button', { name: '登録内容を直す' }).click();
  const form = row.getByRole('form', { name: `${a} の登録内容を直す` });
  await expect(form.getByRole('button', { name: '直して記録する' })).toBeDisabled();
  await form.getByLabel('タッグ番号').fill('616');
  await form.getByLabel(/^所在/).selectOption({ label: '外来ホール' });
  await expect(form).toContainText('理由を書くと記録できます');
  await form.getByLabel(/直す理由/).fill('無線の聞き間違い');
  await form.getByRole('button', { name: '直して記録する' }).click();
  await expect(row).toContainText('616');
  await expect(row).toContainText('外来ホール');
  await expect(row).toContainText('登録内容を1回訂正：無線の聞き間違い');

  // 別々に登録された2件が同じ人だった
  const b = await register(hq, '620', '外来ホール', '赤い帽子、60代');
  const c = await register(hq, '', '外来ホール', '赤い帽子');
  const keep = hq.getByTestId(`patient-${b}`);
  await keep.getByRole('button', { name: '同じ患者としてまとめる' }).click();
  const mf = keep.getByRole('form', { name: `${b} に同じ患者をまとめる` });
  await mf.getByLabel(/まとめる患者/).selectOption({ value: c });
  await expect(mf).toContainText('残す');
  await mf.getByLabel(/同じ人だと分かった理由/).fill('付き添いの家族が同じ人だと確認');
  await mf.getByRole('button', { name: `${c} を ${b} にまとめる` }).click();
  await expect(hq.getByTestId('notice')).toContainText(`${c} を ${b} にまとめました`);
  await expect(hq.getByTestId(`patient-${c}`)).toHaveCount(0);
  await expect(keep).toContainText(`${c} をこの患者にまとめた`);

  // クロノロジーには、訂正と統合が元の記録とともに残る
  await hq.getByRole('tab', { name: /クロノロジー/ }).click();
  const table = hq.getByTestId('chrono-table');
  await expect(table).toContainText('登録内容を訂正：タッグ番号→616、所在→外来ホール（理由：無線の聞き間違い）');
  await expect(table).toContainText(`${c} を ${b} にまとめた（同じ患者。理由：付き添いの家族が同じ人だと確認）`);
  await expect(table).toContainText('タッグ610');
});
