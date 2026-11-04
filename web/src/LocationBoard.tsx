import { useState, type FormEvent } from 'react';
import {
  escortsAway,
  incomingTransports,
  locationView,
  patientsAtLocation,
  remainingCapacity,
  type AppState,
  type HospitalConfig,
  type Reported,
} from '@hdc/shared';
import { formatTime, minutesSince } from './format';
import { locationLabel, professionName } from './labels';
import { emptyReportMeta, ReportMetaFields, toReportMeta, type ReportMetaValue } from './ReportMeta';
import { TriageBadge } from './Triage';
import { useCommands } from './useCommands';

interface Props {
  config: HospitalConfig;
  state: AppState;
  terminal: string;
  enteredBy: string | null;
  now: Date;
}

/** 院内全体の状況。場所ごとの受け入れ可否・受け入れ可能人数・人員。未確認と0を区別し、古い確認に印を付ける */
/** 確認から病院設定の分数を過ぎた報告か */
export function makeIsStale(config: HospitalConfig, now: Date) {
  return (r: Reported<unknown> | undefined) => !!r?.confirmedAt && minutesSince(r.confirmedAt, now) >= config.staleAfterMinutes;
}

export function LocationBoard(props: Props) {
  const { config, state, now } = props;
  const isStale = makeIsStale(config, now);

  // 確認が古い・未確認の情報の一覧（情報の整理を促すため）
  const attention = config.locations.flatMap((l) => {
    const v = locationView(state, l.id);
    const items: string[] = [];
    if (v.accepting.confirmedAt === null || v.accepting.value === null) items.push('受け入れ可否が未確認');
    else if (isStale(v.accepting)) items.push(`受け入れ可否の確認が古い（${minutesSince(v.accepting.confirmedAt, now)}分前）`);
    const staleCount = Object.values(v.capacity).filter(isStale).length + Object.values(v.staff).filter(isStale).length;
    if (staleCount > 0) items.push(`確認が古い数値が${staleCount}件`);
    return items.length ? [{ id: l.id, items }] : [];
  });

  return (
    <div className="stack location-board">
      <section className="panel" aria-labelledby="attention-title">
        <div className="panel-head">
          <h2 id="attention-title">
            確認が古い・未確認の情報 <span className="count">{attention.length}か所</span>
          </h2>
          <button type="button" className="btn no-print" onClick={() => window.print()}>
            印刷する
          </button>
        </div>
        {attention.length === 0 ? (
          <p className="hint">すべての場所の受け入れ可否が、{config.staleAfterMinutes}分以内に確認されています。</p>
        ) : (
          <ul className="attention-list" data-testid="attention-list">
            {attention.map((a) => (
              <li key={a.id}>
                <span aria-hidden="true">⏱</span> <strong>{locationLabel(config, a.id, now)}</strong>：{a.items.join('、')}
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="location-grid">
        {config.locations.map((l) => (
          <LocationCard key={l.id} locationId={l.id} {...props} isStale={isStale} />
        ))}
      </div>
    </div>
  );
}

function ReportedValue<T>({ r, now, isStale, format }: { r: Reported<T> | undefined; now: Date; isStale: (r: Reported<unknown> | undefined) => boolean; format: (v: T) => string }) {
  if (!r?.confirmedAt) return <span className="unknown-value">未確認</span>;
  if (r.value === null) return <span className="unknown-value">未確認（{formatTime(r.confirmedAt, now)}に報告）</span>;
  return (
    <span className={isStale(r) ? 'stale' : ''}>
      <strong>{format(r.value)}</strong> <span className="confirmed-at">{formatTime(r.confirmedAt, now)}確認</span>
      {isStale(r) && <span className="stale-mark"> ⏱ 古い</span>}
    </span>
  );
}

export function LocationCard({ locationId, config, state, terminal, enteredBy, now, isStale }: Props & { locationId: string; isStale: (r: Reported<unknown> | undefined) => boolean }) {
  const [reporting, setReporting] = useState(false);
  const location = config.locations.find((l) => l.id === locationId)!;
  const v = locationView(state, locationId);
  const present = patientsAtLocation(state, locationId);
  const incoming = incomingTransports(state, locationId);
  const away = escortsAway(state, locationId);
  const triages = config.triageCategories.filter(
    (t) => config.capacity.some((c) => c.locationId === locationId && c.triage === t.id) || v.capacity[t.id] || present.some((p) => p.triage === t.id),
  );

  return (
    <section className="panel location" aria-labelledby={`loc-${locationId}`} data-testid={`location-${locationId}`}>
      <h3 id={`loc-${locationId}`} className="location-name">
        {locationLabel(config, locationId, now)}
      </h3>
      {!location.hasTerminal && <p className="radio-note">〔無線〕端末なし。報告は無線で受けて代わりに入力します。</p>}
      <dl className="location-facts">
        <div>
          <dt>受け入れ</dt>
          <dd data-testid="accepting">
            <ReportedValue r={v.accepting} now={now} isStale={isStale} format={(x) => (x ? '○ 受け入れ可' : '✕ 受け入れ不可')} />
          </dd>
        </div>
        <div>
          <dt>患者</dt>
          <dd>
            いま{present.length}人{incoming.length > 0 && `、向かっている${incoming.length}人`}
          </dd>
        </div>
      </dl>

      {triages.length > 0 && (
        <table className="capacity-table">
          <caption className="capacity-caption">空き ＝ 受け入れ枠 − いま居る人数 − 向かっている人数（了承済み・移動中）</caption>
          <thead>
            <tr>
              <th scope="col">区分</th>
              <th scope="col">受け入れ枠</th>
              <th scope="col">いま居る</th>
              <th scope="col">向かっている</th>
              <th scope="col">空き</th>
            </tr>
          </thead>
          <tbody>
            {triages.map((t) => {
              const r = remainingCapacity(config, state, locationId, t.id);
              const reported = v.capacity[t.id];
              return (
                <tr key={t.id} data-testid={`capacity-${t.id}`}>
                  <th scope="row">
                    <TriageBadge config={config} triage={t.id} />
                  </th>
                  <td>
                    {r.source === 'config' ? (
                      <span>
                        {r.value}人 <span className="confirmed-at">（設定の初期値・未確認）</span>
                      </span>
                    ) : (
                      <ReportedValue r={reported} now={now} isStale={isStale} format={(x) => `${x}人`} />
                    )}
                  </td>
                  <td>{r.present}人</td>
                  <td>{r.incoming}人</td>
                  <td className={r.remaining !== null && r.remaining <= 0 ? 'over' : ''}>
                    {r.remaining === null ? '－' : r.remaining <= 0 ? `⚠ ${r.remaining}人` : `${r.remaining}人`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <dl className="location-facts">
        <div>
          <dt>人員</dt>
          <dd>
            {/* 報告のない職種も「未確認」と出す（「いない」と読み違えないように） */}
            {config.professions.map((p) => {
              const r = v.staff[p.id];
              return (
                <span key={p.id} className="staff-count">
                  {p.name} <ReportedValue r={r} now={now} isStale={isStale} format={(x) => `${x}人`} />
                  {away[p.id] ? <span className="away">（うち付き添いで不在 {away[p.id]}人）</span> : null}
                </span>
              );
            })}
          </dd>
        </div>
        {(location.routeNote || v.note) && (
          <div>
            <dt>注意</dt>
            <dd>{[location.routeNote, v.note].filter(Boolean).join('／')}</dd>
          </div>
        )}
      </dl>

      <button type="button" className="btn no-print" disabled={!enteredBy} aria-expanded={reporting} onClick={() => setReporting(!reporting)}>
        状況の報告を記録
      </button>
      {reporting && <ReportForm config={config} locationId={locationId} terminal={terminal} enteredBy={enteredBy!} onDone={() => setReporting(false)} />}
    </section>
  );
}

type Tri = '' | 'yes' | 'no' | 'unknown';

/** 報告の入力。空欄の項目は変えない。「未確認」は未確認として記録する（0とは区別する） */
function ReportForm({ config, locationId, terminal, enteredBy, onDone }: { config: HospitalConfig; locationId: string; terminal: string; enteredBy: string; onDone: () => void }) {
  const { run } = useCommands();
  const [accepting, setAccepting] = useState<Tri>('');
  const [capacity, setCapacity] = useState<Record<string, string>>({});
  const [staff, setStaff] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [report, setReport] = useState<ReportMetaValue>(emptyReportMeta);
  const name = config.locations.find((l) => l.id === locationId)!.name;

  const toValue = (s: string | undefined) => (s === undefined || s === '' ? undefined : s === '?' ? null : Number(s));
  const capEntries = Object.entries(capacity).flatMap(([triage, s]) => (toValue(s) === undefined ? [] : [{ triage, value: toValue(s) as number | null }]));
  const staffEntries = Object.entries(staff).flatMap(([professionId, s]) => (toValue(s) === undefined ? [] : [{ professionId, value: toValue(s) as number | null }]));
  const hasStatus = accepting !== '' || capEntries.length > 0 || note.trim() !== '';
  const ready = hasStatus || staffEntries.length > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const meta = { enteredBy, terminal, ...toReportMeta(report, locationId) };
    if (hasStatus) {
      const r = await run(() => ({
        command: {
          type: 'ReportLocationStatus',
          locationId,
          payload: {
            ...(accepting === '' ? {} : { accepting: accepting === 'unknown' ? null : accepting === 'yes' }),
            capacity: capEntries,
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        },
        meta,
      }), { doneText: `${name}の状況を記録しました` });
      if (r !== 'accepted') return;
    }
    if (staffEntries.length > 0) {
      const r = await run(() => ({ command: { type: 'ReportStaffCount', locationId, payload: { counts: staffEntries } }, meta }), {
        doneText: `${name}の状況を記録しました`,
      });
      if (r !== 'accepted') return;
    }
    onDone();
  }

  const numberSelect = (value: string | undefined, onChange: (v: string) => void, label: string) => (
    <CountInput value={value ?? ''} onChange={onChange} label={label} />
  );

  return (
    <form className="action-form no-print" aria-label={`${name}の状況の報告`} onSubmit={onSubmit}>
      <p className="hint">報告元は{name}として記録します。「変えない」の項目は前の報告のまま残ります。</p>
      <fieldset className="group">
        <legend>受け入れ</legend>
        <div className="button-row">
          {(
            [
              ['', '変えない'],
              ['yes', '○ 受け入れ可'],
              ['no', '✕ 受け入れ不可'],
              ['unknown', '未確認'],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className={`chip ${accepting === v ? 'is-selected' : ''}`}>
              <input type="radio" name={`accepting-${locationId}`} checked={accepting === v} onChange={() => setAccepting(v)} />
              {accepting === v && '✓ '}
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="group">
        <legend>区分ごとの受け入れ可能人数</legend>
        <div className="escort-grid">
          {config.triageCategories.map((t) => (
            <label key={t.id} className="escort">
              <TriageBadge config={config} triage={t.id} />
              {numberSelect(capacity[t.id], (v) => setCapacity({ ...capacity, [t.id]: v }), `${t.label}の受け入れ可能人数`)}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="group">
        <legend>人員（職種ごと）</legend>
        <div className="escort-grid">
          {config.professions.map((p) => (
            <label key={p.id} className="escort">
              <span>{professionName(config, p.id)}</span>
              {numberSelect(staff[p.id], (v) => setStaff({ ...staff, [p.id]: v }), `${p.name}の人数`)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>メモ（任意）</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
      </label>
      <ReportMetaFields config={config} value={report} onChange={setReport} fixedLocationId={locationId} summary="報告した人・現場で確認した時刻" />
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          報告を記録する
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          やめる
        </button>
      </div>
    </form>
  );
}

/**
 * 人数の入力。空欄＝変えない、「未確認」＝未確認として記録（0とは区別する）。上限は設けない
 */
function CountInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const unknown = value === '?';
  return (
    <span className="count-input">
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={label}
        placeholder="変えない"
        value={unknown ? '' : value}
        disabled={unknown}
        onChange={(e) => onChange(e.target.value.normalize('NFKC').replace(/[^0-9]/g, ''))}
      />
      <span className="count-unit">人</span>
      <button type="button" className={`chip ${unknown ? 'is-selected' : ''}`} aria-pressed={unknown} aria-label={`${label}を未確認として記録`} onClick={() => onChange(unknown ? '' : '?')}>
        {unknown && '✓ '}未確認
      </button>
    </span>
  );
}
