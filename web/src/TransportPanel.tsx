import { useEffect, useState, type FormEvent } from 'react';
import {
  activePatients,
  pendingForLocation,
  transporterStatus,
  versionOf,
  type AppState,
  type CommandInput,
  type HospitalConfig,
  transportSteps,
  type TransportStep,
  type TransportView,
} from '@hdc/shared';
import { formatTime } from './format';
import {
  canDirectTransport,
  deciderLabel,
  hasTerminal,
  locationLabel,
  locationName,
  patientShort,
  professionName,
  staffName,
  transporterName,
} from './labels';
import { emptyReportMeta, ReportMetaFields, toReportMeta, type ReportMetaValue } from './ReportMeta';
import { TriageBadge } from './Triage';
import { undoNotice } from './undo';
import { useCommands } from './useCommands';

interface CardProps {
  config: HospitalConfig;
  state: AppState;
  terminal: string;
  enteredBy: string | null;
  now: Date;
}

interface Props extends CardProps {
  preselectPatientId: string | null;
  onPreselectUsed: () => void;
}

export function TransportPanel(props: Props) {
  const { config, state, now } = props;
  const all = state.transportOrder.map((id) => state.transports[id]!).filter((t) => !t.retracted);
  // 引き渡しが未記録の搬送は、到着していても終わった扱いにせず調整中の一覧に残す
  const pendingHandover = (t: TransportView) => !!t.steps.arrived && !t.steps.arrived.handover && !t.steps.handedOver;
  const moving = all.filter((t) => !t.closed && t.steps.departed);
  const coordinating = all.filter((t) => (!t.closed && !t.steps.departed) || pendingHandover(t));
  const closed = all.filter((t) => t.closed && !pendingHandover(t));
  // 部署の端末では、その部署に関係する搬送だけを操作できる形で出し、ほかの部署の搬送は「見るだけ」にまとめる
  // （関係のない搬送の「次にすること」を、自分の仕事と取り違えないように）。次にすることは上部の依頼一覧と同じ判断で決める
  const direct = canDirectTransport(config, props.terminal);
  const pending = direct ? null : pendingForLocation(state, props.terminal);
  const ids = (list: TransportView[]) => new Set(list.map((t) => t.id));
  const p = pending && { accept: ids(pending.acceptRequests), handover: ids(pending.handovers), arrive: ids(pending.arrivals), depart: ids(pending.departures) };
  const focusOf = (t: TransportView): CardFocus | undefined =>
    !p ? undefined : p.accept.has(t.id) ? 'accept' : p.handover.has(t.id) ? 'handover' : p.arrive.has(t.id) ? 'arrive' : p.depart.has(t.id) ? 'depart' : 'none';
  const isMine = (t: TransportView) => direct || t.fromLocationId === props.terminal || t.toLocationId === props.terminal;
  const open = [...moving, ...coordinating];
  const mine = open.filter(isMine);
  const others = open.filter((t) => !isMine(t));

  return (
    <div className="layout">
      <div className="no-print stack">
        <TransportRequestForm {...props} />
        <TransporterBoard {...props} />
      </div>
      <div className="stack">
        <section className="panel" aria-labelledby="moving-title" data-testid="moving-list">
          <div className="panel-head">
            <h2 id="moving-title">
              搬送中 <span className="count">{moving.length}件</span>
            </h2>
            <button type="button" className="btn no-print" onClick={() => window.print()}>
              印刷する
            </button>
          </div>
          {moving.length === 0 ? (
            <p className="empty">いま移動中の患者はいません。</p>
          ) : (
            <ul className="moving-list">
              {moving.map((t) => {
                const p = state.patients[t.patientId];
                return (
                  <li key={t.id} className="moving" data-testid={`moving-${t.id}`}>
                    <span className="moving-route">
                      {locationLabel(config, t.fromLocationId, now)} <span aria-hidden="true">▶</span>
                      <span className="visually-hidden">から</span> {locationLabel(config, t.toLocationId, now)}
                    </span>
                    <span>
                      {t.patientId} {p?.tagNumber && `タッグ${p.tagNumber}`} <TriageBadge config={config} triage={p?.triage ?? null} />
                    </span>
                    <span className="moving-time">出発 {formatTime(t.steps.departed!.observedAt, now)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="transports-title">
          <h2 id="transports-title">
            {direct ? '搬送の調整' : 'この部署に関係する搬送'} <span className="count">{mine.length}件</span>
          </h2>
          {mine.length === 0 ? (
            <p className="empty">{direct ? '進行中の搬送はありません。左の「搬送を依頼する」から記録します。' : 'この部署に関係する進行中の搬送はありません。'}</p>
          ) : (
            <ol className="transport-list" data-testid="transport-list">
              {mine.map((t) => (
                <TransportCard key={t.id} transport={t} {...props} focus={focusOf(t)} />
              ))}
            </ol>
          )}
          {others.length > 0 && (
            <details className="more others-transports">
              <summary>ほかの部署の搬送 {others.length}件（見るだけ）</summary>
              <ol className="transport-list">
                {others.map((t) => (
                  <TransportCard key={t.id} transport={t} {...props} readOnly />
                ))}
              </ol>
            </details>
          )}
        </section>

        {closed.length > 0 && (
          <details className="panel closed-transports">
            <summary>終わった搬送（到着・中止） {closed.length}件</summary>
            <ol className="transport-list">
              {[...closed].reverse().map((t) => (
                <TransportCard key={t.id} transport={t} {...props} readOnly={!isMine(t)} />
              ))}
            </ol>
          </details>
        )}
      </div>
    </div>
  );
}

// ---- 搬送の依頼 ----

function TransportRequestForm({ config, state, terminal, enteredBy, now, preselectPatientId, onPreselectUsed }: Props) {
  const { run } = useCommands();
  const patients = activePatients(state);
  const [patientId, setPatientId] = useState('');
  const [toLocationId, setTo] = useState('');
  const [methodId, setMethod] = useState('');
  const [escorts, setEscorts] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [report, setReport] = useState<ReportMetaValue>(emptyReportMeta);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (preselectPatientId) {
      setPatientId(preselectPatientId);
      onPreselectUsed();
    }
  }, [preselectPatientId, onPreselectUsed]);

  const patient = state.patients[patientId];
  const missing = !patientId ? '患者を選ぶと依頼できます。' : !toLocationId ? '到着先を選ぶと依頼できます。' : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!enteredBy || missing || busy) return;
    setBusy(true);
    const r = await run(
      (override) => ({
        command: {
          type: 'RequestTransport',
          payload: {
            patientId,
            toLocationId,
            methodId: methodId || undefined,
            escorts: Object.entries(escorts)
              .filter(([, n]) => n > 0)
              .map(([professionId, count]) => ({ professionId, count })),
            note: note.trim() || undefined,
          },
        },
        meta: { enteredBy, terminal, ...toReportMeta(report) },
        override,
      }),
      { doneText: '{id} の搬送依頼を記録しました', overrideLabel: '2件目の搬送として依頼する' },
    );
    setBusy(false);
    if (r === 'accepted') {
      setPatientId('');
      setTo('');
      setMethod('');
      setEscorts({});
      setNote('');
      setReport(emptyReportMeta);
    }
  }

  return (
    <form className="panel" onSubmit={onSubmit} aria-labelledby="transport-request-title">
      <h2 id="transport-request-title">搬送を依頼する</h2>
      <p className="hint">現場からの要請も、本部からの依頼も、ここで記録します。</p>
      <label className="field">
        <span>患者<em className="required">必須</em></span>
        <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
          <option value="">選んでください</option>
          {[...patients].reverse().map((p) => (
            <option key={p.id} value={p.id}>
              {patientShort(config, p, p.id)}（{locationName(config, p.locationId)}）
            </option>
          ))}
        </select>
      </label>
      {patient && (
        <p className="from-line">
          出発元：<strong>{locationLabel(config, patient.locationId, now)}</strong>（患者のいまの所在）
        </p>
      )}
      <label className="field">
        <span>到着先<em className="required">必須</em></span>
        <select value={toLocationId} onChange={(e) => setTo(e.target.value)}>
          <option value="">選んでください</option>
          {config.locations
            .filter((l) => l.id !== patient?.locationId)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {locationLabel(config, l.id, now)}
              </option>
            ))}
        </select>
      </label>
      {config.transportMethods.length > 0 && (
        <fieldset className="group">
          <legend>搬送手段</legend>
          <div className="button-row">
            {config.transportMethods.map((m) => (
              <label key={m.id} className={`chip ${methodId === m.id ? 'is-selected' : ''}`}>
                <input type="radio" name="method" checked={methodId === m.id} onChange={() => setMethod(m.id)} />
                {methodId === m.id && <span aria-hidden="true">✓ </span>}
                {m.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset className="group">
        <legend>付き添い（職種と人数）</legend>
        <div className="escort-grid">
          {config.professions.map((p) => (
              <label key={p.id} className="escort">
                <span>{p.name}</span>
                <select value={escorts[p.id] ?? 0} onChange={(e) => setEscorts({ ...escorts, [p.id]: Number(e.target.value) })} aria-label={`付き添いの${p.name}の人数`}>
                  {Array.from({ length: 10 }, (_, n) => n).map((n) => (
                    <option key={n} value={n}>
                      {n}人
                    </option>
                  ))}
                </select>
              </label>
            ))}
        </div>
      </fieldset>
      <label className="field">
        <span>メモ（任意）</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：酸素投与中" autoComplete="off" />
      </label>
      <ReportMetaFields config={config} value={report} onChange={setReport} summary="現場からの要請を無線・電話で受けたとき（報告元・確認時刻）" />
      {!enteredBy && <p className="inline-alert">⚠ 先に、画面上の一覧から入力者を選んでください。</p>}
      {enteredBy && missing && <p className="inline-alert">⚠ {missing}</p>}
      <button type="submit" className="btn btn-primary btn-wide" disabled={!enteredBy || !!missing || busy}>
        {busy ? '送信中…' : '搬送を依頼する'}
      </button>
    </form>
  );
}

// ---- 搬送1件のカード ----

type Action = 'none' | 'accept' | 'decline' | 'assign' | 'order' | 'redirect' | 'cancel';

const statusLabels: Record<TransportView['status'], { symbol: string; text: string }> = {
  requested: { symbol: '○', text: '要請あり' },
  accepted: { symbol: '◎', text: '了承済み' },
  declined: { symbol: '✕', text: '断り' },
  'staff-assigned': { symbol: '◎', text: '要員割当済み' },
  ordered: { symbol: '◎', text: '指示済み' },
  acknowledged: { symbol: '◎', text: '受領済み' },
  'in-transit': { symbol: '▶', text: '搬送中' },
  arrived: { symbol: '■', text: '到着' },
  cancelled: { symbol: '✕', text: '中止' },
};

/** 部署の画面で、その行の「次にすること」。none は次にすることがない（すべて「ほかの操作」に入れる） */
export type CardFocus = 'accept' | 'depart' | 'arrive' | 'handover' | 'none';

export function TransportCard({
  transport: t,
  config,
  state,
  terminal,
  enteredBy,
  now,
  focus,
  readOnly = false,
}: CardProps & { transport: TransportView; focus?: CardFocus; readOnly?: boolean }) {
  const { run, showNotice } = useCommands();
  const [action, setAction] = useState<Action>('none');
  // 送っている間は、1回で記録されるボタンを押せなくする（二度押しで、成功の知らせが誤りの知らせに置き換わらないように）
  const [sending, setSending] = useState(false);
  const [report, setReport] = useState<ReportMetaValue>(emptyReportMeta);
  const p = state.patients[t.patientId];
  const version = versionOf(state, { kind: 'transport', id: t.id });
  const baseMeta = { enteredBy: enteredBy ?? '', terminal, reportedBy: null };
  // 無線で受けた報告なら、報告元と現場の確認時刻もいっしょに記録する
  const meta = { ...baseMeta, ...toReportMeta(report) };
  const stepLabel = (s: TransportStep) => config.transportPolicy.stepLabels[s] ?? s;
  const optional = new Set(config.transportPolicy.optionalSteps);
  // 要員の割り当てと指示は、搬送を指示できる役職がいる端末（本部・搬送指揮）だけで出す。部署の端末では出さない
  const canDirect = canDirectTransport(config, terminal);
  const status = statusLabels[t.status];
  const radioPlaces = [t.fromLocationId, t.toLocationId].filter((id) => !hasTerminal(config, id));
  const handoverPending = !!t.steps.arrived && !t.steps.arrived.handover && !t.steps.handedOver;
  // 本部の画面では、段階から「次にすること」を決めて大きく出す（部署の画面は focus で決まる）。断られた搬送はすべての操作を出す。
  // 病院設定で省略できる段階（optionalSteps）は、未記録でも飛ばして次の段階を出す
  const stagesInOrder = [
    ['accepted', 'accept'],
    ['staffAssigned', 'assign'],
    ['ordered', 'order'],
    ['departed', 'depart'],
  ] as const;
  // 出発済みなら、調整の段階が欠けていても次は「到着」（欠けた段階は「未記録」の印で示す）
  const stageNext: 'accept' | 'assign' | 'order' | 'depart' | 'arrive' | undefined = t.steps.declined
    ? undefined
    : t.steps.departed
      ? 'arrive'
      : (stagesInOrder.find(([step]) => !t.steps[step] && !optional.has(step) && (canDirect || (step !== 'staffAssigned' && step !== 'ordered')))?.[1] ?? 'arrive');
  const next = focus ?? stageNext;

  async function send(command: CommandInput, opts: { doneText?: string; overrideLabel?: string; undo?: { text: string; undoneText: string } } = {}) {
    setSending(true);
    const r = await run(
      (override) => ({ command, meta, expectedVersion: version, override }),
      {
        doneText: opts.doneText,
        overrideLabel: opts.overrideLabel,
        onAccepted: opts.undo
          ? ([event]) => event && showNotice(undoNotice({ run, event, meta: baseMeta, versionAfter: version + 1, ...opts.undo! }))
          : undefined,
      },
    );
    setSending(false);
    if (r === 'accepted') {
      setAction('none');
      setReport(emptyReportMeta);
    }
  }

  const recordDeparture = () =>
    send(
      { type: 'RecordDeparture', transportId: t.id, payload: {} },
      { undo: { text: `${t.id} の出発を記録しました`, undoneText: `${t.id} の出発の記録を取り消しました` } },
    );
  const recordArrival = () =>
    send(
      { type: 'RecordArrival', transportId: t.id, payload: {} },
      {
        undo: {
          text: `${t.id} の到着を記録しました（${t.patientId} の所在は${locationName(config, t.toLocationId)}）`,
          undoneText: `${t.id} の到着の記録を取り消しました`,
        },
      },
    );

  const allActions = (
          <div className="transport-actions no-print">
            <div className="button-row" role="group" aria-label={`${t.id} の調整（依頼したこと）`}>
              <span className="action-group-label">調整（依頼したこと）</span>
              <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'accept'} onClick={() => setAction(action === 'accept' ? 'none' : 'accept')}>
                了承を記録
              </button>
              <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'decline'} onClick={() => setAction(action === 'decline' ? 'none' : 'decline')}>
                断りを記録
              </button>
              {canDirect && (
                <>
                  <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'assign'} onClick={() => setAction(action === 'assign' ? 'none' : 'assign')}>
                    要員を割り当てる
                  </button>
                  <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'order'} onClick={() => setAction(action === 'order' ? 'none' : 'order')}>
                    指示を記録
                  </button>
                </>
              )}
              {/* 受領は押すとすぐ記録されるので、入力欄が開くボタン（▼）とは間をあける */}
              <button
                type="button"
                className="btn btn-apart"
                aria-describedby={`ack-hint-${t.id}`}
                disabled={sending || !enteredBy || !!t.steps.acknowledged}
                onClick={() =>
                  send(
                    { type: 'AcknowledgeTransport', transportId: t.id, payload: {} },
                    { undo: { text: `${t.id} の受領確認を記録しました`, undoneText: `${t.id} の受領確認を取り消しました` } },
                  )
                }
              >
                受領を記録
              </button>
              <span className="hint" id={`ack-hint-${t.id}`}>受領＝搬送要員が指示を受け取ったことの確認</span>
            </div>
            {!canDirect && <p className="hint">要員の割り当てと指示は、本部（搬送を指示する役職のいる端末）で行います。</p>}
            <div className="button-row" role="group" aria-label={`${t.id} の事実（起きたこと）`}>
              <span className="action-group-label">事実（起きたこと）</span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={sending || !enteredBy || !!t.steps.departed}
                onClick={recordDeparture}
              >
                出発を記録
              </button>
              {/* 出発と到着は押すとすぐ記録される。押し間違えないよう間をあけ、出発の前は到着を控えめな見た目にする */}
              <button
                type="button"
                className={`btn btn-apart ${t.steps.departed ? 'btn-primary' : ''}`}
                disabled={sending || !enteredBy}
                onClick={recordArrival}
              >
                到着を記録
              </button>
              <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'redirect'} onClick={() => setAction(action === 'redirect' ? 'none' : 'redirect')}>
                行き先を変える
              </button>
              <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'cancel'} onClick={() => setAction(action === 'cancel' ? 'none' : 'cancel')}>
                中止を記録
              </button>
            </div>
          </div>
  );

  const stepInfo = (s: TransportStep): string | null => {
    const r = t.steps[s];
    if (!r) return null;
    const time = formatTime(r.observedAt, now);
    if (s === 'accepted' && t.steps.accepted) return `${time}（${deciderLabel(config, t.steps.accepted.decidedBy)}）`;
    if (s === 'ordered' && t.steps.ordered) return `${time}（${deciderLabel(config, t.steps.ordered.orderedBy)}）`;
    if (s === 'staffAssigned') return `${time}（${t.transporterIds.map((id) => transporterName(config, id)).join('、')}）`;
    return time;
  };

  return (
    <li className={`transport transport-${t.status}`} data-testid={`transport-${t.id}`}>
      <div className="transport-head">
        <span className="transport-number">{t.id}</span>
        <span className={`transport-status status-${t.status}`} data-testid="transport-status">
          <span aria-hidden="true">{status.symbol}</span> {status.text}
        </span>
        <span className="transport-patient">
          {t.patientId} {p?.tagNumber && <>タッグ <strong>{p.tagNumber}</strong></>} <TriageBadge config={config} triage={p?.triage ?? null} />
        </span>
      </div>
      <div className="transport-route">
        {locationLabel(config, t.fromLocationId, now)} <span aria-hidden="true">▶</span>
        <span className="visually-hidden">から</span> {locationLabel(config, t.toLocationId, now)}
      </div>
      <div className="transport-meta">
        {t.methodId && <span>手段：{config.transportMethods.find((m) => m.id === t.methodId)?.name}</span>}
        {t.escorts.length > 0 && <span>付き添い：{t.escorts.map((e) => `${professionName(config, e.professionId)}${e.count}人`).join('、')}</span>}
        {p?.features && <span>特徴：{p.features}</span>}
        {t.note && <span>メモ：{t.note}</span>}
      </div>
      {radioPlaces.length > 0 && !t.closed && (
        <p className="radio-note">
          <span aria-hidden="true">〔無線〕</span>
          {radioPlaces.map((id) => locationName(config, id)).join('・')}には端末がありません。無線で伝え、返事をここに記録してください。
        </p>
      )}
      {t.redirects.length > 0 && (
        <p className="transport-redirects">
          行き先変更：{t.redirects.map((r) => `${locationName(config, r.fromLocationId)}→${locationName(config, r.toLocationId)}（${r.reason}）`).join('／')}
        </p>
      )}
      {t.steps.declined && (
        <p className="override-note">✕ 断り {formatTime(t.steps.declined.observedAt, now)}（{deciderLabel(config, t.steps.declined.decidedBy)}）：{t.steps.declined.reason}</p>
      )}
      {t.steps.cancelled && <p className="override-note">✕ 中止 {formatTime(t.steps.cancelled.observedAt, now)}：{t.steps.cancelled.reason}</p>}
      {t.steps.arrived && !t.steps.departed && <p className="missing-note">⚠ 出発未記録（到着は記録済み）</p>}
      {handoverPending && <p className="missing-note">⚠ 引き渡し未記録</p>}
      {t.overrides.length > 0 && <p className="override-note">⚠ 警告を承知で記録：{t.overrides.map((o) => o.reason).join('／')}</p>}

      <ol className="steps" aria-label={`${t.id} の段階`}>
        {transportSteps.map((s) => {
          const info = stepInfo(s);
          const skippable = optional.has(s);
          return (
            <li key={s} className={`step ${info ? 'step-done' : skippable ? 'step-optional' : 'step-missing'}`} data-testid={`step-${s}`}>
              <span aria-hidden="true">{info ? '✓' : skippable ? '・' : '－'}</span> {stepLabel(s)}
              <span className="step-info">{info ?? (skippable ? '未記録（省略可）' : '未記録')}</span>
            </li>
          );
        })}
      </ol>

      {!enteredBy && !t.closed && <p className="inline-alert no-print">⚠ 記録するには、先に画面上の一覧から自分の名前を押してください。</p>}
      {/* 無線・電話で受けた報告の欄は、押すとすぐ記録されるボタンより上に置く（先に確認時刻と報告元を入れられるように） */}
      {readOnly && !t.closed && <p className="hint no-print">ほかの部署の搬送です（見るだけ）。</p>}
      {!readOnly && (!t.steps.arrived || handoverPending) && !t.steps.cancelled && enteredBy && (
        <div className="no-print">
          <ReportMetaFields config={config} value={report} onChange={setReport} />
        </div>
      )}
      {!readOnly && !t.steps.arrived && !t.steps.cancelled &&
        (next === 'none' ? (
          <details className="more no-print">
            <summary>ほかの操作</summary>
            {allActions}
          </details>
        ) : next ? (
          <>
            {/* その搬送で次にすることだけを大きく出し、ほかは「ほかの操作」に折りたたむ（選択肢を絞って迷いと押し間違いを減らす） */}
            <div className="button-row focused-actions no-print" role="group" aria-label={`${t.id} で次にすること`}>
              <span className="action-group-label">次にすること</span>
              {next === 'accept' && (
                <>
                  <button type="button" className="btn btn-primary" disabled={sending || !enteredBy} aria-expanded={action === 'accept'} onClick={() => setAction(action === 'accept' ? 'none' : 'accept')}>
                    了承を記録
                  </button>
                  <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'decline'} onClick={() => setAction(action === 'decline' ? 'none' : 'decline')}>
                    断りを記録
                  </button>
                </>
              )}
              {next === 'assign' && (
                <button type="button" className="btn btn-primary" disabled={sending || !enteredBy} aria-expanded={action === 'assign'} onClick={() => setAction(action === 'assign' ? 'none' : 'assign')}>
                  要員を割り当てる
                </button>
              )}
              {next === 'order' && (
                <button type="button" className="btn btn-primary" disabled={sending || !enteredBy} aria-expanded={action === 'order'} onClick={() => setAction(action === 'order' ? 'none' : 'order')}>
                  指示を記録
                </button>
              )}
              {next === 'depart' && (
                <button type="button" className="btn btn-primary" disabled={sending || !enteredBy || !!t.steps.departed} onClick={recordDeparture}>
                  出発を記録
                </button>
              )}
              {next === 'arrive' && (
                <button type="button" className="btn btn-primary" disabled={sending || !enteredBy} onClick={recordArrival}>
                  到着を記録
                </button>
              )}
            </div>
            <details className="more no-print">
              <summary>ほかの操作</summary>
              {allActions}
            </details>
          </>
        ) : (
          allActions
        ))}
      {!readOnly && handoverPending && (
        <div className="transport-actions no-print">
          <button
            type="button"
            className="btn btn-primary"
            disabled={sending || !enteredBy}
            onClick={() => send({ type: 'RecordHandover', transportId: t.id, payload: {} }, { undo: { text: `${t.id} の引き渡しを記録しました`, undoneText: `${t.id} の引き渡しの記録を取り消しました` } })}
          >
            引き渡しを記録
          </button>
        </div>
      )}

      {(action === 'accept' || action === 'decline') && (
        <DecisionForm
          config={config}
          transport={t}
          kind={action}
          onCancel={() => setAction('none')}
          onSubmit={(decidedBy, text) =>
            action === 'accept'
              ? send(
                  { type: 'AcceptTransport', transportId: t.id, payload: { decidedBy, note: text || undefined } },
                  { doneText: `${t.id} の受け入れ了承を記録しました`, overrideLabel: '人数を超えても了承を記録する' },
                )
              : send({ type: 'DeclineTransport', transportId: t.id, payload: { decidedBy, reason: text } }, { doneText: `${t.id} の断りを記録しました` })
          }
        />
      )}
      {action === 'assign' && (
        <AssignForm
          config={config}
          state={state}
          transport={t}
          onCancel={() => setAction('none')}
          onSubmit={(transporterIds, teamId) =>
            send(
              { type: 'AssignTransportStaff', transportId: t.id, payload: { transporterIds, teamId } },
              { doneText: `${t.id} に搬送要員を割り当てました`, overrideLabel: '稼働中でも割り当てる' },
            )
          }
        />
      )}
      {action === 'order' && (
        <OrderForm
          config={config}
          onCancel={() => setAction('none')}
          onSubmit={(positionId) => send({ type: 'OrderTransport', transportId: t.id, payload: { orderedBy: { positionId, asDeputy: false } } }, { doneText: `${t.id} の指示を記録しました` })}
        />
      )}
      {action === 'redirect' && (
        <RedirectForm
          config={config}
          transport={t}
          now={now}
          onCancel={() => setAction('none')}
          onSubmit={(toLocationId, reason) => send({ type: 'RedirectTransport', transportId: t.id, payload: { toLocationId, reason } }, { doneText: `${t.id} の行き先を変えました` })}
        />
      )}
      {action === 'cancel' && (
        <ReasonForm
          label="中止の理由"
          submitLabel="中止を記録する"
          onCancel={() => setAction('none')}
          onSubmit={(reason) => send({ type: 'CancelTransport', transportId: t.id, payload: { reason } }, { doneText: `${t.id} の中止を記録しました` })}
        />
      )}
      <p className="transport-entered">
        要請 {formatTime(t.steps.requested.observedAt, now)}　入力 {staffName(config, t.steps.requested.enteredBy)}
      </p>
    </li>
  );
}

function DecisionForm(props: {
  config: HospitalConfig;
  transport: TransportView;
  kind: 'accept' | 'decline';
  onCancel: () => void;
  onSubmit: (decidedBy: { positionId?: string; staffId?: string; asDeputy: boolean }, text: string) => void;
}) {
  const { config, transport: t, kind, onCancel, onSubmit } = props;
  const leadPolicy = config.transportPolicy.acceptanceDecidedBy === 'location-lead';
  // 判断できる人の候補は病院設定から決める（責任者の役職、または到着先の職員）
  const positions = config.positions.filter((p) => p.locationId === t.toLocationId && (!leadPolicy || p.permissions.includes('accept-transport')));
  const staff = leadPolicy ? [] : config.staff.filter((s) => s.locationId === t.toLocationId);
  const [who, setWho] = useState(positions.length === 1 ? `position:${positions[0]!.id}` : '');
  const [deputy, setDeputy] = useState(false);
  const [text, setText] = useState('');
  const needsText = kind === 'decline';
  const ready = !!who && (!needsText || !!text.trim());

  return (
    <form
      className="action-form no-print"
      aria-label={kind === 'accept' ? '受け入れ了承の記録' : '断りの記録'}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        const [k, id] = who.split(':');
        onSubmit(k === 'position' ? { positionId: id, asDeputy: deputy } : { staffId: id, asDeputy: deputy }, text.trim());
      }}
    >
      <label className="field">
        <span>判断した人（{locationName(config, t.toLocationId)}）</span>
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">選んでください</option>
          {positions.map((p) => (
            <option key={p.id} value={`position:${p.id}`}>
              {p.name}
            </option>
          ))}
          {staff.map((s) => (
            <option key={s.id} value={`staff:${s.id}`}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {positions.length === 0 && staff.length === 0 && (
        <p className="inline-alert">⚠ 病院設定に、{locationName(config, t.toLocationId)}で受け入れを判断する役職がありません。</p>
      )}
      <label className="radio">
        <input type="checkbox" checked={deputy} onChange={(e) => setDeputy(e.target.checked)} />
        代行者が判断した
      </label>
      <label className="field">
        <span>{needsText ? '断りの理由（必ず書く）' : 'メモ（任意）'}</span>
        <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      </label>
      <p className="hint">入力者（あなた）と判断した人は別々に記録されます。</p>
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          {kind === 'accept' ? '了承を記録する' : '断りを記録する'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

const transporterStatusLabels = {
  idle: { symbol: '●', text: '待機' },
  assigned: { symbol: '▲', text: '割当済' },
  moving: { symbol: '▶', text: '移動中' },
  unavailable: { symbol: '✕', text: '対応不可' },
} as const;

function AssignForm(props: {
  config: HospitalConfig;
  state: AppState;
  transport: TransportView;
  onCancel: () => void;
  onSubmit: (ids: string[], teamId?: string) => void;
}) {
  const { config, state, transport: t, onCancel, onSubmit } = props;
  const [selected, setSelected] = useState<string[]>(t.transporterIds);
  const [teamId, setTeamId] = useState<string | undefined>(t.teamId);
  const toggle = (id: string) => {
    setTeamId(undefined);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  return (
    <form
      className="action-form no-print"
      aria-label="搬送要員の割り当て"
      onSubmit={(e) => {
        e.preventDefault();
        if (selected.length) onSubmit(selected, teamId);
      }}
    >
      {config.transporterTeams.length > 0 && (
        <div className="button-row" role="group" aria-label="班でまとめて選ぶ">
          {config.transporterTeams.map((team) => (
            <button
              key={team.id}
              type="button"
              className={`chip ${teamId === team.id ? 'is-selected' : ''}`}
              aria-pressed={teamId === team.id}
              onClick={() => {
                setSelected(team.members);
                setTeamId(team.id);
              }}
            >
              {teamId === team.id && '✓ '}
              {team.name}（{team.members.map((m) => transporterName(config, m)).join('・')}）
            </button>
          ))}
        </div>
      )}
      <div className="button-row" role="group" aria-label="搬送要員を1人ずつ選ぶ">
        {config.transporters.map((tr) => {
          const s = transporterStatus(state, tr.id);
          const label = transporterStatusLabels[s.status];
          const on = selected.includes(tr.id);
          const busyElsewhere = s.status === 'unavailable' || (s.transportId && s.transportId !== t.id);
          return (
            <button key={tr.id} type="button" className={`chip ${on ? 'is-selected' : ''} ${busyElsewhere ? 'is-busy' : ''}`} aria-pressed={on} onClick={() => toggle(tr.id)}>
              {on && '✓ '}
              {tr.name}
              <span className="btn-sub">
                {label.symbol} {label.text}
                {s.transportId && s.transportId !== t.id ? ` ${s.transportId}` : ''}
              </span>
            </button>
          );
        })}
      </div>
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={selected.length === 0}>
          {selected.length}人を割り当てる
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

function OrderForm({ config, onCancel, onSubmit }: { config: HospitalConfig; onCancel: () => void; onSubmit: (positionId: string) => void }) {
  const positions = config.positions.filter((p) => p.permissions.includes('direct-transport'));
  const [positionId, setPositionId] = useState(positions.length === 1 ? positions[0]!.id : '');
  return (
    <form
      className="action-form no-print"
      aria-label="指示の記録"
      onSubmit={(e) => {
        e.preventDefault();
        if (positionId) onSubmit(positionId);
      }}
    >
      <label className="field">
        <span>指示した人（本部）</span>
        <select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
          <option value="">選んでください</option>
          {positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!positionId}>
          指示を記録する
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

function RedirectForm(props: { config: HospitalConfig; transport: TransportView; now: Date; onCancel: () => void; onSubmit: (to: string, reason: string) => void }) {
  const { config, transport: t, now, onCancel, onSubmit } = props;
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  return (
    <form
      className="action-form no-print"
      aria-label="行き先の変更"
      onSubmit={(e) => {
        e.preventDefault();
        if (to && reason.trim()) onSubmit(to, reason.trim());
      }}
    >
      <label className="field">
        <span>新しい到着先</span>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">選んでください</option>
          {config.locations
            .filter((l) => l.id !== t.toLocationId)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {locationLabel(config, l.id, now)}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        <span>理由（必ず書く）</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
      </label>
      <p className="hint">行き先を変えると、受け入れ了承は新しい行き先で取り直します。</p>
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!to || !reason.trim()}>
          行き先を変える
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

function ReasonForm(props: { label: string; submitLabel: string; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="action-form no-print"
      aria-label={props.label}
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) props.onSubmit(reason.trim());
      }}
    >
      <label className="field">
        <span>{props.label}（必ず書く）</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
      </label>
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!reason.trim()}>
          {props.submitLabel}
        </button>
        <button type="button" className="btn btn-quiet" onClick={props.onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

// ---- 搬送要員の一覧 ----

function TransporterBoard({ config, state, terminal, enteredBy, now }: Props) {
  const { run, showNotice } = useCommands();
  if (config.transporters.length === 0) return null;
  // 要員の状態を変えるのは、搬送を指示できる端末（本部など）だけ。部署の端末では見るだけ
  const direct = canDirectTransport(config, terminal);
  return (
    <section className="panel" aria-labelledby="transporters-title" data-testid="transporter-board">
      <h2 id="transporters-title">搬送要員</h2>
      <ul className="transporter-list">
        {config.transporters.map((tr) => {
          const s = transporterStatus(state, tr.id);
          const label = transporterStatusLabels[s.status];
          const activity = state.transporters[tr.id];
          const version = versionOf(state, { kind: 'transporter', id: tr.id });
          const meta = { enteredBy: enteredBy ?? '', terminal, reportedBy: null };
          const setAvailable = (available: boolean) =>
            run(
              () => ({
                command: { type: 'SetTransporterAvailability', transporterId: tr.id, payload: { available } },
                meta,
                expectedVersion: version,
              }),
              {
                // 1回押すと記録されるので、押し間違えたときのために「元に戻す」を付ける
                onAccepted: ([event]) =>
                  event &&
                  showNotice(
                    undoNotice({
                      run,
                      event,
                      meta,
                      versionAfter: version + 1,
                      text: available ? `${tr.name} を待機に戻しました` : `${tr.name} を対応不可として記録しました`,
                      undoneText: `${tr.name} の${available ? '待機に戻す' : '対応不可'}の記録を取り消しました`,
                    }),
                  ),
              },
            );
          return (
            <li key={tr.id} className={`transporter transporter-${s.status}`} data-testid={`transporter-${tr.id}`}>
              <span className="transporter-name">{tr.name}</span>
              <span className={`transporter-status ts-${s.status}`}>
                <span aria-hidden="true">{label.symbol}</span> {label.text}
                {s.transportId && ` ${s.transportId}`}
              </span>
              <span className="transporter-place">
                {s.lastLocationId ? `最後の到着先：${locationName(config, s.lastLocationId)}` : ''}
                {s.status === 'unavailable' && activity?.availabilitySince && `（${formatTime(activity.availabilitySince, now)}から）`}
              </span>
              {!direct ? null : s.status === 'unavailable' ? (
                <button type="button" className="btn" disabled={!enteredBy} onClick={() => setAvailable(true)}>
                  待機に戻す
                </button>
              ) : (
                <button type="button" className="btn btn-quiet" disabled={!enteredBy} onClick={() => setAvailable(false)}>
                  対応不可にする
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
