// 紹介映像（30秒・3分）に差し込む「実際の画面の録画」を撮る。
//
//   npx tsx video/capture/record.ts            # a〜k をすべて撮る（i は除く。i は下の CAPTURE_AI を参照）
//   npx tsx video/capture/record.ts c e        # 一部だけ撮り直す（データは毎回入れ直す）
//   CAPTURE_AI=anthropic npx tsx video/capture/record.ts i   # 訓練を本物の Claude API で撮る（費用がかかる。利用者の了承を得てから）
//
// - 録画専用のポート（サーバー 4200、画面 5175）と保存先（video/.capture-data）で起動し、終わったら止める。
//   通常の data/ と e2e/.tmp には書き込まない。
// - データは scripts/demo/seed.ts の架空データのみ。訓練の部署役は既定で AI_PROVIDER=mock（Claude API は使わない）。
//   CAPTURE_AI=anthropic のときだけ Claude API を使う（モデルは .env の ANTHROPIC_MODEL。サーバーが読む）。
// - Playwright の録画（recordVideo）は画質が低く、操作の前の準備も写るため、
//   Chrome の画面配信（CDP の screencast）でコマを受け取り、必要な区間だけを 30fps の webm（VP9）にする。
//   エンコードには Playwright に同梱の ffmpeg を使う（mp4 は書けないため webm）。

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { versionOf } from '@hdc/shared';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from '@playwright/test';

const root = join(import.meta.dirname, '../..');
const SERVER_PORT = 4200;
const WEB_PORT = 5175;
const API = `http://localhost:${SERVER_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const DATA_DIR = join(root, 'video/.capture-data');
const OUT_DIR = join(root, 'video/public/captures');
const FPS = 30;

// 1440×810 の画面を 4/3 倍の密度で描き、1920×1080 のコマとして受け取る（文字が大きく、くっきり写る）
const VIEW = { width: 1440, height: 810 };
const SCALE = 4 / 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- サーバーと画面の起動 ----------------

const children: ChildProcess[] = [];

function start(cmd: string, args: string[], env: Record<string, string>, name: string) {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => process.env.CAPTURE_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr!.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
}

function stopAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid!, 'SIGTERM');
    } catch {
      /* すでに止まっている */
    }
  }
}

async function waitFor(url: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) return;
    await sleep(300);
  }
  throw new Error(`${url} が起動しない`);
}

async function portInUse(port: number) {
  return fetch(`http://localhost:${port}`).then(() => true).catch(() => false);
}

// ---------------- 録画（CDP screencast → webm） ----------------

function ffmpegPath(): string {
  const dir = join(homedir(), 'Library/Caches/ms-playwright');
  const ff = readdirSync(dir).filter((d) => d.startsWith('ffmpeg-')).sort().pop();
  const candidates = ff ? ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg-win64.exe'].map((f) => join(dir, ff, f)) : [];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Playwright の ffmpeg が見つからない（npx playwright install ffmpeg）');
  return found;
}

interface Frame {
  t: number; // ミリ秒（壁時計）
  data: Buffer;
}

class Recorder {
  private frames: Frame[] = [];
  private cdp?: CDPSession;
  constructor(readonly page: Page) {}

  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      this.frames.push({ t: (metadata.timestamp ?? Date.now() / 1000) * 1000, data: Buffer.from(data, 'base64') });
      this.cdp!.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    await sleep(300);
    // 動きのない画面ではコマが届かず、最初のコマが黒いことがあるので、見えない変化で描き直させる
    await this.page.evaluate(() => {
      const d = document.createElement('div');
      Object.assign(d.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0.01' });
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 100);
    });
    await sleep(400);
    this.startedAt = Date.now();
    return this.startedAt;
  }
  startedAt = 0;

  /** from〜to（壁時計のミリ秒）の区間を 30fps の webm にする */
  async save(file: string, range: { from?: number; to?: number } = {}) {
    await this.cdp!.send('Page.stopScreencast');
    const frames = this.frames;
    if (!frames.length) throw new Error(`${file}: コマが取れなかった`);
    const from = Math.max(range.from ?? this.startedAt, frames[0]!.t);
    const to = range.to ?? Date.now();
    // 画面が変わったときだけコマが届くので、等間隔のコマに並べ直す（直前のコマをくり返す）
    const out: Buffer[] = [];
    let i = 0;
    for (let t = from; t <= to; t += 1000 / FPS) {
      while (i + 1 < frames.length && frames[i + 1]!.t <= t) i++;
      out.push(frames[i]!.data);
    }
    await encode(out, file);
    return out.length / FPS;
  }
}

function encode(jpegs: Buffer[], file: string) {
  // 同梱の ffmpeg は標準入力（pipe:）を読めないので、JPEG を1つのファイルに連結して image2pipe として読ませる
  const tmp = `${file}.frames.mjpeg`;
  writeFileSync(tmp, Buffer.concat(jpegs));
  return new Promise<void>((resolve, reject) => {
    const ff = spawn(ffmpegPath(), [
      '-y', '-loglevel', 'error',
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', `file:${tmp}`,
      '-vf', 'scale=1920:1080:flags=lanczos,format=yuv420p',
      '-c:v', 'libvpx-vp9', '-crf', '16', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1',
      file,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    ff.on('error', reject);
    ff.on('close', (code) => {
      rmSync(tmp, { force: true });
      code === 0 ? resolve() : reject(new Error(`ffmpeg が失敗した（${code}）: ${file}`));
    });
  });
}

// ---------------- ゆっくり見せる操作 ----------------

// 録画に写るマウスの印（ヘッドレスでは本物のカーソルが写らないため）
const cursorScript = () => {
  addEventListener('DOMContentLoaded', () => {
    if (new URLSearchParams(location.search).get('view') === 'board') return;
    const c = document.createElement('div');
    c.id = '__capture-cursor';
    Object.assign(c.style, {
      position: 'fixed', left: '70%', top: '85%', width: '34px', height: '34px', marginLeft: '-17px', marginTop: '-17px',
      borderRadius: '50%', border: '4px solid #0b5cad', background: 'rgba(11,92,173,0.18)', boxShadow: '0 0 0 3px #fff',
      zIndex: '2147483647', pointerEvents: 'none', transition: 'left 600ms ease-in-out, top 600ms ease-in-out, transform 150ms',
    });
    document.body.appendChild(c);
  });
};

// 録画に写したマウスの印の位置（1920×1080 の座標、壁時計のミリ秒）。映像で押した所を拡大・強調するために、クリップと一緒に JSON で保存する
type CursorEvent = { t: number; x: number; y: number; press?: boolean };
const cursorLog = new WeakMap<Page, CursorEvent[]>();
function logCursor(page: Page, e: Omit<CursorEvent, 't'>) {
  const k = 1920 / (page.viewportSize()?.width ?? VIEW.width);
  const list = cursorLog.get(page) ?? [];
  list.push({ t: Date.now(), x: Math.round(e.x * k), y: Math.round(e.y * k), ...(e.press ? { press: true } : {}) });
  cursorLog.set(page, list);
}

async function moveCursor(page: Page, target: Locator) {
  // 見えていれば動かさない（画面が揺れないように）
  const moved = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.top >= 100 && r.bottom <= innerHeight - 20) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  });
  if (moved) await sleep(600);
  const box = await target.boundingBox();
  if (!box) return;
  await page.evaluate(({ x, y }) => {
    const c = document.getElementById('__capture-cursor');
    if (c) Object.assign(c.style, { left: `${x}px`, top: `${y}px` });
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  logCursor(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await sleep(650);
}

async function press(page: Page) {
  const last = cursorLog.get(page)?.at(-1);
  if (last) logCursor(page, { x: last.x / (1920 / (page.viewportSize()?.width ?? VIEW.width)), y: last.y / (1920 / (page.viewportSize()?.width ?? VIEW.width)), press: true });
  await page.evaluate(() => {
    const c = document.getElementById('__capture-cursor');
    if (!c) return;
    c.style.transform = 'scale(0.7)';
    setTimeout(() => (c.style.transform = ''), 180);
  });
}

async function slowClick(page: Page, target: Locator, after = 500) {
  await moveCursor(page, target);
  await press(page);
  await target.click();
  await sleep(after);
}

async function slowType(page: Page, target: Locator, text: string) {
  await moveCursor(page, target);
  await press(page);
  await target.click();
  await target.pressSequentially(text, { delay: 140 });
  await sleep(300);
}

async function slowSelect(page: Page, target: Locator, label: string) {
  await moveCursor(page, target);
  await press(page);
  await target.selectOption(label); // 表示名か値のどちらかに合えばよい
  await sleep(500);
}

/** ページをなめらかにスクロールする（px/秒） */
async function smoothScrollTo(page: Page, y: number, ms: number) {
  await page.evaluate(({ y, ms }) => new Promise<void>((resolve) => {
    const start = scrollY;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      scrollTo(0, start + (y - start) * e);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  }), { y, ms });
}

// ---------------- 端末を開く ----------------

let browser: Browser;
const contexts: BrowserContext[] = [];

async function openPage(url: string, opts: { view?: { width: number; height: number }; scale?: number; noSync?: boolean } = {}) {
  const ctx = await browser.newContext({
    viewport: opts.view ?? VIEW,
    deviceScaleFactor: opts.scale ?? SCALE,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  contexts.push(ctx);
  // tsx（esbuild）が関数名を残すために入れる __name を、ページ内でも使えるようにする
  await ctx.addInitScript('window.__name = (f) => f;');
  await ctx.addInitScript(cursorScript);
  const page = await ctx.newPage();
  await page.goto(`${WEB}${url}`);
  if (!opts.noSync) await page.getByTestId('sync-status').filter({ hasText: 'つながっています' }).waitFor();
  // 見出しの書体（BIZ UDゴシック）が読み込まれてから撮る
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function openTerminal(terminal: string, staffName: string, mode: 'live' | 'training' = 'live', hospital = 'claude') {
  const page = await openPage(`/?hospital=${hospital}&terminal=${terminal}&mode=${mode}`);
  await page.getByRole('button', { name: new RegExp(staffName) }).click();
  await page.getByTestId('entered-by').filter({ hasText: staffName }).waitFor();
  return page;
}

async function tab(page: Page, name: RegExp) {
  await page.getByRole('tab', { name }).first().click();
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(400);
}

const PATIENT_TAB = /^(● )?患者/;

// ---------------- 各クリップ ----------------

interface Clip {
  id: string;
  file: string;
  title: string;
  note: string;
  seconds?: number;
}
const done: Clip[] = [];

async function finish(rec: Recorder, clip: Omit<Clip, 'seconds'>, range?: { from?: number; to?: number }) {
  const seconds = await rec.save(join(OUT_DIR, clip.file), range);
  done.push({ ...clip, seconds: Math.round(seconds * 10) / 10 });
  // マウスの印の位置（クリップの頭からの秒）。映像で押した所を拡大・強調するのに使う
  const from = range?.from ?? rec.startedAt;
  const events = (cursorLog.get(rec.page) ?? []).filter((e) => e.t >= from && (!range?.to || e.t <= range.to)).map((e) => ({ ...e, t: Math.round(e.t - from) / 1000 }));
  if (events.length) writeFileSync(join(OUT_DIR, clip.file.replace(/\.webm$/, '.cursor.json')), JSON.stringify(events) + '\n');
  console.log(`  ✓ ${clip.file}（${seconds.toFixed(1)}秒）`);
}

/** a. 患者の登録（タッグ番号・区分を選んで登録） */
async function clipA() {
  const page = await openTerminal('hq', '青木 はるか');
  await tab(page, PATIENT_TAB);
  const form = page.getByRole('form', { name: '患者を登録する' });
  const rec = new Recorder(page);
  await rec.start();
  await sleep(800);
  await slowClick(page, form.locator('label.triage-choice', { hasText: '黄' }));
  await slowSelect(page, form.getByLabel(/所在/), '外来ホール');
  await slowType(page, form.getByLabel('タッグ番号'), '106');
  await slowClick(page, form.getByRole('button', { name: '登録する' }), 0);
  await page.getByTestId('notice').filter({ hasText: 'を登録しました' }).waitFor();
  // 登録した患者（一覧の先頭）と通知が見えるよう上へ戻す
  await sleep(300);
  await smoothScrollTo(page, 0, 900);
  await moveCursor(page, page.getByTestId('patient-P-006'));
  await sleep(1800);
  await finish(rec, { id: 'a', file: 'a-register.webm', title: '患者の登録', note: '本部の端末で、区分「黄」・所在「外来ホール」・タッグ番号 106 を入れて登録。登録した P-006 が患者一覧の先頭に出るまで' });
}

/** b. 2台の端末：救急外来で登録した患者が、本部の一覧に再読み込みなしで出る（2台を同時に撮る） */
async function clipB() {
  const er = await openTerminal('er', '川口 直子');
  const hq = await openTerminal('hq', '青木 はるか');
  await tab(er, PATIENT_TAB);
  await tab(hq, PATIENT_TAB);
  // 本部は患者一覧の先頭が見えるように
  const list = hq.getByTestId('patient-count');
  await list.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await hq.evaluate(() => scrollBy(0, -120));
  const form = er.getByRole('form', { name: '患者を登録する' });
  const recEr = new Recorder(er);
  const recHq = new Recorder(hq);
  const from = Math.max(await recEr.start(), await recHq.start());
  await sleep(800);
  await slowClick(er, form.locator('label.triage-choice', { hasText: '赤' }));
  await slowSelect(er, form.getByLabel(/所在/), '救急外来');
  await slowType(er, form.getByLabel('タッグ番号'), '107');
  await slowClick(er, form.getByRole('button', { name: '登録する' }), 0);
  const id = (await er.getByTestId('notice').filter({ hasText: 'を登録しました' }).innerText()).match(/P-\d+/)![0];
  await hq.getByTestId(`patient-${id}`).waitFor({ timeout: 5000 });
  await moveCursor(hq, hq.getByTestId(`patient-${id}`));
  await sleep(2000);
  const to = Date.now();
  const note = `同じ時間軸で撮った2本（長さも同じ）。救急外来で ${id}（赤・タッグ107）を登録すると、本部の患者一覧の先頭に出る`;
  await finish(recEr, { id: 'b1', file: 'b1-sync-er.webm', title: '2台の端末：救急外来（登録する側）', note }, { from, to });
  await finish(recHq, { id: 'b2', file: 'b2-sync-hq.webm', title: '2台の端末：本部（表示される側）', note }, { from, to });
}

/** c. 搬送：指示 → 出発 → 到着。段階が別の印（✓・枠線）で並ぶ */
async function clipC() {
  const page = await openTerminal('hq', '青木 はるか');
  await tab(page, /搬送/);
  const card = page.getByTestId('transport-T-002');
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const rec = new Recorder(page);
  await rec.start();
  await sleep(600);
  await slowClick(page, card.getByRole('button', { name: '指示を記録' }));
  const order = card.getByRole('form', { name: '指示の記録' });
  await slowSelect(page, order.getByLabel(/指示した人/), '搬送調整担当');
  await slowClick(page, order.getByRole('button', { name: '指示を記録する' }), 1200);
  await card.getByTestId('step-ordered').filter({ hasText: '搬送調整担当' }).waitFor();
  await card.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await slowClick(page, card.getByRole('button', { name: '出発を記録' }), 1400);
  await card.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await sleep(500);
  // 到着を記録すると「終わった搬送」へ移るので、その直前の、すべての段階が並んだ状態を長めに見せる
  await moveCursor(page, card.getByRole('button', { name: '到着を記録' }));
  await sleep(600);
  await press(page);
  await card.getByRole('button', { name: '到着を記録' }).click();
  await sleep(500);
  // 終わった搬送を開いて、到着まで記録された T-002 を見せる
  const finished = page.getByText(/終わった搬送/).first();
  if (await finished.isVisible().catch(() => false)) {
    await slowClick(page, finished, 600);
    const done2 = page.getByTestId('transport-T-002');
    if (await done2.isVisible().catch(() => false)) {
      await done2.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await sleep(2200);
    }
  }
  await finish(rec, { id: 'c', file: 'c-transport.webm', title: '搬送：指示から到着まで', note: 'T-002（外来ホール→3階東病棟、了承と要員の割り当ては記録済み）に、指示・出発・到着を順に記録。記録済みの段階は ✓ と実線、未記録は – と破線、省略可の受領確認は点線' });
}

/** d. 院内の状況：場所ごとの人数。報告のない職種・場所は「未確認」 */
async function clipD() {
  const page = await openTerminal('hq', '青木 はるか');
  await tab(page, /院内の状況/);
  const rec = new Recorder(page);
  await rec.start();
  await sleep(1500);
  const ward = page.locator('section, article, div').filter({ has: page.getByRole('heading', { name: '3階東病棟' }) }).last();
  const er = page.getByRole('heading', { name: /救急外来/ }).first();
  const y = async (l: Locator) => (await l.evaluate((el) => el.getBoundingClientRect().top + scrollY)) - 90;
  await smoothScrollTo(page, await y(er), 1800);
  await sleep(1500);
  await smoothScrollTo(page, await y(ward), 2600);
  await sleep(600);
  await moveCursor(page, ward.getByText(/未確認/).nth(1));
  await sleep(1800);
  await finish(rec, { id: 'd', file: 'd-hospital-status.webm', title: '院内の状況（場所ごとの人数）', note: '本部の「院内の状況」。救急外来は職種ごとの人数と確認時刻、3階東病棟は看護師が「未確認」と報告された例、報告のない職種も「未確認」と表示' });
}

/** e. 訓練モード：無線の受信箱に部署役（mock）の報告が届く */
async function clipE() {
  const page = await openTerminal('hq', '青木 はるか', 'training');
  await tab(page, /訓練/);
  const scenario = page.getByTestId('scenario-claude-red-to-or');
  await scenario.getByRole('button', { name: 'この訓練を選ぶ' }).click();
  const rec = new Recorder(page);
  await rec.start();
  await sleep(1000);
  await slowClick(page, scenario.getByRole('button', { name: 'この訓練を始める' }), 600);
  await page.getByTestId('training-run').filter({ hasText: '進行中' }).waitFor();
  const fast = page.getByRole('button', { name: /2倍速/ });
  await slowClick(page, fast, 300);
  const inbox = page.getByTestId('radio-inbox');
  // 受信箱は画面の上（入力者の下）に現れるので、いちばん上を見せておく
  await smoothScrollTo(page, 0, 600);
  const row = inbox.locator('.radio-row').first();
  await row.waitFor({ timeout: 90_000 });
  const arrived = Date.now();
  await sleep(600);
  await moveCursor(page, row);
  await sleep(4500);
  // 待ち時間は切り、届く 2.5 秒前から
  await finish(rec, { id: 'e', file: 'e-training-radio.webm', title: '訓練：無線の受信箱に部署役の報告が届く', note: '訓練モード（画面上部に「訓練」）。シナリオ「赤ゾーンから手術室へ」を始め、救急外来の部署役（AI_PROVIDER=mock の決まった文）の報告が無線の受信箱に届く。待ち時間は切ってある' }, { from: arrived - 2500 });
  // 訓練を止めておく（保存先は録画用のフォルダ）
  await page.request.post(`${WEB}/api/h/claude/training/sim/control`, { data: { action: 'pause' } }).catch(() => {});
}

/** f. 掲示用画面：操作なし。別の端末からの登録で数字が変わる */
async function clipF() {
  // 掲示用画面の「搬送中」が空にならないよう、P-004（外来ホール → 4階東病棟）を出発まで記録しておく（架空）
  const t = await apiSend({ type: 'RequestTransport', payload: { patientId: 'P-004', toLocationId: 'ward-4e', methodId: 'wheelchair', escorts: [] } });
  const tid = (t.events[0].subject.id) as string;
  await apiSend({ type: 'AcceptTransport', transportId: tid, payload: { decidedBy: { positionId: 'ward-4e-lead' } } }, tid);
  await apiSend({ type: 'AssignTransportStaff', transportId: tid, payload: { transporterIds: ['tr-05'] } }, tid);
  await apiSend({ type: 'OrderTransport', transportId: tid, payload: { orderedBy: { positionId: 'hq-transport' } } }, tid);
  await apiSend({ type: 'RecordDeparture', transportId: tid, payload: {} }, tid);
  const page = await openPage('/?hospital=claude&view=board', { view: { width: 1920, height: 1080 }, scale: 1 });
  const rec = new Recorder(page);
  await rec.start();
  await sleep(2500);
  // 救急外来の端末から登録された、という想定で API に送る（架空）
  await apiSend({ type: 'RegisterPatient', payload: { tagNumber: '108', triage: 'red', locationId: 'er', features: 'えんじ色のシャツ' } }, undefined, { enteredBy: 'er-02', terminal: 'er' });
  await sleep(4500);
  await finish(rec, { id: 'f', file: 'f-board.webm', title: '掲示用画面（本部の大型モニター）', note: '1920×1080 で表示。操作なし・自動更新。搬送中 1件（P-004）と対応待ちの支援要請 1件。2.5秒ごろに救急外来から赤の患者（タッグ108）が登録され、赤の人数が 3→4 に増える' });
}

// ---------------- 3分版のクリップ（g〜k） ----------------

/** カードの操作を押す。「次にすること」になければ「ほかの操作」を開いてから（e2e/helpers.ts の clickAction と同じ考え方） */
async function slowAction(page: Page, card: Locator, name: string, after = 600) {
  const button = () => card.getByRole('button', { name: new RegExp(`^${name}`) }).filter({ visible: true });
  if ((await button().count()) === 0) await slowClick(page, card.locator('summary', { hasText: 'ほかの操作' }), 300);
  await slowClick(page, button().first(), after);
}

/** g. 通しの場面：救急外来で赤の患者（タッグ110）を登録 → 本部が手術室への搬送を依頼 → 手術室が了承 → 本部が要員を割り当てて指示・出発 → 手術室で到着。
 *  救急外来・本部・手術室・掲示用画面の4台を同じ時間軸で撮る */
async function clipG() {
  const er = await openTerminal('er', '川口 直子');
  const hq = await openTerminal('hq', '青木 はるか');
  const or = await openTerminal('or', '田村 由紀');
  const board = await openPage('/?hospital=claude&view=board', { view: { width: 1920, height: 1080 }, scale: 1 });
  await tab(er, PATIENT_TAB);
  await tab(hq, PATIENT_TAB);
  await tab(or, /搬送/);
  await hq.getByTestId('patient-count').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await hq.evaluate(() => scrollBy(0, -120));
  const recs = [new Recorder(er), new Recorder(hq), new Recorder(or), new Recorder(board)];
  let from = 0;
  for (const r of recs) from = Math.max(from, await r.start());
  const marks: Record<string, number> = {};
  const mark = (k: string) => (marks[k] = Math.round((Date.now() - from) / 100) / 10);
  await sleep(1000);

  // 1. 救急外来で登録
  const form = er.getByRole('form', { name: '患者を登録する' });
  mark('救急外来で入力を始める');
  await slowClick(er, form.locator('label.triage-choice', { hasText: '赤' }));
  await slowSelect(er, form.getByLabel(/所在/), '救急外来');
  await slowType(er, form.getByLabel('タッグ番号'), '110');
  await slowClick(er, form.getByRole('button', { name: '登録する' }), 0);
  const pid = (await er.getByTestId('notice').filter({ hasText: 'を登録しました' }).innerText()).match(/P-\d+/)![0];
  mark('救急外来で登録');
  const row = hq.getByTestId(`patient-${pid}`);
  await row.waitFor({ timeout: 5000 });
  mark('本部の一覧に出る');
  await sleep(1500);

  // 2. 本部が手術室への搬送を依頼
  await slowClick(hq, row.getByRole('button', { name: '搬送を依頼する' }));
  const tf = hq.getByRole('form', { name: '搬送を依頼する' });
  await slowSelect(hq, tf.getByLabel(/^到着先/), '手術室');
  await slowClick(hq, tf.locator('label.chip', { hasText: 'ストレッチャー' }));
  await slowSelect(hq, tf.getByLabel('付き添いの看護師の人数'), '1');
  await slowClick(hq, tf.getByRole('button', { name: '搬送を依頼する' }), 0);
  const tid = (await hq.getByTestId('notice').filter({ hasText: '搬送依頼を記録しました' }).innerText()).match(/T-\d+/)![0];
  mark('本部が搬送を依頼');
  await tab(hq, /搬送/);
  const card = hq.getByTestId(`transport-${tid}`);
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));

  // 3. 手術室が了承
  const orCard = or.getByTestId(`transport-${tid}`);
  await orCard.waitFor({ timeout: 5000 });
  await orCard.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  mark('手術室に届く');
  await sleep(1000);
  await slowAction(or, orCard, '了承を記録');
  await slowClick(or, orCard.getByRole('form', { name: '受け入れ了承の記録' }).getByRole('button', { name: '了承を記録する' }), 0);
  await card.getByTestId('step-accepted').filter({ hasText: '手術室責任者' }).waitFor({ timeout: 5000 });
  mark('手術室が了承');
  await sleep(1200);

  // 4. 本部が要員を割り当て、指示し、出発を記録
  await slowAction(hq, card, '要員を割り当てる');
  const assign = card.getByRole('form', { name: '搬送要員の割り当て' });
  await slowClick(hq, assign.getByRole('button', { name: /搬送A班/ }));
  await slowClick(hq, assign.getByRole('button', { name: '2人を割り当てる' }), 800);
  mark('要員を割り当て');
  await slowAction(hq, card, '指示を記録');
  const order = card.getByRole('form', { name: '指示の記録' });
  await slowSelect(hq, order.getByLabel(/指示した人/), '搬送調整担当');
  await slowClick(hq, order.getByRole('button', { name: '指示を記録する' }), 800);
  mark('指示');
  await card.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await slowAction(hq, card, '出発を記録', 600);
  mark('出発');
  // 出発すると搬送は「搬送中」の欄に移る。本部はそこを見せ、掲示用画面にも「搬送中 1件」が出ている間を長めにとる
  const moving = hq.getByTestId(`moving-${tid}`);
  if (await moving.isVisible().catch(() => false)) await moveCursor(hq, moving);
  await sleep(4000);

  // 5. 手術室で到着
  await orCard.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await slowAction(or, orCard, '到着を記録', 0);
  mark('到着');
  await sleep(3000);
  const to = Date.now();
  const note = `4台を同じ時間軸で撮った。救急外来で ${pid}（赤・タッグ110）→ 本部が ${tid}（救急外来→手術室）を依頼 → 手術室が了承 → 本部が要員の割り当て・指示・出発 → 手術室で到着。目印（秒）：${JSON.stringify(marks)}`;
  await finish(recs[0]!, { id: 'g1', file: 'g1-flow-er.webm', title: '通しの場面：救急外来', note }, { from, to });
  await finish(recs[1]!, { id: 'g2', file: 'g2-flow-hq.webm', title: '通しの場面：本部', note }, { from, to });
  await finish(recs[2]!, { id: 'g3', file: 'g3-flow-or.webm', title: '通しの場面：手術室', note }, { from, to });
  await finish(recs[3]!, { id: 'g4', file: 'g4-flow-board.webm', title: '通しの場面：掲示用画面', note }, { from, to });
}

/** h. 重複の警告：同じタッグ番号（101）で登録すると警告が出て、理由を選べば登録できる */
async function clipH() {
  const page = await openTerminal('hq', '青木 はるか');
  await tab(page, PATIENT_TAB);
  const form = page.getByRole('form', { name: '患者を登録する' });
  const rec = new Recorder(page);
  await rec.start();
  await sleep(800);
  await slowClick(page, form.locator('label.triage-choice', { hasText: '黄' }));
  await slowSelect(page, form.getByLabel(/所在/), '外来ホール');
  await slowType(page, form.getByLabel('タッグ番号'), '101');
  await slowClick(page, form.getByRole('button', { name: '登録する' }), 0);
  const dialog = page.getByRole('dialog', { name: '確認してください' });
  await dialog.waitFor();
  await sleep(2200);
  await slowClick(page, dialog.getByLabel('別の患者であることを確認した'), 900);
  await slowClick(page, dialog.getByRole('button', { name: '別の患者として登録する' }), 0);
  await page.getByTestId('notice').filter({ hasText: 'を登録しました' }).waitFor();
  await sleep(2000);
  await finish(rec, { id: 'h', file: 'h-duplicate-warning.webm', title: '重複の警告（止めずに理由を残す）', note: '本部で、すでにいるタッグ番号 101 を登録 → 「確認してください」の警告 → 「別の患者であることを確認した」を選んで登録' });
}

/** i. 訓練（CAPTURE_AI=anthropic なら本物の Claude API）：部署役の報告 → 医療の判断を聞くと断る → 終えて振り返り。3本に分けて保存する */
async function clipI() {
  const page = await openTerminal('hq', '青木 はるか', 'training');
  await tab(page, /訓練/);
  const scenario = page.getByTestId('scenario-claude-red-to-or');
  await scenario.getByRole('button', { name: 'この訓練を選ぶ' }).click();
  // i1：始めて、最初の報告が届くまで（待ち時間は切る）
  let rec = new Recorder(page);
  await rec.start();
  await sleep(1000);
  await slowClick(page, scenario.getByRole('button', { name: 'この訓練を始める' }), 600);
  await page.getByTestId('training-run').filter({ hasText: '進行中' }).waitFor();
  await slowClick(page, page.getByRole('button', { name: /2倍速/ }), 300);
  await smoothScrollTo(page, 0, 600);
  const inbox = page.getByTestId('radio-inbox');
  await inbox.locator('.radio-row').first().waitFor({ timeout: 180_000 });
  const arrived = Date.now();
  await sleep(600);
  await moveCursor(page, inbox.locator('.radio-row').first());
  await sleep(5000);
  await finish(rec, { id: 'i1', file: 'i1-training-report.webm', title: '訓練：部署役（Claude）の報告が届く', note: `訓練モード。部署役：${process.env.CAPTURE_AI === 'anthropic' ? 'Claude API' : 'mock'}。最初の報告が無線の受信に届く。待ち時間は切ってある` }, { from: arrived - 2500 });

  // i2：救急外来に医療の判断を聞き、断る返事が届く
  const send = page.getByRole('form', { name: '部署への連絡' });
  await send.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  rec = new Recorder(page);
  const recStart = await rec.start();
  await sleep(800);
  await slowClick(page, send.locator('label.chip', { hasText: '救急外来' }));
  await slowType(page, send.getByLabel('伝えること'), 'タッグ101の区分を黄に下げたほうがいい？治療は何を優先？');
  const before = await inbox.locator('.radio-row').count();
  await slowClick(page, send.getByRole('button', { name: '無線で伝える' }), 300);
  const sent = Date.now();
  await smoothScrollTo(page, 0, 700);
  await inbox.locator('.radio-row').nth(before).waitFor({ timeout: 180_000 });
  const replied = Date.now();
  await sleep(600);
  await moveCursor(page, inbox.locator('.radio-row').first());
  await sleep(6000);
  // 送ってから返事が届くまでの待ち時間は長いので、送った直後と届く直前だけ残す（間は編集で切る）
  await finish(rec, { id: 'i2', file: 'i2-training-refusal.webm', title: '訓練：医療の判断を聞くと、部署役が断る', note: `本部から救急外来の部署役へ「区分を黄に下げたほうがいい？治療は何を優先？」と送る。録画の始めから送信まで ${((sent - recStart) / 1000).toFixed(1)}秒、そこから返事が届くまで ${((replied - sent) / 1000).toFixed(1)}秒（編集で間を切る）` });

  // i3：訓練を終え、振り返り（説明文は Claude）
  await tab(page, /訓練/);
  await page.getByRole('button', { name: '訓練を終える' }).click();
  rec = new Recorder(page);
  await rec.start();
  await sleep(600);
  await slowClick(page, page.getByRole('button', { name: '終了する' }), 0);
  const review = page.getByTestId('review');
  await review.waitFor({ timeout: 180_000 });
  const shown = Date.now();
  await review.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await sleep(2500);
  const y = await review.evaluate((el) => el.getBoundingClientRect().top + scrollY);
  const h = await review.evaluate((el) => el.scrollHeight);
  await smoothScrollTo(page, y + Math.max(0, h - 700), 9000);
  await sleep(2000);
  await finish(rec, { id: 'i3', file: 'i3-training-review.webm', title: '訓練：振り返り（説明文は Claude）', note: '訓練を終えると振り返りが出る。確認項目と「記録から見えたこと」。照合と根拠の番号はプログラム、説明文は Claude（API のとき）。待ち時間は切ってある' }, { from: shown - 1500 });
}

/** i4. 訓練：本部役が、無線で聞いた内容を連絡メモに残し、ボードに患者を登録する（CAPTURE_AI=anthropic なら部署役は Claude API） */
async function clipI4() {
  const page = await openTerminal('hq', '青木 はるか', 'training');
  await tab(page, /訓練/);
  const scenario = page.getByTestId('scenario-claude-red-to-or');
  await scenario.getByRole('button', { name: 'この訓練を選ぶ' }).click();
  await scenario.getByRole('button', { name: 'この訓練を始める' }).click();
  await page.getByTestId('training-run').filter({ hasText: '進行中' }).waitFor();
  await page.getByRole('button', { name: /2倍速/ }).click();
  const inbox = page.getByTestId('radio-inbox');
  const first = inbox.locator('.radio-row').first();
  await first.waitFor({ timeout: 180_000 });
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(500);
  const rec = new Recorder(page);
  await rec.start();
  await sleep(1200);
  // 聞いた内容を連絡メモに残す（部署役の言葉は下書きとして出る）
  await slowClick(page, first.getByRole('button', { name: /連絡メモに残す/ }), 800);
  const draft = first.getByRole('form', { name: '連絡メモの下書き' });
  await draft.waitFor();
  await sleep(1200);
  await slowClick(page, draft.getByRole('button', { name: 'この内容で残す' }), 1000);
  // ボードに患者を登録する
  await tab(page, PATIENT_TAB);
  const form = page.getByRole('form', { name: '患者を登録する' });
  await sleep(500);
  await slowClick(page, form.locator('label.triage-choice', { hasText: '赤' }));
  await slowSelect(page, form.getByLabel(/所在/), '救急外来');
  await slowType(page, form.getByLabel('タッグ番号'), '101');
  await slowType(page, form.getByLabel(/特徴メモ/), '紺の作業着');
  await slowClick(page, form.getByRole('button', { name: '登録する' }), 0);
  await page.getByTestId('notice').filter({ hasText: 'を登録しました' }).waitFor();
  await sleep(300);
  await smoothScrollTo(page, 0, 800);
  await sleep(2200);
  await finish(rec, { id: 'i4', file: 'i4-training-input.webm', title: '訓練：聞いた内容を記録し、ボードに入力する', note: `訓練モード。部署役：${process.env.CAPTURE_AI === 'anthropic' ? 'Claude API' : 'mock'}。最初の無線の報告を「連絡メモに残す」で記録し、患者（赤・タッグ101・紺の作業着）をボードに登録する。部署役の報告を待つ時間は切ってある` });
  await page.request.post(`${WEB}/api/h/claude/training/sim/control`, { data: { action: 'pause' } }).catch(() => {});
}

/** s. 支援要請：3階東病棟から看護師2人の応援を要請（人員）。外来ホールからの車いす2台（物品）と並んで一覧に出る */
async function clipS() {
  const page = await openTerminal('ward-3e', '中島 綾');
  await tab(page, /支援要請/);
  const form = page.getByRole('form', { name: '支援を要請する' });
  const rec = new Recorder(page);
  await rec.start();
  await sleep(800);
  await slowClick(page, form.locator('label.chip', { hasText: '人員' }));
  await slowType(page, form.getByLabel('看護師の数', { exact: true }), '2');
  await slowClick(page, form.getByRole('button', { name: '支援を要請する' }), 0);
  await page.getByTestId('notice').filter({ hasText: '支援要請を記録しました' }).waitFor();
  await sleep(600);
  const list = page.getByTestId('support-list');
  if (await list.isVisible().catch(() => false)) await moveCursor(page, list);
  await sleep(2600);
  await finish(rec, { id: 's', file: 's-support.webm', title: '支援要請（人員・物品）', note: '3階東病棟の端末で「人員：看護師2人」を要請。一覧には、外来ホールからの「物品：車いす2台」（デモ用データ）と並んで出る' });
}

/** j. どの病院でも：病院を選ぶ画面（2つの架空の病院）→ 中規模の Hackathon中央病院(仮) を災害運用で開き、本部の端末で院内の状況を見る */
async function clipJ() {
  const page = await openPage('/?hospital=', { noSync: true });
  await page.getByRole('heading', { name: '病院を選んでください' }).waitFor();
  const rec = new Recorder(page);
  await rec.start();
  await sleep(2500);
  await moveCursor(page, page.getByRole('link', { name: '＋ 病院を作る' }));
  await sleep(1500);
  const choice = page.locator('.hospital-choice', { hasText: 'Hackathon中央病院' });
  await slowClick(page, choice.getByRole('button', { name: /災害運用で開く/ }), 1200);
  await slowClick(page, page.getByRole('button', { name: /本部（1階事務室）/ }), 1000);
  await slowClick(page, page.getByRole('button', { name: /内田 千夏/ }), 800);
  await tab(page, /院内の状況/);
  await sleep(1200);
  await smoothScrollTo(page, 500, 2500);
  await sleep(1500);
  await finish(rec, { id: 'j', file: 'j-hospitals.webm', title: 'どの病院でも：病院を選んで開く', note: '病院を選ぶ画面（Claude総合病院(仮)・Hackathon中央病院(仮)、＋ 病院を作る）→ Hackathon中央病院(仮) を災害運用で開き、本部（1階事務室）の端末で院内の状況' });
}

/** k. 印刷：本部の患者一覧を印刷用の表示（白黒で読める、出力日時つき）で見せる */
async function clipK() {
  const page = await openTerminal('hq', '青木 はるか');
  await tab(page, PATIENT_TAB);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(800);
  const rec = new Recorder(page);
  await rec.start();
  await sleep(2500);
  await smoothScrollTo(page, 900, 5000);
  await sleep(1500);
  await finish(rec, { id: 'k', file: 'k-print.webm', title: '印刷用の表示（患者一覧）', note: '本部の患者一覧を、印刷用の表示（print メディア）で写したもの。印刷ダイアログは写していない' });
}

/** 災害運用の記録へ API でコマンドを送る（掲示用画面の準備用） */
async function apiSend(command: Record<string, unknown>, transportId?: string, meta = { enteredBy: 'hq-01', terminal: 'hq' }) {
  const base = `${API}/api/h/claude/live`;
  const expectedVersion = transportId ? versionOf((await (await fetch(`${base}/state`)).json()).state, { kind: 'transport', id: transportId }) : undefined;
  const r = await fetch(`${base}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, meta, expectedVersion }) });
  const body = await r.json();
  if (body.status !== 'accepted') throw new Error(`${command.type} が受け付けられない: ${JSON.stringify(body)}`);
  return body;
}

const all: Record<string, () => Promise<void>> = { a: clipA, b: clipB, c: clipC, d: clipD, e: clipE, f: clipF, g: clipG, h: clipH, i: clipI, i4: clipI4, j: clipJ, k: clipK, s: clipS };

// ---------------- 実行 ----------------

async function main() {
  const ai = process.env.CAPTURE_AI === 'anthropic' ? 'anthropic' : 'mock';
  // i（訓練）は API の返事を撮るためのもの。指定がなければ撮らない
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(all).filter((k) => k !== 'i' && k !== 'i4');
  for (const w of wanted) if (!all[w]) throw new Error(`クリップ「${w}」はない（a〜k）`);
  if ((wanted.includes('i') || wanted.includes('i4')) && ai !== 'anthropic') console.warn('i・i4 は CAPTURE_AI=anthropic のときに撮るためのもの。mock の決まった文で撮ります');
  if ((await portInUse(SERVER_PORT)) || (await portInUse(WEB_PORT))) throw new Error(`ポート ${SERVER_PORT} か ${WEB_PORT} が使われている`);

  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('サーバーと画面を起動します（録画専用のポートと保存先）');
  start('npx', ['tsx', 'server/src/main.ts'], { SERVER_PORT: String(SERVER_PORT), DATA_DIR, HOSPITALS: 'claude,hackathon', DEFAULT_HOSPITAL: 'claude', AI_PROVIDER: ai, DEMO_CAPTURE: '1' }, 'server');
  start('npm', ['run', 'dev', '-w', 'web'], { WEB_PORT: String(WEB_PORT), API_TARGET: API }, 'web');
  await waitFor(`${API}/api/health`);
  await waitFor(WEB);

  await new Promise<void>((resolve, reject) => {
    const s = spawn('npx', ['tsx', 'scripts/demo/seed.ts'], { cwd: root, env: { ...process.env, DEMO_API: API }, stdio: 'inherit' });
    s.on('close', (code) => (code === 0 ? resolve() : reject(new Error('デモ用データを入れられなかった'))));
  });

  browser = await chromium.launch();
  for (const w of wanted) {
    console.log(`録画 ${w}`);
    await all[w]!();
    for (const c of contexts.splice(0)) await c.close();
  }
  await browser.close();
  // 一部だけ撮り直したときは、前の一覧のそのほかのクリップを残す
  const manifest = join(OUT_DIR, 'manifest.json');
  const prev: Clip[] = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).clips : [];
  const clips = [...prev.filter((c) => !done.some((d) => d.id === c.id)), ...done].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(manifest, JSON.stringify({ recordedAt: new Date().toISOString(), size: '1920x1080', fps: FPS, codec: 'VP9 (webm)', clips }, null, 2) + '\n');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close().catch(() => {});
    stopAll();
  });
