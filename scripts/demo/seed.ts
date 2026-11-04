// 紹介映像の録画用に、Claude総合病院(仮)の災害運用の記録へ架空のデモ用データを入れる。
// すべて架空（患者・特徴メモは作り話）。サーバーの HTTP API にコマンドを送るだけで、記録の仕組みは通常と同じ。
//
// 使い方（録画専用に起動したサーバーにだけ書き込む。/api/health が demoCapture を返さないサーバーには書かない）:
//   DEMO_API=http://localhost:4200 npx tsx scripts/demo/seed.ts
// video/capture/record.ts がサーバーの起動からこのスクリプトの実行までまとめて行う。

import { versionOf, type Subject } from '@hdc/shared';

const API = process.env.DEMO_API ?? 'http://localhost:4200';
const HOSPITAL = 'claude';
const base = `${API}/api/h/${HOSPITAL}/live`;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface Meta {
  enteredBy: string;
  terminal: string;
  reportedBy?: { positionId?: string; locationId?: string; name?: string } | null;
  observedAt?: string;
}

async function getState() {
  const r = await fetch(`${base}/state`);
  if (!r.ok) throw new Error(`状態を読めない: ${r.status}`);
  return (await r.json()).state;
}

async function send(command: Record<string, unknown>, meta: Meta, subject?: Subject) {
  const expectedVersion = subject ? versionOf(await getState(), subject) : undefined;
  const r = await fetch(`${base}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, meta, expectedVersion }),
  });
  const body = await r.json();
  if (body.status !== 'accepted') throw new Error(`${command.type} が受け付けられない: ${JSON.stringify(body)}`);
  return body;
}

const hq = (m: number, reportedBy: Meta['reportedBy'] = null): Meta => ({ enteredBy: 'hq-01', terminal: 'hq', reportedBy, observedAt: minutesAgo(m) });
const er = (m: number): Meta => ({ enteredBy: 'er-01', terminal: 'er', observedAt: minutesAgo(m) });
const transport = (id: string): Subject => ({ kind: 'transport', id });

async function main() {
  const health = await fetch(`${API}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`サーバー ${API} に接続できない`);
  // 録画専用に起動したサーバー（DEMO_CAPTURE=1）にだけ書き込む。記録は追記のみで消せないため、通常の災害運用の記録に混ぜない
  if ((await health.json()).demoCapture !== true) {
    throw new Error(`${API} は録画専用のサーバーではないため、デモ用データを入れません（video/capture/record.ts から実行してください）`);
  }
  const state = await getState();
  if (state.registeredCount > 0) throw new Error('すでに記録がある。録画用の保存先（DATA_DIR）を空にしてから実行する');

  // 患者（架空）。P-001〜P-005
  const patients = [
    { tagNumber: '101', triage: 'red', locationId: 'er', sex: 'male', estimatedAge: '50代', features: '紺の作業着、眼鏡' },
    { tagNumber: '102', triage: 'red', locationId: 'er', sex: 'female', estimatedAge: '70代', features: '灰色のカーディガン' },
    { tagNumber: '103', triage: 'yellow', locationId: 'outpatient-hall', sex: 'male', estimatedAge: '30代', features: '左腕に包帯' },
    { tagNumber: '104', triage: 'yellow', locationId: 'outpatient-hall', sex: 'unknown', estimatedAge: '不明', features: '緑のリュック' },
    { tagNumber: '105', triage: 'green', locationId: 'auditorium', sex: 'female', estimatedAge: '20代', features: '白いスニーカー' },
  ];
  for (const [i, p] of patients.entries()) {
    await send({ type: 'RegisterPatient', payload: p }, p.locationId === 'er' ? er(28 - i * 3) : hq(28 - i * 3, { locationId: p.locationId }));
  }

  // 搬送 T-001：P-001 救急外来 → 手術室。要請から到着まで記録済み（受領確認は省略）
  await send({ type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'or', methodId: 'stretcher', escorts: [{ professionId: 'nurse', count: 1 }] } }, hq(20));
  await send({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: { positionId: 'or-lead' } } }, hq(19, { positionId: 'or-lead' }), transport('T-001'));
  await send({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr-01', 'tr-02'], teamId: 'team-a' } }, hq(18), transport('T-001'));
  await send({ type: 'OrderTransport', transportId: 'T-001', payload: { orderedBy: { positionId: 'hq-transport' } } }, hq(17), transport('T-001'));
  await send({ type: 'RecordDeparture', transportId: 'T-001', payload: {} }, er(15), transport('T-001'));
  await send({ type: 'RecordArrival', transportId: 'T-001', payload: {} }, { enteredBy: 'or-01', terminal: 'or', observedAt: minutesAgo(12) }, transport('T-001'));

  // 搬送 T-002：P-003 外来ホール → 3階東病棟。了承と要員の割り当てまで（録画で指示〜到着を記録する）
  await send({ type: 'RequestTransport', payload: { patientId: 'P-003', toLocationId: 'ward-3e', methodId: 'wheelchair', escorts: [] } }, hq(10));
  await send({ type: 'AcceptTransport', transportId: 'T-002', payload: { decidedBy: { positionId: 'ward-3e-lead' } } }, hq(9, { positionId: 'ward-3e-lead' }), transport('T-002'));
  await send({ type: 'AssignTransportStaff', transportId: 'T-002', payload: { transporterIds: ['tr-03'] } }, hq(8), transport('T-002'));

  // 支援要請 S-001：外来ホールから車いす2台
  await send(
    { type: 'RequestSupport', payload: { fromLocationId: 'outpatient-hall', kindId: 'supply', items: [{ resourceId: 'wheelchair', quantity: 2 }], note: '独歩困難の方が増えている' } },
    hq(7, { positionId: 'yellow-zone-lead' }),
  );

  // 場所ごとの人数。報告のない場所・職種は「未確認」のまま。3階東病棟の看護師は「未確認」と報告された例
  const counts: [string, [string, number | null][], number][] = [
    ['er', [['doctor', 3], ['nurse', 6], ['clerk', 1]], 14],
    ['outpatient-hall', [['doctor', 1], ['nurse', 4]], 11],
    ['auditorium', [['nurse', 2], ['clerk', 2]], 9],
    ['or', [['doctor', 2], ['nurse', 3]], 13],
    ['ward-3e', [['doctor', 0], ['nurse', null]], 6],
  ];
  for (const [locationId, c, m] of counts) {
    await send({ type: 'ReportStaffCount', locationId, payload: { counts: c.map(([professionId, value]) => ({ professionId, value })) } }, hq(m, { locationId }));
  }

  // 受け入れの可否。病棟などは報告がなく「未確認」のまま
  const status: [string, boolean, [string, number][], number][] = [
    ['er', true, [['red', 6]], 14],
    ['outpatient-hall', true, [['yellow', 15]], 11],
    ['auditorium', true, [['green', 40]], 9],
    ['or', true, [['red', 2]], 13],
  ];
  for (const [locationId, accepting, cap, m] of status) {
    await send(
      { type: 'ReportLocationStatus', locationId, payload: { accepting, capacity: cap.map(([triage, value]) => ({ triage, value })) } },
      hq(m, { locationId }),
    );
  }

  // 連絡メモ（無線）
  await send({ type: 'LogMessage', payload: { channel: 'radio', fromLocationId: 'outpatient-hall', text: '外来ホール：車いすが足りない。2台ほしい', relatedIds: ['S-001'] } }, hq(7, { positionId: 'yellow-zone-lead' }));

  const after = await getState();
  console.log(`デモ用データを入れました：患者 ${after.registeredCount}人（${base}）`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
