import { useState, type FormEvent, type ReactNode } from 'react';
import type { HospitalConfig } from '@hdc/shared';
import { formatSim, liveSimMs, trainingPost, type TrainingSnapshot } from './training';
import { useCommands } from './useCommands';

// 訓練モードの本部の画面。参加者は本部の役で、他部署は AI（または mock）が担う。
// 部署役の連絡はボードを自動で更新しない。参加者が聞いて、自分でボードに入力する。

interface Props {
  config: HospitalConfig;
  snapshot: TrainingSnapshot;
  terminal: string;
  enteredBy: string | null;
  now: Date;
  /** 訓練が終わったあとの振り返り */
  review?: ReactNode;
}

const providerLabel = (p: string) => (p === 'anthropic' ? 'Claude（AI）' : 'mock（APIを使わない決まった返事）');

/** 上部に固定表示する「無線の受信」。聞いていない連絡を目立たせる */
export function RadioInbox({ config, snapshot, terminal, enteredBy, now }: Props) {
  const { run, showNotice } = useCommands();
  const unheard = [...snapshot.inbox].filter((m) => !m.heard).reverse();
  const heard = snapshot.inbox.filter((m) => m.heard).reverse();
  // フックは早期の return より前に置く（訓練が始まった瞬間にフックの数が変わると React が止まるため）
  const [draft, setDraft] = useState<{ messageId: string; text: string } | null>(null);
  if (!snapshot.run) return null;

  async function markHeard(messageId: string) {
    const r = await trainingPost('heard', { messageId });
    if (!r.ok) showNotice({ kind: 'error', text: r.error });
  }

  /**
   * 聞いた内容を、対応記録の連絡メモとして記録する（参加者の操作として）。
   * 部署役の言葉をそのまま記録にしないよう、下書きとして出して参加者が確かめ・直してから残す
   */
  async function logIt(m: TrainingSnapshot['inbox'][number], text: string) {
    if (!enteredBy || !text.trim()) return;
    const ok = await run(
      () => ({
        command: { type: 'LogMessage', payload: { channel: 'radio', fromLocationId: m.from, toLocationId: terminal, text: text.trim(), relatedIds: [] } },
        meta: { enteredBy, terminal, reportedBy: { locationId: m.from } },
      }),
      { doneText: '連絡メモ {id} として残しました' },
    );
    if (ok === 'accepted') {
      setDraft(null);
      await markHeard(m.messageId);
    }
  }

  return (
    <section className={`radio-inbox ${unheard.length ? 'has-items' : ''}`} aria-labelledby="radio-title" data-testid="radio-inbox">
      <h2 id="radio-title">
        <span aria-hidden="true">📻</span> 無線の受信 <span className="count">聞いていない {unheard.length}件</span>
        {snapshot.pendingReplies > 0 && <span className="radio-pending">… 本部からの連絡に、部署役が返事を考えています</span>}
      </h2>
      {unheard.length === 0 ? (
        <p className="hint">新しい連絡はありません。部署からの連絡はここに届きます（ボードは自動では変わりません）。</p>
      ) : (
        <ul className="radio-list">
          {unheard.map((m) => (
            <li key={m.messageId} className="radio-row" data-testid={`radio-${m.messageId}`}>
              <span className="radio-time">{formatSim(m.simMs)}</span>
              <span className="radio-from">{m.fromName}</span>
              <span className="radio-text">「{m.text}」</span>
              <span className="button-row">
                <button type="button" className="btn btn-primary" onClick={() => markHeard(m.messageId)}>
                  聞いた
                </button>
                <button type="button" className="btn" disabled={!enteredBy} aria-expanded={draft?.messageId === m.messageId} onClick={() => setDraft({ messageId: m.messageId, text: m.text })}>
                  連絡メモに残す
                </button>
              </span>
              {draft?.messageId === m.messageId && (
                <form
                  className="action-form radio-draft"
                  aria-label="連絡メモの下書き"
                  onSubmit={(e) => {
                    e.preventDefault();
                    logIt(m, draft.text);
                  }}
                >
                  <label className="field">
                    <span>聞いた内容（確かめて、必要なら直してから残す）</span>
                    <input value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} autoComplete="off" />
                  </label>
                  <div className="button-row">
                    <button type="submit" className="btn btn-primary" disabled={!draft.text.trim()}>
                      この内容で残す
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={() => setDraft(null)}>
                      やめる
                    </button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {heard.length > 0 && (
        <details className="more">
          <summary>聞いた連絡 {heard.length}件</summary>
          <ul className="radio-list is-heard">
            {heard.map((m) => (
              <li key={m.messageId} className="radio-row">
                <span className="radio-time">{formatSim(m.simMs)}</span>
                <span className="radio-from">{m.fromName}</span>
                <span className="radio-text">「{m.text}」</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {snapshot.providerFailures > 0 && (
        <p className="inline-alert" data-testid="provider-failures">
          ⚠ 部署役（AI）の返事に{snapshot.providerFailures}回失敗し、決まった返事で補いました。
        </p>
      )}
      <p className="radio-clock">
        訓練の経過 <strong>{formatSim(liveSimMs(snapshot, now))}</strong>
        {snapshot.run.ended ? '（終了）' : snapshot.run.running ? '' : '（一時停止中）'}
      </p>
    </section>
  );
}

/** 「訓練」タブ：シナリオの開始・一時停止・2倍速・終了、部署役への連絡、振り返り */
export function TrainingTab({ config, snapshot, now, review }: Props) {
  const { showNotice } = useCommands();
  const run = snapshot.run;
  const live = run && !run.ended;
  const [confirm, setConfirm] = useState<string | null>(null);

  async function control(body: Record<string, unknown>) {
    const r = await trainingPost('control', body);
    if (!r.ok) showNotice({ kind: 'error', text: r.error });
    setConfirm(null);
  }

  return (
    <div className="stack training">
      {live ? (
        <section className="panel" aria-labelledby="run-title" data-testid="training-run">
          <h2 id="run-title">{run.title}</h2>
          <div className="training-clock">
            <span className={`training-state ${run.running ? 'is-running' : 'is-paused'}`}>{run.running ? `▶ 進行中（${run.speed}倍速）` : '❚❚ 一時停止中'}</span>
            <span className="training-elapsed" data-testid="training-elapsed">
              {formatSim(liveSimMs(snapshot, now))} <span className="training-total">／ {formatSim(run.durationMs)}</span>
            </span>
          </div>
          <div className="button-row">
            {run.running ? (
              <button type="button" className="btn" onClick={() => control({ action: 'pause' })}>
                ❚❚ 一時停止
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => control({ action: 'resume' })}>
                ▶ 再開
              </button>
            )}
            {[1, 2].map((sp) => (
              <button key={sp} type="button" className={`chip ${run.speed === sp ? 'is-selected' : ''}`} aria-pressed={run.speed === sp} onClick={() => control({ action: 'speed', speed: sp })}>
                {run.speed === sp && '✓ '}
                {sp}倍速
              </button>
            ))}
            {confirm === 'end' ? (
              <>
                <span className="inline-alert">訓練を終えて振り返りに進みます。よいですか？</span>
                <button type="button" className="btn btn-primary" onClick={() => control({ action: 'end' })}>
                  終了する
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirm(null)}>
                  続ける
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirm('end')}>
                訓練を終える
              </button>
            )}
          </div>
          <p className="hint">部署役：{providerLabel(snapshot.provider)}。部署役の連絡は上の「無線の受信」に届きます。聞いた内容は、自分でボード（患者・搬送・支援要請・院内の状況）に入力してください。</p>
        </section>
      ) : (
        <section className="panel" aria-labelledby="scenario-title">
          <h2 id="scenario-title">訓練を始める</h2>
          <p className="hint">
            あなたは本部の役です。他部署は部署役（{providerLabel(snapshot.provider)}）が担います。新しい回を始めると、訓練のボードは空から始まります（前の回の記録は残ります）。
          </p>
          <ul className="scenario-list">
            {snapshot.scenarios.map((s) => (
              <li key={s.id} className="scenario" data-testid={`scenario-${s.id}`}>
                <h3>{s.title}</h3>
                <p>{s.description}</p>
                <p className="hint">
                  {s.durationMinutes}分　部署役：{s.roles.map((r) => r.name).join('、')}
                </p>
                {confirm === s.id ? (
                  <div className="button-row">
                    <button type="button" className="btn btn-primary" onClick={() => control({ action: 'start', scenarioId: s.id })}>
                      この訓練を始める
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={() => setConfirm(null)}>
                      やめる
                    </button>
                  </div>
                ) : (
                  <button type="button" className="btn" onClick={() => setConfirm(s.id)}>
                    この訓練を選ぶ
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {live && <MessageToRole config={config} snapshot={snapshot} />}
      {run?.ended && review}
    </div>
  );
}

/** 本部から部署役へ連絡する（無線で呼びかける）。返事は「無線の受信」に届く */
function MessageToRole({ snapshot }: { config: HospitalConfig; snapshot: TrainingSnapshot }) {
  const { showNotice } = useCommands();
  const roles = snapshot.scenarios.find((s) => s.id === snapshot.run?.scenarioId)?.roles ?? [];
  const [to, setTo] = useState(roles[0]?.locationId ?? '');
  const [text, setText] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!to || !text.trim()) return;
    const r = await trainingPost('message', { to, text });
    if (r.ok) {
      setText('');
      showNotice({ kind: 'done', text: `${roles.find((x) => x.locationId === to)?.name}へ連絡しました` });
    } else showNotice({ kind: 'error', text: r.error });
  }

  return (
    <section className="panel" aria-labelledby="send-title">
      <h2 id="send-title">部署へ無線で連絡する</h2>
      <form onSubmit={onSubmit} aria-label="部署への連絡">
        <fieldset className="group">
          <legend>宛先</legend>
          <div className="button-row">
            {roles.map((r) => (
              <label key={r.locationId} className={`chip ${to === r.locationId ? 'is-selected' : ''}`}>
                <input type="radio" name="radio-to" checked={to === r.locationId} onChange={() => setTo(r.locationId)} />
                {to === r.locationId && '✓ '}
                {r.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>伝えること</span>
          <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" placeholder="例：受け入れられるか確認します" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!to || !text.trim()}>
          無線で伝える
        </button>
      </form>
      {snapshot.outbox.length > 0 && (
        <ul className="radio-list is-heard" aria-label="本部から伝えたこと">
          {[...snapshot.outbox].reverse().map((m) => (
            <li key={m.messageId} className="radio-row">
              <span className="radio-time">{formatSim(m.simMs)}</span>
              <span className="radio-from">本部 → {m.toName}</span>
              <span className="radio-text">「{m.text}」</span>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">本部から伝えたことは、ボードには残りません。記録に残すときは対応記録の連絡メモを使います。</p>
    </section>
  );
}
