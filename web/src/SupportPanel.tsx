import { useState, type FormEvent } from 'react';
import {
  supportAlert,
  supportSteps,
  versionOf,
  type AppState,
  type CommandInput,
  type HospitalConfig,
  type SupportItem,
  type SupportStep,
  type SupportView,
} from '@hdc/shared';
import { formatTime } from './format';
import { deciderLabel, hasTerminal, locationName, professionName, staffName } from './labels';
import { emptyReportMeta, ReportMetaFields, toReportMeta, type ReportMetaValue } from './ReportMeta';
import { undoNotice } from './undo';
import { useCommands } from './useCommands';

interface Props {
  config: HospitalConfig;
  state: AppState;
  terminal: string;
  enteredBy: string | null;
  now: Date;
}

/** 「看護師 2人」「酸素ボンベ 3本」のように、何を求めるかを言葉にする */
export function itemText(config: HospitalConfig, it: SupportItem): string {
  const qty = (unit: string) => (it.quantity === null ? '（数は未確認）' : `${it.quantity}${unit}`);
  if (it.professionId) return `${professionName(config, it.professionId)} ${qty('人')}`;
  if (it.resourceId) {
    const r = config.resources.find((x) => x.id === it.resourceId);
    return `${r?.name ?? `設定にない物品（${it.resourceId}）`} ${qty(r?.unit ?? '')}`;
  }
  return [it.text, it.quantity !== null ? `${it.quantity}` : ''].filter(Boolean).join(' ');
}

export function SupportPanel(props: Props) {
  const { config, state, now } = props;
  const all = state.supportOrder.map((id) => state.supports[id]!).filter((s) => !s.retracted);
  const open = all.filter((s) => !s.closed);
  // 未対応・未完了の要請を先頭に出す
  const ranked = [...open].sort((a, b) => Number(!!supportAlert(b, config.supportPolicy, now)) - Number(!!supportAlert(a, config.supportPolicy, now)));
  const closed = all.filter((s) => s.closed);
  const alertCount = open.filter((s) => supportAlert(s, config.supportPolicy, now)).length;

  return (
    <div className="layout">
      <div className="no-print">
        <SupportRequestForm {...props} />
      </div>
      <div className="stack">
        <section className="panel" aria-labelledby="support-title">
          <div className="panel-head">
            <h2 id="support-title">
              支援要請 <span className="count">{open.length}件</span>
              {alertCount > 0 && (
                <span className="alert-count" data-testid="support-alert-count">
                  ⏱ 未対応・未完了 {alertCount}件
                </span>
              )}
            </h2>
            <button type="button" className="btn no-print" onClick={() => window.print()}>
              印刷する
            </button>
          </div>
          {open.length === 0 ? (
            <p className="empty">対応中の支援要請はありません。左の「支援を要請する」から記録します。</p>
          ) : (
            <ol className="transport-list" data-testid="support-list">
              {ranked.map((s) => (
                <SupportCard key={s.id} support={s} {...props} />
              ))}
            </ol>
          )}
        </section>
        {closed.length > 0 && (
          <details className="panel closed-transports">
            <summary>終わった要請（完了・中止） {closed.length}件</summary>
            <ol className="transport-list">
              {[...closed].reverse().map((s) => (
                <SupportCard key={s.id} support={s} {...props} />
              ))}
            </ol>
          </details>
        )}
      </div>
    </div>
  );
}

// ---- 要請の入力 ----

function SupportRequestForm({ config, terminal, enteredBy }: Props) {
  const { run } = useCommands();
  const terminalIsHq = config.locations.find((l) => l.id === terminal)?.kind === 'headquarters';
  const [fromLocationId, setFrom] = useState(terminalIsHq ? '' : terminal);
  const [kindId, setKind] = useState(config.supportKinds[0]?.id ?? '');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [report, setReport] = useState<ReportMetaValue>(emptyReportMeta);
  const [busy, setBusy] = useState(false);
  const kind = config.supportKinds.find((k) => k.id === kindId);
  const choices = kind?.itemSource === 'professions' ? config.professions : kind?.itemSource === 'resources' ? config.resources : [];

  const items: SupportItem[] =
    kind?.itemSource === 'none'
      ? text.trim()
        ? [{ text: text.trim(), quantity: null }]
        : []
      : choices.flatMap((c) => {
          const q = quantities[c.id];
          if (!q) return [];
          const key = kind?.itemSource === 'professions' ? 'professionId' : 'resourceId';
          return [{ [key]: c.id, quantity: q === '?' ? null : Number(q) } as SupportItem];
        });
  const missing = !fromLocationId ? '要請した場所を選ぶと記録できます。' : items.length === 0 ? '何を求めるかを入れると記録できます。' : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!enteredBy || missing || busy) return;
    setBusy(true);
    const m = toReportMeta(report);
    const r = await run(
      () => ({
        command: { type: 'RequestSupport', payload: { fromLocationId, kindId, items, note: note.trim() || undefined } },
        // 報告元を指定しなければ、要請した場所を報告元として記録する
        meta: { enteredBy, terminal, ...m, reportedBy: m.reportedBy ?? { locationId: fromLocationId } },
      }),
      { doneText: '{id} の支援要請を記録しました' },
    );
    setBusy(false);
    if (r === 'accepted') {
      setQuantities({});
      setText('');
      setNote('');
      setReport(emptyReportMeta);
    }
  }

  return (
    <form className="panel" onSubmit={onSubmit} aria-labelledby="support-request-title">
      <h2 id="support-request-title">支援を要請する</h2>
      <p className="hint">部署からの要請も、本部からの要請も、ここで記録します。</p>
      <label className="field">
        <span>要請した場所<em className="required">必須</em></span>
        <select value={fromLocationId} onChange={(e) => setFrom(e.target.value)}>
          <option value="">選んでください</option>
          {config.locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="group">
        <legend>種類</legend>
        <div className="button-row">
          {config.supportKinds.map((k) => (
            <label key={k.id} className={`chip ${kindId === k.id ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="support-kind"
                checked={kindId === k.id}
                onChange={() => {
                  setKind(k.id);
                  setQuantities({});
                }}
              />
              {kindId === k.id && '✓ '}
              {k.name}
            </label>
          ))}
        </div>
      </fieldset>
      {kind?.itemSource === 'none' ? (
        <label className="field">
          <span>何が必要か</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="例：発電機の燃料" autoComplete="off" />
        </label>
      ) : (
        <fieldset className="group">
          <legend>何をどれだけ（空欄は求めない）</legend>
          <div className="escort-grid">
            {choices.map((c) => (
              <label key={c.id} className="escort">
                <span>{c.name}</span>
                <span className="count-input">
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label={`${c.name}の数`}
                    value={quantities[c.id] === '?' ? '' : (quantities[c.id] ?? '')}
                    disabled={quantities[c.id] === '?'}
                    onChange={(e) => setQuantities({ ...quantities, [c.id]: e.target.value.normalize('NFKC').replace(/[^0-9]/g, '').replace(/^0+/, '') })}
                  />
                  <span className="count-unit">{'unit' in c ? String(c.unit) : '人'}</span>
                  <button
                    type="button"
                    className={`chip ${quantities[c.id] === '?' ? 'is-selected' : ''}`}
                    aria-pressed={quantities[c.id] === '?'}
                    aria-label={`${c.name}の数は未確認`}
                    onClick={() => setQuantities({ ...quantities, [c.id]: quantities[c.id] === '?' ? '' : '?' })}
                  >
                    数は未確認
                  </button>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="field">
        <span>メモ（任意）</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：夜勤明けで人手が足りない" autoComplete="off" />
      </label>
      <ReportMetaFields config={config} value={report} onChange={setReport} />
      {!enteredBy && <p className="inline-alert">⚠ 先に、画面上の一覧から入力者を選んでください。</p>}
      {enteredBy && missing && <p className="inline-alert">⚠ {missing}</p>}
      <button type="submit" className="btn btn-primary btn-wide" disabled={!enteredBy || !!missing || busy}>
        {busy ? '送信中…' : '支援を要請する'}
      </button>
    </form>
  );
}

// ---- 要請1件のカード ----

type Action = 'none' | 'assign' | 'dispatch' | 'cancel';

const statusLabels: Record<SupportView['status'], { symbol: string; text: string }> = {
  requested: { symbol: '○', text: '要請あり' },
  assigned: { symbol: '◎', text: '受付済み' },
  dispatched: { symbol: '▶', text: '手配済み' },
  received: { symbol: '◆', text: '受け取り済み' },
  completed: { symbol: '■', text: '完了' },
  cancelled: { symbol: '✕', text: '中止' },
};

export function SupportCard({ support: s, config, state, terminal, enteredBy, now, focus }: Props & { support: SupportView; focus?: 'receive' }) {
  const { run, showNotice } = useCommands();
  const [action, setAction] = useState<Action>('none');
  // 送っている間は、1回で記録されるボタンを押せなくする（二度押しで、成功の知らせが誤りの知らせに置き換わらないように）
  const [sending, setSending] = useState(false);
  const [report, setReport] = useState<ReportMetaValue>(emptyReportMeta);
  const version = versionOf(state, { kind: 'support', id: s.id });
  const baseMeta = { enteredBy: enteredBy ?? '', terminal, reportedBy: null };
  const meta = { ...baseMeta, ...toReportMeta(report) };
  const alert = supportAlert(s, config.supportPolicy, now);
  const status = statusLabels[s.status];
  const kindName = config.supportKinds.find((k) => k.id === s.kindId)?.name ?? s.kindId;
  const to = s.steps.dispatched?.toLocationId ?? s.fromLocationId;
  const stepLabel = (st: SupportStep) => config.supportPolicy.stepLabels[st] ?? st;

  async function send(command: CommandInput, opts: { doneText?: string; undo?: { text: string; undoneText: string } } = {}) {
    setSending(true);
    const r = await run(() => ({ command, meta, expectedVersion: version }), {
      doneText: opts.doneText,
      onAccepted: opts.undo ? ([event]) => event && showNotice(undoNotice({ run, event, meta: baseMeta, versionAfter: version + 1, ...opts.undo! })) : undefined,
    });
    setSending(false);
    if (r === 'accepted') {
      setAction('none');
      setReport(emptyReportMeta);
    }
  }

  const recordReceived = () =>
    send(
      { type: 'RecordSupportReceived', supportId: s.id, payload: {} },
      { undo: { text: `${s.id} の受け取りを記録しました`, undoneText: `${s.id} の受け取りを取り消しました` } },
    );

  const stepInfo = (st: SupportStep): string | null => {
    const r = st === 'requested' ? s.steps.requested : s.steps[st];
    if (!r) return null;
    const time = formatTime(r.observedAt, now);
    if (st === 'assigned' && s.steps.assigned) return `${time}（${deciderLabel(config, s.steps.assigned.assignee)}）`;
    if (st === 'dispatched' && s.steps.dispatched) {
      const d = s.steps.dispatched;
      const provider = d.providerLocationId ? locationName(config, d.providerLocationId) : d.providerName;
      return `${time}（${[provider && `${provider}から`, `${locationName(config, d.toLocationId)}へ`].filter(Boolean).join('')}）`;
    }
    return time;
  };

  return (
    <li className={`transport support support-${s.status} ${alert ? 'has-alert' : ''}`} data-testid={`support-${s.id}`}>
      <div className="transport-head">
        <span className="transport-number">{s.id}</span>
        <span className={`transport-status status-${s.status}`}>
          <span aria-hidden="true">{status.symbol}</span> {status.text}
        </span>
        {alert && (
          <span className="support-alert" data-testid="support-alert">
            ⏱ {alert.kind === 'unassigned' ? '未対応' : '未完了'} {alert.minutes}分
          </span>
        )}
      </div>
      <div className="transport-route">
        {locationName(config, s.fromLocationId)}から：{kindName}
      </div>
      <ul className="support-items">
        {s.items.map((it, i) => (
          <li key={i}>{itemText(config, it)}</li>
        ))}
      </ul>
      {s.note && <p className="transport-meta">メモ：{s.note}</p>}
      {s.messages.filter((m) => !state.retractedEventIds[m.eventId]).length > 0 && (
        <ul className="support-messages" aria-label={`${s.id} への連絡`} data-testid="support-messages">
          {s.messages
            .filter((m) => !state.retractedEventIds[m.eventId])
            .map((m) => (
              <li key={m.eventId}>
                <span aria-hidden="true">✉</span> {formatTime(m.recordedAt, now)} {m.fromLocationId ? `${locationName(config, m.fromLocationId)}から` : '連絡'}：{m.text}
              </li>
            ))}
        </ul>
      )}
      {alert && (
        <p className="missing-note">
          {alert.kind === 'unassigned'
            ? `⚠ 担当が付かないまま${alert.minutes}分たっています。受付をして担当を決めてください。`
            : `⚠ 手配の指示から${alert.minutes}分、受け取りの記録がありません。${locationName(config, to)}に確認してください。`}
        </p>
      )}
      {!s.closed && !hasTerminal(config, s.fromLocationId) && (
        <p className="radio-note">〔無線〕{locationName(config, s.fromLocationId)}には端末がありません。受け取ったかを無線で聞いて、ここに記録してください。</p>
      )}
      {s.steps.completed && !s.steps.received && <p className="missing-note">⚠ 受け取りの記録がないまま完了</p>}
      {s.steps.cancelled && <p className="override-note">✕ 中止 {formatTime(s.steps.cancelled.observedAt, now)}：{s.steps.cancelled.reason}</p>}

      <ol className="steps" aria-label={`${s.id} の段階`}>
        {supportSteps.map((st) => {
          const info = stepInfo(st);
          return (
            <li key={st} className={`step ${info ? 'step-done' : 'step-missing'}`} data-testid={`sstep-${st}`}>
              <span aria-hidden="true">{info ? '✓' : '－'}</span> {stepLabel(st)}
              <span className="step-info">{info ?? '未記録'}</span>
            </li>
          );
        })}
      </ol>

      {!enteredBy && !s.closed && <p className="inline-alert no-print">⚠ 記録するには、先に画面上の一覧から自分の名前を押してください。</p>}
      {/* 無線・電話で受けた報告の欄は、押すとすぐ記録されるボタンより上に置く（先に確認時刻と報告元を入れられるように） */}
      {!s.closed && enteredBy && (
        <div className="no-print">
          <ReportMetaFields config={config} value={report} onChange={setReport} />
        </div>
      )}
      {!s.closed && focus === 'receive' && (
        <div className="button-row focused-actions no-print">
          <button type="button" className="btn btn-primary" disabled={sending || !enteredBy || !!s.steps.received} onClick={recordReceived}>
            受け取り
          </button>
        </div>
      )}
      {!s.closed && (
        <>
          <div className="transport-actions no-print">
            <div className="button-row" role="group" aria-label={`${s.id} の対応`}>
              <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'assign'} onClick={() => setAction(action === 'assign' ? 'none' : 'assign')}>
                受付（担当を付ける）
              </button>
              <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'dispatch'} onClick={() => setAction(action === 'dispatch' ? 'none' : 'dispatch')}>
                手配を指示
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={sending || !enteredBy || !!s.steps.received}
                onClick={recordReceived}
              >
                受け取り
              </button>
              {/* 受け取りと完了は押すとすぐ記録される。押し間違えないよう間をあけ、受け取りの前は完了を控えめな見た目にする */}
              <button
                type="button"
                className={`btn btn-apart ${s.steps.received ? 'btn-primary' : ''}`}
                disabled={sending || !enteredBy}
                onClick={() =>
                  send(
                    { type: 'CompleteSupport', supportId: s.id, payload: {} },
                    { undo: { text: `${s.id} の完了を記録しました`, undoneText: `${s.id} の完了を取り消しました` } },
                  )
                }
              >
                完了
              </button>
              <button type="button" className="btn" disabled={sending || !enteredBy} aria-expanded={action === 'cancel'} onClick={() => setAction(action === 'cancel' ? 'none' : 'cancel')}>
                中止を記録
              </button>
            </div>
          </div>
        </>
      )}

      {action === 'assign' && (
        <AssignForm config={config} enteredBy={enteredBy} onCancel={() => setAction('none')} onSubmit={(staffId) => send({ type: 'AssignSupport', supportId: s.id, payload: { assignee: { staffId, asDeputy: false } } }, { doneText: `${s.id} の担当を記録しました` })} />
      )}
      {action === 'dispatch' && (
        <DispatchForm
          config={config}
          support={s}
          onCancel={() => setAction('none')}
          onSubmit={(payload) => send({ type: 'DispatchSupport', supportId: s.id, payload }, { doneText: `${s.id} の手配の指示を記録しました` })}
        />
      )}
      {action === 'cancel' && <CancelForm onCancel={() => setAction('none')} onSubmit={(reason) => send({ type: 'CancelSupport', supportId: s.id, payload: { reason } }, { doneText: `${s.id} の中止を記録しました` })} />}
      <p className="transport-entered">
        要請 {formatTime(s.steps.requested.observedAt, now)}　入力 {staffName(config, s.steps.requested.enteredBy)}
      </p>
    </li>
  );
}

function AssignForm({ config, enteredBy, onCancel, onSubmit }: { config: HospitalConfig; enteredBy: string | null; onCancel: () => void; onSubmit: (staffId: string) => void }) {
  // 既定は入力者自身が担当になる
  const [staffId, setStaffId] = useState(enteredBy ?? '');
  return (
    <form
      className="action-form no-print"
      aria-label="受付（担当）の記録"
      onSubmit={(e) => {
        e.preventDefault();
        if (staffId) onSubmit(staffId);
      }}
    >
      <label className="field">
        <span>担当者</span>
        <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">選んでください</option>
          {config.staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!staffId}>
          担当を記録する
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

function DispatchForm(props: {
  config: HospitalConfig;
  support: SupportView;
  onCancel: () => void;
  onSubmit: (payload: { providerLocationId?: string; providerName?: string; toLocationId?: string; orderedBy?: { positionId: string; asDeputy: boolean }; note?: string }) => void;
}) {
  const { config, support: s, onCancel, onSubmit } = props;
  const [provider, setProvider] = useState('');
  const [providerName, setProviderName] = useState('');
  const [toLocationId, setTo] = useState(s.fromLocationId);
  const [positionId, setPositionId] = useState('');
  const [note, setNote] = useState('');
  const ready = !!provider || !!providerName.trim();
  return (
    <form
      className="action-form no-print"
      aria-label="手配の指示の記録"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onSubmit({
          providerLocationId: provider || undefined,
          providerName: providerName.trim() || undefined,
          toLocationId: toLocationId === s.fromLocationId ? undefined : toLocationId,
          orderedBy: positionId ? { positionId, asDeputy: false } : undefined,
          note: note.trim() || undefined,
        });
      }}
    >
      <p className="hint">何を：{s.items.map((it) => itemText(config, it)).join('、')}（要請どおり）</p>
      <div className="field-row">
        <label className="field">
          <span>誰に（手配先の場所）</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">選んでください</option>
            {config.locations
              .filter((l) => l.id !== s.fromLocationId)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>院外・その他の手配先</span>
          <input value={providerName} onChange={(e) => setProviderName(e.target.value)} autoComplete="off" />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>どこへ</span>
          <select value={toLocationId} onChange={(e) => setTo(e.target.value)}>
            {config.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.id === s.fromLocationId ? '（要請した場所）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>指示した人（任意）</span>
          <select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
            <option value="">（記録しない）</option>
            {config.positions
              .filter((p) => p.permissions.includes('assign-support'))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>メモ（任意）</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
      </label>
      {!ready && <p className="hint">手配先を選ぶか書くと記録できます。</p>}
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          手配の指示を記録する
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

function CancelForm({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="action-form no-print"
      aria-label="中止の記録"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onSubmit(reason.trim());
      }}
    >
      <label className="field">
        <span>中止の理由（必ず書く）</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
      </label>
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!reason.trim()}>
          中止を記録する
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}
