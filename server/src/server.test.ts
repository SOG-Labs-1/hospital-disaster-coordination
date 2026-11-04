import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@hdc/shared';
import { testConfig } from '../../shared/src/test-fixtures';
import { createApp, type App } from './app';
import { EventStore, storePath } from './store';

let dataDir: string;
let app: App;
let base: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hdc-test-'));
  app = createApp({ hospitals: [testConfig()], dataDir });
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const meta = { enteredBy: 's1', terminal: 'hq' };

async function post(mode: string, body: unknown) {
  const res = await fetch(`${base}/api/h/test/${mode}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { code: res.status, body: (await res.json()) as any };
}

const registerCmd = (tagNumber?: string) => ({
  command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', tagNumber } },
  meta,
});

describe('追記保存', () => {
  it('実運用と訓練は別ファイルに保存する', async () => {
    await post('training', registerCmd('1'));
    expect(existsSync(storePath(join(dataDir, 'test'), 'live'))).toBe(true);
    expect(existsSync(storePath(join(dataDir, 'test'), 'training'))).toBe(true);
    const live = (await (await fetch(`${base}/api/h/test/live/events`)).json()) as any;
    const training = (await (await fetch(`${base}/api/h/test/training/events`)).json()) as any;
    expect(live.events).toHaveLength(0);
    expect(training.events).toHaveLength(1);
    expect(training.events[0].mode).toBe('training');
  });

  it('UPDATE と DELETE はデータベースが拒否する', async () => {
    await post('live', registerCmd('1'));
    await app.close();
    const db = new DatabaseSync(storePath(join(dataDir, 'test'), 'live'));
    expect(() => db.exec("UPDATE events SET type = 'x'")).toThrow(/追記のみ/);
    expect(() => db.exec('DELETE FROM events')).toThrow(/追記のみ/);
    db.close();
    app = createApp({ hospitals: [testConfig()], dataDir }); // afterEach で閉じる
  });

  it('別のモードの記録は書き込めない', () => {
    const store = EventStore.open(dataDir, 'live');
    const e = { id: 'x', type: 'PatientRegistered', subject: { kind: 'patient', id: 'P-001' }, mode: 'training' } as DomainEvent;
    expect(() => store.append([e])).toThrow();
    store.close();
  });

  it('再起動後も記録から状態を復元する', async () => {
    await post('live', registerCmd('1'));
    await post('live', registerCmd('2'));
    await app.close();
    app = createApp({ hospitals: [testConfig()], dataDir });
    await new Promise<void>((r) => app.server.listen(0, r));
    base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
    const r = await post('live', registerCmd('3'));
    expect(r.body.events[0].subject.id).toBe('P-003');
  });
});

describe('コマンドAPI', () => {
  it('登録すると 200 と追記したイベントを返す', async () => {
    const r = await post('live', registerCmd('10'));
    expect(r.code).toBe(200);
    expect(r.body.status).toBe('accepted');
    expect(r.body.events[0]).toMatchObject({ type: 'PatientRegistered', subject: { id: 'P-001' }, mode: 'live' });
    expect(r.body.events[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
  });

  it('重複は 422 で警告を返し、理由つきの再送で登録できる', async () => {
    await post('live', registerCmd('10'));
    const w = await post('live', registerCmd('10'));
    expect(w.code).toBe(422);
    expect(w.body.warnings[0].code).toBe('DUPLICATE_TAG_NUMBER');
    const ok = await post('live', { ...registerCmd('10'), override: { codes: ['DUPLICATE_TAG_NUMBER'], reason: '別人' } });
    expect(ok.code).toBe(200);
    expect(ok.body.events[0].override).toEqual({ codes: ['DUPLICATE_TAG_NUMBER'], reason: '別人' });
  });

  it('古い版番号は 409 で競合を返す', async () => {
    await post('live', registerCmd());
    const change = (expectedVersion: number, triage: string) =>
      post('live', { command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage } }, meta, expectedVersion });
    expect((await change(1, 't1')).code).toBe(200);
    const c = await change(1, 't2');
    expect(c.code).toBe(409);
    expect(c.body).toMatchObject({ status: 'conflict', expectedVersion: 1, currentVersion: 2 });
  });

  it('形の誤りは 400', async () => {
    expect((await post('live', { command: { type: 'DeleteEverything' }, meta })).code).toBe(400);
    const res = await fetch(`${base}/api/h/test/live/commands`, { method: 'POST', body: '{' });
    expect(res.status).toBe(400);
  });

  it('events?after= で指定より後の記録だけ返す', async () => {
    const a = await post('live', registerCmd('1'));
    await post('live', registerCmd('2'));
    const r = (await (await fetch(`${base}/api/h/test/live/events?after=${a.body.events[0].id}`)).json()) as any;
    expect(r.events.map((e: DomainEvent) => e.subject.id)).toEqual(['P-002']);
  });
});

describe('Server-Sent Events', () => {
  it('追記したイベントを同じモードの全端末に配信する', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/h/test/live/stream`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil(/event: ready/);
    await post('training', registerCmd('99')); // 訓練の記録は実運用の端末に届かない
    await post('live', registerCmd('1'));
    await readUntil(/event: domain-event[\s\S]*\n\n/);
    ac.abort();
    const data = text.split('event: domain-event\ndata: ')[1]!.split('\n')[0]!;
    expect(JSON.parse(data)).toMatchObject({ type: 'PatientRegistered', mode: 'live', payload: { tagNumber: '1' } });
    expect(text).not.toContain('"99"');
  });
});

describe('複数の病院', () => {
  it('病院ごとに記録を別のフォルダに保存し、混ざらない', async () => {
    await app.close();
    const other = testConfig({ id: 'other', name: '別の病院(架空)' });
    app = createApp({ hospitals: [testConfig(), other], dataDir });
    await new Promise<void>((r) => app.server.listen(0, r));
    base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
    const list = (await (await fetch(`${base}/api/hospitals`)).json()) as any;
    expect(list).toEqual({ hospitals: [{ id: 'test', name: 'テスト病院(架空)' }, { id: 'other', name: '別の病院(架空)' }], defaultHospitalId: null });
    expect(((await (await fetch(`${base}/api/h/other/config`)).json()) as any).name).toBe('別の病院(架空)');
    expect((await fetch(`${base}/api/h/nowhere/config`)).status).toBe(404);

    await fetch(`${base}/api/h/other/live/commands`, { method: 'POST', body: JSON.stringify(registerCmd('1')) });
    const t = (await (await fetch(`${base}/api/h/test/live/events`)).json()) as any;
    const o = (await (await fetch(`${base}/api/h/other/live/events`)).json()) as any;
    expect(t.events).toHaveLength(0);
    expect(o.events).toHaveLength(1);
    expect(existsSync(storePath(join(dataDir, 'other'), 'live'))).toBe(true);
  });

  it('既定の病院が設定にないときは起動しない', () => {
    expect(() => createApp({ hospitals: [testConfig()], dataDir, defaultHospitalId: 'nope' })).toThrow();
  });
});
