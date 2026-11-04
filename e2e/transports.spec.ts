import { expect, test, type Browser, type Page } from '@playwright/test';

// 搬送：本部と手術室の2端末で、調整（依頼したこと）と事実（起きたこと）を記録し、互いに即時に反映されることを確かめる

async function openTerminal(browser: Browser, terminal: string, staffName: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/?terminal=${terminal}`);
  await expect(page.getByTestId('sync-status')).toContainText('同期中');
  await page.getByRole('button', { name: new RegExp(staffName) }).click();
  await expect(page.getByTestId('entered-by')).toHaveText(staffName);
  return page;
}

async function tab(page: Page, name: string) {
  await page.getByRole('tab', { name: new RegExp(name) }).click();
}

/** 患者を登録して管理番号を返す */
async function register(page: Page, tag: string, triage: string, location: string): Promise<string> {
  await tab(page, '患者');
  const form = page.getByRole('form', { name: '患者を登録する' });
  await form.locator('label.triage-choice', { hasText: triage }).click();
  await form.getByLabel(/所在/).selectOption({ label: location });
  await form.getByLabel('タッグ番号').fill(tag);
  await form.getByRole('button', { name: '登録する' }).click();
  const text = await page.getByTestId('notice').filter({ hasText: 'を登録しました' }).innerText();
  return text.match(/P-\d+/)![0];
}

/** 患者一覧の「搬送を依頼する」から搬送を依頼して搬送番号を返す */
async function requestTransport(page: Page, patientId: string, to: string, opts: { override?: string } = {}): Promise<string> {
  await tab(page, '患者');
  await page.getByTestId(`patient-${patientId}`).getByRole('button', { name: '搬送を依頼する' }).click();
  const form = page.getByRole('form', { name: '搬送を依頼する' });
  await expect(form.getByLabel(/^患者/)).toHaveValue(patientId);
  await form.getByLabel(/^到着先/).selectOption({ label: to });
  await form.locator('label.chip', { hasText: 'ストレッチャー' }).click();
  await form.getByLabel('付き添いの看護師の人数').selectOption('1');
  await form.getByRole('button', { name: '搬送を依頼する' }).click();
  if (opts.override) {
    const dialog = page.getByRole('dialog', { name: '確認してください' });
    await expect(dialog).toContainText('すでに進行中の搬送があります');
    await dialog.getByLabel(opts.override).check();
    await dialog.getByRole('button', { name: '2件目の搬送として依頼する' }).click();
  }
  const text = await page.getByTestId('notice').filter({ hasText: '搬送依頼を記録しました' }).innerText();
  return text.match(/T-\d+/)![0];
}

test('赤ゾーンから手術室への搬送を、要請から到着まで2端末で記録する', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const or = await openTerminal(browser, 'or', '田村 由紀');

  const patientId = await register(hq, '201', '赤', '救急外来');
  const t = await requestTransport(hq, patientId, '手術室');
  const card = hq.getByTestId(`transport-${t}`);
  await expect(card).toContainText('救急外来（赤ゾーン）');
  await expect(card).toContainText('手術室');
  await expect(card).toContainText('付き添い：看護師1人');
  await expect(card.getByTestId('step-accepted')).toContainText('未記録');
  await expect(card.getByTestId('step-acknowledged')).toContainText('未記録（省略可）');

  // 手術室の端末に届き、責任者の了承を記録する
  await tab(or, '搬送');
  const orCard = or.getByTestId(`transport-${t}`);
  await expect(orCard).toBeVisible({ timeout: 5000 });
  await orCard.getByRole('button', { name: '了承を記録' }).click();
  const accept = orCard.getByRole('form', { name: '受け入れ了承の記録' });
  await expect(accept.getByLabel(/判断した人/)).toHaveValue('position:or-lead');
  await accept.getByRole('button', { name: '了承を記録する' }).click();
  await expect(card.getByTestId('step-accepted')).toContainText('手術室責任者', { timeout: 5000 });

  // 本部：班で要員を割り当て、搬送調整担当として指示する
  await card.getByRole('button', { name: '要員を割り当てる' }).click();
  const assign = card.getByRole('form', { name: '搬送要員の割り当て' });
  await assign.getByRole('button', { name: /搬送A班/ }).click();
  await assign.getByRole('button', { name: '2人を割り当てる' }).click();
  await expect(card.getByTestId('step-staffAssigned')).toContainText('Ansel Whitcombe、Bianca Reyes');
  await expect(hq.getByTestId('transporter-tr-01')).toContainText(`割当済 ${t}`);

  await card.getByRole('button', { name: '指示を記録' }).click();
  const order = card.getByRole('form', { name: '指示の記録' });
  await order.getByLabel(/指示した人/).selectOption({ label: '搬送調整担当' });
  await order.getByRole('button', { name: '指示を記録する' }).click();
  await expect(card.getByTestId('step-ordered')).toContainText('搬送調整担当');

  // 出発（事実）：搬送中の一覧と患者の所在に出る
  await card.getByRole('button', { name: '出発を記録' }).click();
  await expect(hq.getByTestId(`moving-${t}`)).toContainText('救急外来（赤ゾーン）');
  await expect(hq.getByTestId(`moving-${t}`)).toContainText('手術室');
  await expect(hq.getByTestId('transporter-tr-02')).toContainText(`移動中 ${t}`);
  await hq.screenshot({ path: 'test-results/transport-moving.png', fullPage: true });
  await tab(hq, '患者');
  await expect(hq.getByTestId(`patient-${patientId}`)).toContainText('搬送中（救急外来→手術室）');

  // 手術室で到着（＝引き渡し）を記録すると、本部の画面で所在が移り、要員は待機に戻る
  // 無線で受けた報告として、報告元と現場の確認時刻もいっしょに記録する
  await orCard.getByText('無線・電話で受けた報告のとき').click();
  await orCard.getByLabel('報告した人').fill('搬送A班');
  await orCard.getByRole('button', { name: '到着を記録' }).click();
  await expect(hq.getByTestId(`patient-${patientId}`)).toContainText('手術室', { timeout: 5000 });
  await expect(hq.getByTestId(`patient-${patientId}`)).not.toContainText('搬送中');
  await tab(hq, '搬送');
  await expect(hq.getByTestId('transporter-tr-01')).toContainText('待機');
  await expect(hq.getByTestId('transporter-tr-01')).toContainText('最後の到着先：手術室');
  await expect(hq.getByTestId(`moving-${t}`)).toHaveCount(0);

  const { events } = await (await hq.request.get('/api/live/events')).json();
  const arrival = events.findLast((e: { type: string; subject: { id: string } }) => e.type === 'TransportArrived' && e.subject.id === t);
  expect(arrival).toMatchObject({ terminal: 'or', enteredBy: 'or-01', reportedBy: { name: '搬送A班' }, payload: { handover: true } });
});

test('同じ患者への2件目の搬送と、稼働中の要員への割り当ては警告し、理由を記録すれば実行できる', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const patientId = await register(hq, '202', '黄', '外来ホール');
  const first = await requestTransport(hq, patientId, '3階東病棟');
  const second = await requestTransport(hq, patientId, '4階東病棟', { override: '本部の指示による' });
  expect(second).not.toBe(first);
  await expect(hq.getByTestId(`transport-${second}`)).toContainText('警告を承知で記録：本部の指示による');

  const assign = async (t: string) => {
    const card = hq.getByTestId(`transport-${t}`);
    await card.getByRole('button', { name: '要員を割り当てる' }).click();
    const form = card.getByRole('form', { name: '搬送要員の割り当て' });
    await form.getByRole('group', { name: '搬送要員を1人ずつ選ぶ' }).getByRole('button', { name: /Carter Lowell/ }).click();
    await form.getByRole('button', { name: '1人を割り当てる' }).click();
  };
  await assign(first);
  await assign(second);
  const dialog = hq.getByRole('dialog', { name: '確認してください' });
  await expect(dialog).toContainText(`Carter Lowell（${first}で割当済）`);
  await dialog.getByLabel('本部の指示による').check();
  await dialog.getByRole('button', { name: '稼働中でも割り当てる' }).click();
  await expect(hq.getByTestId(`transport-${second}`).getByTestId('step-staffAssigned')).toContainText('Carter Lowell');
});

test('調整が未記録のまま到着した搬送は「出発未記録」と示し、到着は取り消せる', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  const patientId = await register(hq, '203', '緑', '講堂');
  const t = await requestTransport(hq, patientId, '外来ホール（黄ゾーン）');
  const card = hq.getByTestId(`transport-${t}`);
  await card.getByRole('button', { name: '到着を記録' }).click();
  await expect(hq.getByTestId('notice')).toContainText(`${t} の到着を記録しました`);
  const closed = hq.locator('details.closed-transports');
  await closed.locator('summary').click();
  await expect(closed.getByTestId(`transport-${t}`)).toContainText('出発未記録');
  await expect(closed.getByTestId(`transport-${t}`).getByTestId('step-accepted')).toContainText('未記録');

  // 押し間違えた到着は「元に戻す」で取り消せる（訂正イベント）
  await hq.getByTestId('notice').getByRole('button', { name: '元に戻す' }).click();
  await expect(hq.getByTestId('notice')).toContainText('到着の記録を取り消しました');
  await expect(hq.getByTestId('transport-list').getByTestId(`transport-${t}`)).toBeVisible();
  await tab(hq, '患者');
  await expect(hq.getByTestId(`patient-${patientId}`)).toContainText('講堂');
});

test('院内の状況：受け入れ可否と人数を確認時刻つきで記録し、未確認と0を区別する', async ({ browser }) => {
  const hq = await openTerminal(browser, 'hq', '青木 はるか');
  await tab(hq, '院内の状況');
  const ward = hq.getByTestId('location-ward-5w');
  await expect(ward.getByTestId('accepting')).toHaveText('未確認');
  await expect(ward).toContainText('〔無線〕端末なし');
  await expect(hq.getByTestId('attention-list')).toContainText('5階西病棟');
  await expect(ward.getByTestId('capacity-yellow')).toContainText('設定の初期値・未確認');

  await ward.getByRole('button', { name: '状況の報告を記録' }).click();
  const form = ward.getByRole('form', { name: '5階西病棟の状況の報告' });
  await form.locator('label.chip', { hasText: '受け入れ不可' }).click();
  await form.getByLabel('黄の受け入れ可能人数', { exact: true }).fill('0');
  await form.getByLabel('看護師の人数', { exact: true }).fill('４'); // 全角でも入る
  await form.getByRole('button', { name: '医師の人数を未確認として記録' }).click();
  await form.getByText('報告した人・現場で確認した時刻').click();
  await form.getByLabel('報告した人').fill('病棟リーダー');
  await form.getByRole('button', { name: '報告を記録する' }).click();

  await expect(ward.getByTestId('accepting')).toContainText('✕ 受け入れ不可');
  await expect(ward.getByTestId('accepting')).toContainText('確認');
  await expect(ward.getByTestId('capacity-yellow')).toContainText('0人');
  await expect(ward.getByTestId('capacity-yellow')).not.toContainText('設定の初期値');
  await expect(ward).toContainText('看護師 4人');
  await expect(ward).toContainText('医師 未確認（');
  await expect(ward).toContainText('技師 未確認'); // 報告のない職種も「未確認」と出る
  await expect(hq.getByTestId('attention-list')).not.toContainText('5階西病棟');
  await hq.screenshot({ path: 'test-results/locations.png', fullPage: true });
});
