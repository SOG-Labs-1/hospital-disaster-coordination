import { beforeEach, describe, expect, it } from 'vitest';
import { decide, type CommandEnvelopeInput, type DecideResult } from './commands';
import type { DomainEvent } from './events';
import { activePatients, normalizeIdentifier, reduce, versionOf } from './state';
import { testConfig } from './test-fixtures';

const config = testConfig();
const meta = { enteredBy: 's1', terminal: 'hq' };

let events: DomainEvent[];
let seq: number;
let clock: number;

beforeEach(() => {
  events = [];
  seq = 0;
  clock = Date.parse('2026-11-04T09:00:00+09:00');
});

/** コマンドを検証し、受け付けられたらイベントを追記する（サーバーと同じ流れ） */
function send(envelope: CommandEnvelopeInput): DecideResult {
  clock += 60_000;
  const result = decide(reduce(events), config, envelope, {
    mode: 'training',
    now: new Date(clock).toISOString(),
    newId: () => `E${String(++seq).padStart(4, '0')}`,
  });
  if (result.status === 'accepted') events.push(...result.events);
  return result;
}

function register(payload: Record<string, unknown> = {}, extra: Partial<CommandEnvelopeInput> = {}) {
  return send({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', ...payload } as never }, meta, ...extra });
}

describe('患者の登録', () => {
  it('管理番号を P-001 から順に発行する', () => {
    register({ tagNumber: '1' });
    register({ tagNumber: '2' });
    const state = reduce(events);
    expect(state.patientOrder).toEqual(['P-001', 'P-002']);
    expect(state.patients['P-001']).toMatchObject({ tagNumber: '1', locationId: 'loc-a', departmentLocationId: 'loc-a', sex: 'unknown', triage: null });
  });

  it('報告元・入力者・端末・確認時刻・記録時刻・モードをイベントに残す', () => {
    const observedAt = '2026-11-04T08:55:00+09:00';
    register({}, { meta: { ...meta, reportedBy: { locationId: 'loc-a', name: '現場の人' }, observedAt } });
    const e = events[0]!;
    expect(e).toMatchObject({ enteredBy: 's1', terminal: 'hq', reportedBy: { locationId: 'loc-a', name: '現場の人' }, observedAt, mode: 'training' });
    expect(e.recordedAt).not.toBe(observedAt);
  });

  it('病院設定にない場所・区分・入力者は受け付けない', () => {
    expect(register({ locationId: 'nowhere' }).status).toBe('rejected');
    expect(register({ triage: 'purple' }).status).toBe('rejected');
    expect(send({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a' } }, meta: { ...meta, enteredBy: 'ghost' } }).status).toBe('rejected');
    expect(events).toHaveLength(0);
  });

  it('現場の確認時刻が未来すぎる登録は受け付けない', () => {
    const r = register({}, { meta: { ...meta, observedAt: '2026-11-05T00:00:00+09:00' } });
    expect(r.status).toBe('rejected');
  });
});

describe('タッグ番号・院内患者IDの重複警告', () => {
  it('同じタッグ番号は警告を返し、記録しない', () => {
    register({ tagNumber: '12' });
    const r = register({ tagNumber: '12' });
    expect(r.status).toBe('warnings');
    if (r.status !== 'warnings') return;
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'DUPLICATE_TAG_NUMBER', relatedPatientIds: ['P-001'] })]);
    expect(events).toHaveLength(1);
  });

  it('全角・空白・大文字小文字の違いも同じ番号として扱う', () => {
    expect(normalizeIdentifier(' ａ１２ ')).toBe('A12');
    register({ tagNumber: 'a12' });
    expect(register({ tagNumber: 'Ａ１２' }).status).toBe('warnings');
  });

  it('理由つきで再送すれば登録でき、理由が記録に残る', () => {
    register({ tagNumber: '12' });
    const r = register({ tagNumber: '12' }, { override: { codes: ['DUPLICATE_TAG_NUMBER'], reasonId: 'other', reason: '別人と確認' } });
    expect(r.status).toBe('accepted');
    const state = reduce(events);
    expect(state.patients['P-002']!.overrides).toEqual([{ eventId: events[1]!.id, codes: ['DUPLICATE_TAG_NUMBER'], reason: '別人と確認' }]);
  });

  it('病院設定にない理由の選択肢では再送を受け付けない', () => {
    register({ tagNumber: '12' });
    expect(register({ tagNumber: '12' }, { override: { codes: ['DUPLICATE_TAG_NUMBER'], reasonId: 'no-such-reason', reason: '別人と確認' } }).status).toBe('rejected');
  });

  it('理由が空なら再送を受け付けない', () => {
    register({ tagNumber: '12' });
    expect(register({ tagNumber: '12' }, { override: { codes: ['DUPLICATE_TAG_NUMBER'], reason: '  ' } }).status).toBe('rejected');
  });

  it('警告が2つあるときは両方を承知しないと実行しない', () => {
    register({ tagNumber: '12', hospitalPatientId: 'H-1' });
    const r = register({ tagNumber: '12', hospitalPatientId: 'H-1' }, { override: { codes: ['DUPLICATE_TAG_NUMBER'], reason: '確認済み' } });
    expect(r.status).toBe('warnings');
    if (r.status === 'warnings') expect(r.warnings.map((w) => w.code)).toEqual(['DUPLICATE_TAG_NUMBER', 'DUPLICATE_HOSPITAL_PATIENT_ID']);
  });

  it('警告がないときは override を記録しない', () => {
    register({ tagNumber: '1' }, { override: { codes: ['DUPLICATE_TAG_NUMBER'], reason: '念のため' } });
    expect(events[0]!.override).toBeUndefined();
  });

  it('識別情報を後から追加するときも重複を警告する（自分自身は除く）', () => {
    register({ tagNumber: '7' });
    register({});
    const add = (patientId: string, value: string, expectedVersion: number) =>
      send({ command: { type: 'AddPatientIdentifier', patientId, payload: { kind: 'tagNumber', value } }, meta, expectedVersion });
    expect(add('P-002', '7', 1).status).toBe('warnings');
    expect(add('P-001', '7', 1).status).toBe('accepted');
  });

  it('取り消された患者とは重複しない', () => {
    register({ tagNumber: '5' });
    send({ command: { type: 'CorrectEvent', eventId: events[0]!.id, payload: { reason: '誤登録', retract: true } }, meta, expectedVersion: 1 });
    expect(register({ tagNumber: '5' }).status).toBe('accepted');
  });
});

describe('版番号による競合の検知', () => {
  it('版番号は対象ごとのイベント件数', () => {
    register({});
    register({});
    send({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't1' } }, meta, expectedVersion: 1 });
    const state = reduce(events);
    expect(versionOf(state, { kind: 'patient', id: 'P-001' })).toBe(2);
    expect(versionOf(state, { kind: 'patient', id: 'P-002' })).toBe(1);
  });

  it('古い版番号での更新は競合として返し、記録しない', () => {
    register({});
    send({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't1' } }, meta, expectedVersion: 1 });
    const r = send({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't2' } }, meta, expectedVersion: 1 });
    expect(r).toEqual({ status: 'conflict', subject: { kind: 'patient', id: 'P-001' }, expectedVersion: 1, currentVersion: 2 });
    expect(events).toHaveLength(2);
  });

  it('更新には expectedVersion が必要', () => {
    register({});
    expect(send({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't1' } }, meta }).status).toBe('rejected');
  });

  it('存在しない患者は更新できない', () => {
    expect(send({ command: { type: 'ChangePatientTriage', patientId: 'P-999', payload: { triage: 't1' } }, meta, expectedVersion: 0 }).status).toBe('rejected');
  });
});

describe('トリアージ区分の履歴', () => {
  it('変更を履歴に積み、現在の区分を更新する', () => {
    register({ triage: 't2' });
    send({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't1' } }, meta, expectedVersion: 1 });
    const p = reduce(events).patients['P-001']!;
    expect(p.triage).toBe('t1');
    expect(p.triageHistory.map((h) => h.triage)).toEqual(['t2', 't1']);
  });

  it('後から入力された古い確認では現在の区分を上書きしない', () => {
    register({ triage: 't2' }, { meta: { ...meta, observedAt: '2026-11-04T09:00:00+09:00' } });
    send({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't1' } }, meta: { ...meta, observedAt: '2026-11-04T09:01:30+09:00' }, expectedVersion: 1 });
    // 無線で遅れて届いた、より前の時刻の確認
    send({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't2' } }, meta: { ...meta, observedAt: '2026-11-04T09:01:00+09:00' }, expectedVersion: 2 });
    const p = reduce(events).patients['P-001']!;
    expect(p.triage).toBe('t1');
    expect(p.triageHistory).toHaveLength(3);
  });
});

describe('メモ', () => {
  it('特徴メモ・状態メモを更新する', () => {
    register({ features: '青い上着' });
    send({ command: { type: 'UpdatePatientNote', patientId: 'P-001', payload: { field: 'features', value: '青い上着、眼鏡' } }, meta, expectedVersion: 1 });
    send({ command: { type: 'UpdatePatientNote', patientId: 'P-001', payload: { field: 'conditionNote', value: '付き添い要' } }, meta, expectedVersion: 2 });
    expect(reduce(events).patients['P-001']).toMatchObject({ features: '青い上着、眼鏡', conditionNote: '付き添い要' });
  });
});

describe('訂正イベント', () => {
  it('差し替えで値を直し、元の記録は残る', () => {
    register({ triage: 't2' });
    send({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't1' } }, meta, expectedVersion: 1 });
    const target = events[1]!;
    const r = send({ command: { type: 'CorrectEvent', eventId: target.id, payload: { reason: '聞き間違い', replacement: { triage: 't2' } } }, meta, expectedVersion: 2 });
    expect(r.status).toBe('accepted');
    expect(events).toHaveLength(3);
    expect(events[1]).toBe(target);
    const p = reduce(events).patients['P-001']!;
    expect(p.triage).toBe('t2');
    expect(p.triageHistory[1]).toMatchObject({ status: 'corrected', triage: 't2', originalTriage: 't1', correctionReason: '聞き間違い' });
  });

  it('取り消すと、その前の区分に戻る', () => {
    register({ triage: 't2' });
    send({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't1' } }, meta, expectedVersion: 1 });
    send({ command: { type: 'CorrectEvent', eventId: events[1]!.id, payload: { reason: '別の患者の記録', retract: true } }, meta, expectedVersion: 2 });
    const p = reduce(events).patients['P-001']!;
    expect(p.triage).toBe('t2');
    expect(p.triageHistory[1]!.status).toBe('retracted');
  });

  it('登録を取り消すと一覧から外れるが、管理番号は再利用しない', () => {
    register({});
    send({ command: { type: 'CorrectEvent', eventId: events[0]!.id, payload: { reason: '誤登録', retract: true } }, meta, expectedVersion: 1 });
    register({});
    const state = reduce(events);
    expect(activePatients(state).map((p) => p.id)).toEqual(['P-002']);
    expect(state.patients['P-001']!.retracted).toBe(true);
  });

  it('登録内容の差し替えも病院設定で検証する', () => {
    register({});
    const r = send({ command: { type: 'CorrectEvent', eventId: events[0]!.id, payload: { reason: '場所違い', replacement: { locationId: 'nowhere' } } }, meta, expectedVersion: 1 });
    expect(r.status).toBe('rejected');
    send({ command: { type: 'CorrectEvent', eventId: events[0]!.id, payload: { reason: '場所違い', replacement: { locationId: 'loc-b' } } }, meta, expectedVersion: 1 });
    expect(reduce(events).patients['P-001']!.locationId).toBe('loc-b');
  });

  it('訂正の記録そのものは訂正できない', () => {
    register({});
    send({ command: { type: 'CorrectEvent', eventId: events[0]!.id, payload: { reason: 'a', retract: true } }, meta, expectedVersion: 1 });
    expect(send({ command: { type: 'CorrectEvent', eventId: events[1]!.id, payload: { reason: 'b', retract: true } }, meta, expectedVersion: 2 }).status).toBe('rejected');
  });
});
