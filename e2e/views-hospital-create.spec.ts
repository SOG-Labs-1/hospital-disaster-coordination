import { expect, test } from '@playwright/test';

// 病院を作る画面：段階ごとに入力し、作った病院でそのまま記録できる

test('病院を作り、作った病院の端末で入力を始められる', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/?hospital=');
  await page.getByRole('link', { name: '＋ 病院を作る' }).click();
  await expect(page.getByRole('heading', { name: '病院を作る' })).toBeVisible();
  const next = page.getByRole('button', { name: '次へ →' });

  // 1. 基本：架空の確認がないと進めない
  await page.getByLabel(/病院名/).fill('作成テスト病院(仮)');
  await expect(next).toBeDisabled();
  await expect(page.locator('.create-problems')).toContainText('架空の病院です');
  await page.getByLabel(/架空の病院です/).check();
  await next.click();

  // 2. 場所
  await page.getByRole('button', { name: '＋ 場所を足す' }).click();
  const row = page.getByTestId('create-location-1');
  await row.getByLabel('場所の名前').fill('処置室');
  await row.getByLabel('種類').selectOption({ label: '救急外来・処置室' });
  await row.getByLabel('処置室の赤の受け入れ枠').fill('2');
  await next.click();

  // 3. 用途：赤ゾーンを処置室に置く
  await page.locator('fieldset', { hasText: '赤ゾーン' }).getByRole('button', { name: '処置室' }).click();
  await next.click();

  // 4. 役職（そのまま）→ 5. 入力者
  await next.click();
  await expect(next).toBeDisabled();
  await page.getByRole('button', { name: '＋ 入力者を足す' }).click();
  const staff = page.getByTestId('create-staff-0');
  await staff.getByLabel('フルネーム').fill('架空 作成');
  await staff.getByLabel('職種').selectOption({ label: '事務' });
  await next.click();

  // 6. 確認して作る
  await expect(page.locator('.create-summary')).toContainText('処置室（救急外来・処置室・端末あり・受け入れ枠 赤2人）');
  await expect(page.locator('.create-summary')).toContainText('赤ゾーン：処置室');
  await page.getByRole('button', { name: 'この内容で病院を作る' }).click();

  // 作った病院の端末の場所を選ぶ画面になる
  await expect(page.getByText('病院：作成テスト病院(仮)')).toBeVisible();
  await page.getByRole('button', { name: '災害対策本部' }).click();
  await page.getByRole('button', { name: /架空 作成/ }).click();
  await page.getByRole('tab', { name: /院内の状況/ }).click();
  await expect(page.getByTestId('location-loc-2').getByRole('heading')).toHaveText('処置室（赤ゾーン）');
  await page.getByRole('tab', { name: /^(▼ )?患者/ }).click();
  const form = page.getByRole('form', { name: '患者を登録する' });
  await form.getByLabel(/所在/).selectOption({ label: '処置室' });
  await form.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByTestId('notice')).toContainText('P-001 を登録しました');
});
