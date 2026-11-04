import { expect, test } from '@playwright/test';

// 一覧にない入力者をその場で追加する／場所の用途（ゾーン）を画面から変える

test('一覧にない名前を追加して入力を始め、ほかの端末の一覧にも出る', async ({ browser }) => {
  const er = await (await browser.newContext()).newPage();
  await er.goto('/?hospital=claude&terminal=er');
  await expect(er.getByTestId('sync-status')).toContainText('同期中');
  await er.getByRole('button', { name: /一覧にない名前を追加する/ }).click();
  const form = er.getByRole('form', { name: '入力者の追加' });
  await expect(form.getByTestId('add-staff-location')).toContainText('救急外来'); // 場所は端末の場所（選ばない）
  await expect(form.getByRole('button', { name: '追加して入力を始める' })).toBeDisabled();
  await form.getByLabel(/フルネーム/).fill('架空 一花');
  await form.getByLabel(/職員番号/).fill('E-0701');
  await form.locator('label.chip', { hasText: '看護師' }).click();
  await form.getByRole('button', { name: '追加して入力を始める' }).click();
  await expect(er.getByTestId('entered-by')).toHaveText('架空 一花');

  // 追加した入力者で記録でき、ほかの端末の名前の一覧にも出る
  await er.getByRole('tab', { name: /^(▼ )?患者/ }).click();
  const reg = er.getByRole('form', { name: '患者を登録する' });
  await reg.getByLabel('タッグ番号').fill('701');
  await reg.getByRole('button', { name: '登録する' }).click();
  await expect(er.getByTestId('notice')).toContainText('を登録しました');
  const hq = await (await browser.newContext()).newPage();
  await hq.goto('/?hospital=claude&terminal=hq');
  await hq.getByRole('button', { name: 'ほかの場所の職員も表示する' }).click();
  await expect(hq.getByRole('button', { name: /架空 一花/ })).toBeVisible();

  // 同じ職員番号での追加は警告する
  await hq.getByRole('button', { name: /一覧にない名前を追加する/ }).click();
  const f2 = hq.getByRole('form', { name: '入力者の追加' });
  await f2.getByLabel(/フルネーム/).fill('架空 二花');
  await f2.getByLabel(/職員番号/).fill('E-0701');
  await f2.locator('label.chip', { hasText: '事務' }).click();
  await f2.getByRole('button', { name: '追加して入力を始める' }).click();
  await expect(hq.getByRole('dialog', { name: '確認してください' })).toContainText('同じ名前または職員番号の入力者がすでにいます（架空 一花）');
});

test('講堂に黄ゾーンを足すと、院内の状況と掲示用画面の表示が変わる', async ({ browser }) => {
  const hq = await (await browser.newContext()).newPage();
  await hq.goto('/?hospital=claude&terminal=hq');
  await hq.getByRole('button', { name: /青木 はるか/ }).click();
  await hq.getByRole('tab', { name: /院内の状況/ }).click();
  const card = hq.getByTestId('location-auditorium');
  await expect(card.getByRole('heading')).toHaveText('講堂（緑ゾーン）');
  await card.getByRole('button', { name: '用途（ゾーン）を変える' }).click();
  const form = card.getByRole('form', { name: '講堂の用途の変更' });
  await form.getByRole('button', { name: /黄ゾーン/ }).click();
  await form.getByLabel(/メモ/).fill('黄の患者が増えたため');
  await form.getByRole('button', { name: '用途を変える' }).click();
  await expect(card.getByRole('heading')).toHaveText('講堂（緑ゾーン・黄ゾーン）');

  const board = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await board.goto('/?hospital=claude&view=board');
  await expect(board.getByTestId('board-place-auditorium')).toContainText('講堂（緑ゾーン・黄ゾーン）');

  await hq.getByRole('tab', { name: /対応記録/ }).click();
  await expect(hq.getByTestId('chrono-table')).toContainText('用途を変更：緑ゾーン・黄ゾーン（黄の患者が増えたため）');
});
