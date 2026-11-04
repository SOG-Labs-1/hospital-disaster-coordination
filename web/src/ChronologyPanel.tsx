import { useMemo, useState, type FormEvent } from 'react';
import {
  describeEvent,
  eventCategoryLabels,
  messageChannelLabels,
  messageChannels,
  type DomainEvent,
  type EventCategory,
  type EventDescription,
  type HospitalConfig,
} from '@hdc/shared';
import { formatDateTime, formatTime, timeInputNote, timeInputToIso } from './format';
import { locationName, staffName } from './labels';
import { useCommands } from './useCommands';

interface Props {
  config: HospitalConfig;
  events: DomainEvent[];
  terminal: string;
  enteredBy: string | null;
  now: Date;
}

/** 一度に出す件数。多いときは「さらに表示」で増やす */
const PAGE = 200;

const kindLabels: Record<EventDescription['kind'], string> = {
  coordination: '調整',
  fact: '事実',
  report: '報告',
  record: '記録',
};

/**
 * 対応記録（クロノロジー）：すべての記録を時刻順に並べる。現場で確認した時刻と入力時刻、報告元と入力者、
 * 訂正・取り消しの関係を示す。記録は追記のみなので、訂正された記録も消さずに印を付けて残す
 */
export function ChronologyPanel(props: Props) {
  const { config, events, now } = props;
  const [category, setCategory] = useState<EventCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<'observed' | 'recorded'>('observed');
  const [limit, setLimit] = useState(PAGE);

  const rows = useMemo(() => {
    const byId = new Map(events.map((e) => [e.id, e]));
    // 訂正された記録 → 最後の訂正
    const corrections = new Map<string, DomainEvent>();
    for (const e of events) if (e.type === 'EventCorrected' && e.corrects) corrections.set(e.corrects, e);
    return events.map((e) => ({ e, d: describeEvent(e, config, (id) => byId.get(id)), correctedBy: corrections.get(e.id) }));
  }, [events, config]);

  const q = query.normalize('NFKC').trim().toUpperCase();
  const filtered = rows
    .filter((r) => category === 'all' || r.d.category === category)
    .filter((r) => {
      if (!q) return true;
      const related = r.e.type === 'MessageLogged' ? r.e.payload.relatedIds : [];
      const patient = r.e.type === 'TransportRequested' ? [r.e.payload.patientId] : [];
      return [r.d.subjectLabel, ...related, ...patient].some((x) => x.toUpperCase().includes(q)) || r.d.text.toUpperCase().includes(q);
    })
    .sort((a, b) => {
      const key = (x: DomainEvent) => Date.parse(order === 'observed' ? x.observedAt : x.recordedAt);
      return key(b.e) - key(a.e) || (a.e.id < b.e.id ? 1 : -1);
    });
  const shown = filtered.slice(0, limit);
  const categories = Object.keys(eventCategoryLabels) as EventCategory[];

  return (
    <div className="stack chronology">
      <MessageForm {...props} />
      <section className="panel" aria-labelledby="chrono-title">
        <div className="panel-head">
          <h2 id="chrono-title">
            対応記録 <span className="count" data-testid="chrono-count">{filtered.length}件</span>
          </h2>
          <button type="button" className="btn no-print" onClick={() => window.print()}>
            印刷する
          </button>
        </div>
        <div className="filter-row no-print" role="group" aria-label="種類で絞り込む">
          {(['all', ...categories] as const).map((c) => (
            <button key={c} type="button" className={`chip ${category === c ? 'is-selected' : ''}`} aria-pressed={category === c} onClick={() => setCategory(c)}>
              {category === c && '✓ '}
              {c === 'all' ? 'すべて' : eventCategoryLabels[c]}
            </button>
          ))}
        </div>
        <div className="field-row no-print">
          <label className="field">
            <span>番号・言葉で絞り込む（例：P-001、T-002）</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
          </label>
          <fieldset className="group">
            <legend>並べ方（新しい順）</legend>
            <div className="button-row">
              {(
                [
                  ['observed', '現場で確認した時刻'],
                  ['recorded', '入力した時刻'],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className={`chip ${order === v ? 'is-selected' : ''}`}>
                  <input type="radio" name="chrono-order" checked={order === v} onChange={() => setOrder(v)} />
                  {order === v && '✓ '}
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        {(category !== 'all' || q) && (
          <p className="print-only">
            絞り込み：{category === 'all' ? '' : eventCategoryLabels[category]} {query}（全{rows.length}件中{filtered.length}件）
          </p>
        )}

        {filtered.length === 0 ? (
          <p className="empty">{rows.length === 0 ? 'まだ記録はありません。' : '条件に合う記録はありません。'}</p>
        ) : (
          <table className="chrono-table" data-testid="chrono-table">
            <thead>
              <tr>
                <th scope="col">確認時刻</th>
                <th scope="col">種類</th>
                <th scope="col">対象</th>
                <th scope="col">内容</th>
                <th scope="col">報告元</th>
                <th scope="col">入力</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ e, d, correctedBy }) => {
                const lagMin = Math.round((Date.parse(e.recordedAt) - Date.parse(e.observedAt)) / 60000);
                const retracted = correctedBy?.type === 'EventCorrected' && correctedBy.payload.retract;
                return (
                  <tr key={e.id} className={`${retracted ? 'is-retracted' : ''} ${d.category === 'correction' ? 'is-correction' : ''}`} data-testid={`chrono-${e.id}`}>
                    <td className="chrono-time">
                      {formatTime(e.observedAt, now)}
                      {Math.abs(lagMin) >= 1 && <span className="chrono-lag">入力 {formatTime(e.recordedAt, now)}（{lagMin}分後）</span>}
                    </td>
                    <td>
                      <span className={`chrono-kind kind-${d.kind}`}>
                        {eventCategoryLabels[d.category]}・{kindLabels[d.kind]}
                      </span>
                    </td>
                    <td>
                      <button type="button" className="link-button" onClick={() => setQuery(d.subjectLabel)} title="この対象で絞り込む">
                        {d.subjectLabel}
                      </button>
                    </td>
                    <td className="chrono-text">
                      {d.text}
                      {e.override && <span className="chrono-note">⚠ 警告を承知で記録：{e.override.reason}</span>}
                      {correctedBy && (
                        <span className="chrono-note">
                          {retracted ? '〔取り消し済み〕' : '〔訂正済み〕'} {formatTime(correctedBy.recordedAt, now)}
                        </span>
                      )}
                    </td>
                    <td>{e.reportedBy ? [e.reportedBy.locationId && locationName(config, e.reportedBy.locationId), e.reportedBy.name].filter(Boolean).join('・') : '－'}</td>
                    <td className="chrono-who">
                      {staffName(config, e.enteredBy)}
                      <span>（{locationName(config, e.terminal)}）</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {filtered.length > limit && (
          <button type="button" className="btn no-print" onClick={() => setLimit(limit + PAGE)}>
            さらに表示（残り {filtered.length - limit}件）
          </button>
        )}
        <p className="print-only">出力 {formatDateTime(now)}　確認時刻は現場で確認した時刻。入力が1分以上後のものは入力時刻も併記</p>
      </section>
    </div>
  );
}

/** 無線・電話の連絡メモ。状態は変えず、やりとりをそのまま記録に残す */
function MessageForm({ config, terminal, enteredBy }: Props) {
  const { run } = useCommands();
  const [channel, setChannel] = useState<(typeof messageChannels)[number]>('radio');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [related, setRelated] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const relatedIds = related
    .normalize('NFKC')
    .toUpperCase()
    .split(/[\s,、]+/)
    .filter(Boolean);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!enteredBy || !text.trim() || busy) return;
    setBusy(true);
    const r = await run(
      () => ({
        command: { type: 'LogMessage', payload: { channel, fromLocationId: from || undefined, toLocationId: to || undefined, text: text.trim(), relatedIds } },
        meta: { enteredBy, terminal, reportedBy: from ? { locationId: from } : null, observedAt: timeInputToIso(time) },
      }),
      { doneText: '連絡メモ {id} を記録しました' },
    );
    setBusy(false);
    if (r === 'accepted') {
      setText('');
      setRelated('');
      setTime('');
    }
  }

  const locationOptions = config.locations.map((l) => (
    <option key={l.id} value={l.id}>
      {l.name}
    </option>
  ));

  return (
    <form className="panel no-print" onSubmit={onSubmit} aria-labelledby="message-title">
      <h2 id="message-title">連絡メモを残す</h2>
      <p className="hint">無線・電話で受けた連絡や伝えた内容を、そのまま記録に残します。患者や搬送の状態は変わりません。</p>
      <div className="field-row">
        <fieldset className="group">
          <legend>手段</legend>
          <div className="button-row">
            {messageChannels.map((c) => (
              <label key={c} className={`chip ${channel === c ? 'is-selected' : ''}`}>
                <input type="radio" name="message-channel" checked={channel === c} onChange={() => setChannel(c)} />
                {channel === c && '✓ '}
                {messageChannelLabels[c]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>発信元</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">（なし）</option>
            {locationOptions}
          </select>
        </label>
        <label className="field">
          <span>宛先</span>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">（なし）</option>
            {locationOptions}
          </select>
        </label>
      </div>
      <label className="field">
        <span>内容<em className="required">必須</em></span>
        <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" placeholder="例：○○病棟、受け入れ準備に10分かかる" />
      </label>
      <div className="field-row">
        <label className="field">
          <span>関係する番号（任意。例：P-001 T-002）</span>
          <input value={related} onChange={(e) => setRelated(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>連絡を受けた時刻（空欄＝今）</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        {timeInputNote(time) && <p className="hint time-note">ⓘ {timeInputNote(time)}</p>}
      </div>
      {!enteredBy && <p className="inline-alert">⚠ 先に、画面上の一覧から入力者を選んでください。</p>}
      <button type="submit" className="btn btn-primary" disabled={!enteredBy || !text.trim() || busy}>
        {busy ? '送信中…' : '連絡メモを記録する'}
      </button>
    </form>
  );
}
