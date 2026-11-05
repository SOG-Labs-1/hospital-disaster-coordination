import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from './app';
import { MockProvider } from './ai/mock';
import type { AiProvider } from './ai/provider';
import { loadHospitalConfig, loadScenarios } from './config';

const config = loadHospitalConfig('claude');
const scenarios = loadScenarios([config]);

let dataDir: string;
let app: App;
let base: string;
let clock: number;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hdc-train-'));
  clock = Date.parse('2026-11-04T10:00:00+09:00');
  app = createApp({ hospitals: [config], dataDir, now: () => new Date(clock), training: { scenarios, provider: new MockProvider(), tickMs: 1_000_000 } });
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://localhost:${(app.server.address() as AddressInfo).port}/api/h/claude`;
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { code: res.status, body: (await res.json()) as any };
};
const snapshot = async () => (await (await fetch(`${base}/training/sim`)).json()) as any;
const meta = { enteredBy: 'hq-01', terminal: 'hq' };

const boardEvents = async () => (((await (await fetch(`${base}/training/events`)).json()) as any).events as any[]);

/** 患者が着き、本部が手術室へ搬送を依頼し、手術室が了承し、本部が搬送要員に無線で指示して、運び出されるまで */
async function requestAndRadio() {
  await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
  await advanceBy(20_000);
  await post('/training/commands', { command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'or' } }, meta });
  await advanceBy(15_000);
  await app.training('claude')!.settle();
  expect((await post('/training/sim/message', { to: 'transporter', text: 'T-001、救急外来から手術室へお願いします' })).code).toBe(200);
  await advanceBy(15_000);
  await app.training('claude')!.settle();
}

/** シナリオの時間を進める（1倍速） */
async function advanceBy(ms: number) {
  clock += ms;
  const m = app.training('claude')!;
  m.tick();
  await m.settle();
}

describe('訓練の進行（mock の部署役）', () => {
  it('シナリオを始めると、運ばれてきた患者は救急外来の端末から登録され、本部のボードに入る（無線は使わない）', async () => {
    expect((await snapshot()).run).toBeNull();
    const r = await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    expect(r.code).toBe(200);
    expect(r.body.run).toMatchObject({ scenarioId: 'claude-red-to-or', running: true, speed: 1 });

    await advanceBy(20_000); // 00:20 に患者 p1 が救急外来に着く
    const board = await boardEvents();
    const reg = board.find((e: any) => e.type === 'PatientRegistered');
    expect(reg).toMatchObject({ terminal: 'er', enteredBy: 'er-01', payload: { tagNumber: '101', triage: 'red', locationId: 'er' } });
    // 部署からの記録なので、無線の受信には何も届かない
    expect((await snapshot()).inbox).toHaveLength(0);
  });

  it('本部の搬送の依頼に、手術室の部署役が判断し、手術室の端末から了承が記録される', async () => {
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    await advanceBy(20_000);
    expect((await post('/training/commands', { command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'or' } }, meta })).code).toBe(200);
    await advanceBy(15_000);
    await app.training('claude')!.settle();
    const accepted = (await boardEvents()).find((e: any) => e.type === 'TransportAccepted');
    expect(accepted).toMatchObject({ terminal: 'or', subject: { id: 'T-001' } });
    expect(accepted.payload.note).toContain('受け入れできます');
    expect((await snapshot()).inbox).toHaveLength(0);
  });

  it('無線は搬送要員とだけ：指示すると運び出して無線で伝え、到着は手術室の端末から記録される', async () => {
    await requestAndRadio();
    // 部署には無線で連絡できない
    expect((await post('/training/sim/message', { to: 'ward-3e', text: '状況を教えてください' })).code).toBe(400);
    let s = await snapshot();
    const departed = s.inbox.find((m: any) => m.from === 'transporter');
    expect(departed).toMatchObject({ fromName: '搬送要員（佐藤）' });
    expect(departed.text).toContain('出発しました');
    expect(s.outbox).toMatchObject([{ to: 'transporter', toName: '搬送要員（佐藤）' }]);
    const heard = await post('/training/sim/heard', { messageId: departed.messageId });
    expect(heard.body.inbox.find((m: any) => m.messageId === departed.messageId).heard).toBe(true);

    await advanceBy(120_000); // 移動の時間（2分）
    await advanceBy(15_000); // 搬送要員の無線の返事
    await app.training('claude')!.settle();
    const arrived = (await boardEvents()).find((e: any) => e.type === 'TransportArrived');
    expect(arrived).toMatchObject({ terminal: 'or', subject: { id: 'T-001' } });
    s = await snapshot();
    expect(s.inbox.filter((m: any) => m.from === 'transporter').at(-1).text).toContain('着きました');
  });

  it('一時停止中は時間が進まず、2倍速で進む', async () => {
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    await advanceBy(10_000);
    await post('/training/sim/control', { action: 'pause' });
    await advanceBy(60_000);
    expect((await snapshot()).run).toMatchObject({ running: false, simMs: 10_000 });
    await post('/training/sim/control', { action: 'resume' });
    await post('/training/sim/control', { action: 'speed', speed: 2 });
    await advanceBy(5_000);
    expect((await snapshot()).run).toMatchObject({ running: true, speed: 2, simMs: 20_000 });
  });

  it('回ごとにボードを別のファイルに保存し、新しい回は空のボードから始まる', async () => {
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    const first = (await snapshot()).run.runId;
    await post('/training/commands', { command: { type: 'RegisterPatient', payload: { locationId: 'er' } }, meta });
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    const second = (await snapshot()).run.runId;
    expect(second).not.toBe(first);
    const board = (await (await fetch(`${base}/training/events`)).json()) as any;
    expect(board.events).toHaveLength(0);
    const files = readdirSync(join(dataDir, 'claude', 'training')).filter((f) => f.endsWith('.sqlite'));
    expect(files.sort()).toEqual([`${first}.sqlite`, `${second}.sqlite`].sort());
    // 災害運用の記録は別のファイルで、訓練とは混ざらない
    expect(existsSync(join(dataDir, 'claude', 'live.sqlite'))).toBe(true);
    expect(((await (await fetch(`${base}/live/events`)).json()) as any).events).toHaveLength(0);
  });

  it('終わると振り返りを作る。無線で聞いた出発を記録しなかったことが「記録がない」として出る', async () => {
    await requestAndRadio();
    expect((await snapshot()).review).toBeNull(); // 訓練中は実際の状態を見せない
    await post('/training/sim/control', { action: 'end' });
    await app.training('claude')!.settle();
    const s = await snapshot();
    expect(s.run.ended.reason).toBe('manual');
    const departure = s.review.findings.find((f: any) => f.title.includes('T-001 の出発'));
    expect(departure).toMatchObject({ categoryLabel: '指示の受領や実行が確認できなかった', kind: 'no-record' });
    expect(departure.evidence).toContain('R-001');
    expect(departure.explanation.evidence).toEqual(departure.evidence);
    expect(s.review.explainedBy).toBe('mock');
    expect(s.review.checks.find((c: any) => c.id === 'request-red').result).toBe('met');
    expect(s.review.checks.find((c: any) => c.id === 'departure-recorded').result).toBe('no-record');

    // 参加者の補足（画面外での対応）を残して、説明を作り直せる
    await post('/training/sim/note', { findingId: departure.id, note: '口頭で確認していた' });
    await post('/training/sim/explain', {});
    await app.training('claude')!.settle();
    const again = (await snapshot()).review.findings.find((f: any) => f.id === departure.id);
    expect(again.note).toBe('口頭で確認していた');
    expect(again.explanation.text).toContain('参加者の補足：口頭で確認していた');
  });

  it('災害運用には訓練の進行の入口がない', async () => {
    expect((await fetch(`${base}/live/sim`)).status).toBe(404);
  });

  it('再起動しても、進行中の回とそのボードを続けられる', async () => {
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    await post('/training/commands', { command: { type: 'RegisterPatient', payload: { locationId: 'er', tagNumber: '101' } }, meta });
    const runId = (await snapshot()).run.runId;
    await app.close();
    app = createApp({ hospitals: [config], dataDir, now: () => new Date(clock), training: { scenarios, provider: new MockProvider(), tickMs: 1_000_000 } });
    await new Promise<void>((r) => app.server.listen(0, r));
    base = `http://localhost:${(app.server.address() as AddressInfo).port}/api/h/claude`;
    expect((await snapshot()).run.runId).toBe(runId);
    expect(((await (await fetch(`${base}/training/events`)).json()) as any).events).toHaveLength(1);
  });
});

describe('AI が止まっても訓練は続く', () => {
  async function restartWith(provider: AiProvider) {
    await app.close();
    app = createApp({ hospitals: [config], dataDir, now: () => new Date(clock), training: { scenarios, provider, tickMs: 1_000_000, replyTimeoutMs: 50 } });
    await new Promise<void>((r) => app.server.listen(0, r));
    base = `http://localhost:${(app.server.address() as AddressInfo).port}/api/h/claude`;
  }
  const failing: AiProvider = {
    name: 'anthropic',
    proposeForRole: async () => {
      throw new Error('API に届かない');
    },
    explainReview: async () => {
      throw new Error('API に届かない');
    },
  };

  it('部署役の判断に失敗したら決まった返事で補い、補った回数を画面に出す', async () => {
    await restartWith(failing);
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    await advanceBy(20_000);
    await post('/training/commands', { command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'or' } }, meta });
    await advanceBy(15_000);
    await app.training('claude')!.settle();
    expect((await boardEvents()).some((e: any) => e.type === 'TransportAccepted')).toBe(true);
    expect((await snapshot()).providerFailures).toBe(1);
  });

  it('判断するべき場面で提案がすべて却下されたら、決まった返事で補う（部署の返事が届かない、を防ぐ）', async () => {
    await restartWith({ ...failing, proposeForRole: async () => [{ action: 'report_arrival', transportId: 'T-999', message: '手術室です。到着しました' }] });
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    await advanceBy(20_000);
    await post('/training/commands', { command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'or' } }, meta });
    await advanceBy(15_000);
    await app.training('claude')!.settle();
    expect((await boardEvents()).some((e: any) => e.type === 'TransportAccepted')).toBe(true);
    expect((await snapshot()).providerFailures).toBe(1);
  });

  it('返事が時間内に来なければ決まった返事で補う', async () => {
    await restartWith({ ...failing, proposeForRole: () => new Promise(() => {}) });
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    await advanceBy(20_000);
    await post('/training/commands', { command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'or' } }, meta });
    await advanceBy(15_000);
    await new Promise((r) => setTimeout(r, 100));
    await app.training('claude')!.settle();
    expect((await snapshot()).providerFailures).toBe(1);
  });

  it('説明文に失敗しても振り返りの照合は見られ、空の説明文は追記しない', async () => {
    await restartWith(failing);
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    await advanceBy(40_000);
    await post('/training/sim/control', { action: 'end' });
    await app.training('claude')!.settle();
    const s = await snapshot();
    expect(s.review.checks.length).toBeGreaterThan(0);
    expect(s.review.explainedBy).toBeNull();
  });

  it('説明文の作成に失敗し続けても、API を呼び続けない（回ごとに上限まで）', async () => {
    let calls = 0;
    await restartWith({ ...failing, explainReview: async () => { calls++; throw new Error('API に届かない'); } });
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    await advanceBy(40_000);
    await post('/training/sim/control', { action: 'end' });
    for (let i = 0; i < 10; i++) await advanceBy(1_000);
    expect(calls).toBe(2);
    // 手動の作り直しも、回ごとの上限まで
    expect((await post('/training/sim/explain', {})).code).toBe(200);
    await app.training('claude')!.settle();
    expect((await post('/training/sim/explain', {})).code).toBe(400);
    expect(calls).toBe(3);
  });

  it('本部からの連絡は決まった長さまで', async () => {
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    const to = 'transporter';
    expect((await post('/training/sim/message', { to, text: 'あ'.repeat(301) })).code).toBe(400);
    expect((await post('/training/sim/message', { to, text: 'あ'.repeat(300) })).code).toBe(200);
  });

  it('補足は振り返りにある指摘にだけ、決まった長さまで付けられる。参加者には作る人向けの説明を見せない', async () => {
    await requestAndRadio();
    const s0 = await snapshot();
    expect(s0.scenarios.find((x: any) => x.id === 'claude-red-to-or').description).not.toContain('2枚');
    await post('/training/sim/control', { action: 'end' });
    await app.training('claude')!.settle();
    expect((await post('/training/sim/note', { findingId: 'F-99', note: 'x' })).code).toBe(400);
    const id = (await snapshot()).review.findings[0].id;
    expect((await post('/training/sim/note', { findingId: id, note: 'あ'.repeat(301) })).code).toBe(400);
    expect((await post('/training/sim/note', { findingId: id, note: '電話で確認した' })).code).toBe(200);
  });
});

describe('公開デモ（審査用）', () => {
  async function restartAsDemo(runsPerDay: number) {
    await app.close();
    const anthropicLike: AiProvider = { ...new MockProvider(), name: 'anthropic', proposeForRole: (ctx) => new MockProvider().proposeForRole(ctx), explainReview: (i) => new MockProvider().explainReview(i) };
    app = createApp({
      hospitals: [config],
      dataDir,
      now: () => new Date(clock),
      training: { scenarios, provider: anthropicLike, tickMs: 1_000_000 },
      publicDemo: { maxCreatedHospitals: 10, writesPerMinute: 1000, trainingRunsPerDay: runsPerDay },
    });
    await new Promise<void>((r) => app.server.listen(0, r));
    base = `http://localhost:${(app.server.address() as AddressInfo).port}/api/h/claude`;
  }

  it('審査用5分シナリオが一覧の先頭にある', async () => {
    expect((await snapshot()).scenarios[0].id).toBe('claude-judge-5min');
  });

  it('ほかの方の訓練が進行中なら、新しく始められない（残り時間を出す）。終わったら始められる', async () => {
    await restartAsDemo(50);
    expect((await post('/training/sim/control', { action: 'start', scenarioId: 'claude-judge-5min' })).code).toBe(200);
    await advanceBy(60_000);
    const r = await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' });
    expect(r.code).toBe(400);
    expect(r.body.errors[0]).toContain('ほかの方が訓練中です（残り約4分）');
    await post('/training/sim/control', { action: 'end' });
    expect((await post('/training/sim/control', { action: 'start', scenarioId: 'claude-red-to-or' })).code).toBe(200);
  });

  it('1日の上限を超えた回は、決まった返事（mock）で動かす', async () => {
    await restartAsDemo(1);
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-judge-5min' });
    expect((await snapshot()).provider).toBe('anthropic');
    await post('/training/sim/control', { action: 'end' });
    await post('/training/sim/control', { action: 'start', scenarioId: 'claude-judge-5min' });
    expect((await snapshot()).provider).toBe('mock');
  });

  it('病院の一覧に公開デモの目印を返し、検索エンジンに載せない', async () => {
    await restartAsDemo(50);
    const res = await fetch(`${base.replace(/\/api\/h\/claude$/, '')}/api/hospitals`);
    expect(((await res.json()) as any).publicDemo).toBe(true);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });
});
