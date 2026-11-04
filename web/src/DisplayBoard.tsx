import { useEffect, useState, type ReactNode } from 'react';
import {
  activePatients,
  activeTransports,
  locationView,
  modeLabels,
  openSupports,
  remainingCapacity,
  supportAlert,
  zonesForLocation,
  type AppState,
  type HospitalConfig,
  type Mode,
  type Reported,
} from '@hdc/shared';
import { formatTime, minutesSince } from './format';
import { locationLabel, locationName } from './labels';
import { itemText } from './SupportPanel';
import { TriageBadge } from './Triage';
import { useEventLog, type SyncStatus } from './useEventLog';

/** 一覧に出す最大件数。超えた分は「ほか N件」と出し、自動で送ったり画面を切り替えたりはしない */
const MAX_ROWS = 3;

const hhmm = (d: Date | string) => new Date(d).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

/**
 * 掲示用画面（本部の大型モニター）。操作なし・自動更新・勝手に切り替わらない。
 * 配置は画面の高さに対して固定し、記録が変わったときに値だけが変わる
 */
export function DisplayBoard({ config, mode }: { config: HospitalConfig; mode: Mode }) {
  const { state, status, lastSyncedAt } = useEventLog(mode);
  const now = useClock();
  const disconnected = status !== 'connected';

  useEffect(() => {
    document.title = `【${modeLabels[mode]}】${config.name} 掲示`;
  }, [mode, config.name]);

  return (
    <div className={`board board-${mode} ${disconnected ? 'board-disconnected' : ''}`} data-testid="display-board">
      <BoardHeader config={config} mode={mode} now={now} status={status} lastSyncedAt={lastSyncedAt} />
      {disconnected && (
        // 切断中は、離れていても分かるように幅いっぱいの警告を出す（画面が生きているように見せない）
        <div className="board-offline" role="alert" data-testid="board-offline">
          ✕ {status === 'connecting' ? '接続中' : '切断中'}　{lastSyncedAt ? `${hhmm(lastSyncedAt)} 以降の記録は映っていません` : 'まだ記録を受け取っていません'}
        </div>
      )}
      {lastSyncedAt ? (
        <main className="board-grid">
          <PatientCounts config={config} state={state} />
          <MovingTransports config={config} state={state} now={now} />
          <Attention config={config} state={state} now={now} />
          <Acceptance config={config} state={state} now={now} />
        </main>
      ) : (
        // 一度も記録を受け取っていないときは、0 と読み違えないよう数値を出さない
        <main className="board-waiting" data-testid="board-waiting">
          記録を受け取るまで、数値は表示しません
        </main>
      )}
    </div>
  );
}

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function BoardHeader(props: { config: HospitalConfig; mode: Mode; now: Date; status: SyncStatus; lastSyncedAt: Date | null }) {
  const { config, mode, now, status, lastSyncedAt } = props;
  const sync = { connecting: '… 接続中', connected: '● 同期中', disconnected: '✕ 切断' }[status];
  return (
    <header className={`board-header topbar-${mode}`}>
      <div className={`mode-badge mode-${mode}`} data-testid="mode-badge">
        <span aria-hidden="true">{mode === 'live' ? '■' : '◇'}</span>
        {modeLabels[mode]}
      </div>
      <div className="board-hospital">{config.name}</div>
      <div className="board-updated">
        最終更新 <strong>{lastSyncedAt ? hhmm(lastSyncedAt) : '—'}</strong>
      </div>
      <div className={`sync sync-${status} board-syncbadge`} data-testid="sync-status">
        {sync}
      </div>
      <div className="board-clock" aria-label="現在時刻">
        現在 {hhmm(now)}
      </div>
    </header>
  );
}

function Panel({ title, note, children, testId }: { title: string; note?: string; children: ReactNode; testId: string }) {
  return (
    <section className="board-panel" data-testid={testId}>
      <h2>
        {title}
        {note && <span className="board-note">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

function More({ total }: { total: number }) {
  return total > MAX_ROWS ? <p className="board-more">ほか {total - MAX_ROWS}件（本部の端末で確認）</p> : null;
}

/** 「古い」の札。記号ではなく文字と破線の枠で示す */
function OldTag() {
  return <span className="board-tag">古い</span>;
}

function PatientCounts({ config, state }: { config: HospitalConfig; state: AppState }) {
  const patients = activePatients(state);
  return (
    <Panel title={`患者 ${patients.length}人`} testId="board-patients">
      <ul className="board-counts">
        {[...config.triageCategories.map((t) => t.id), null].map((id) => (
          <li key={id ?? 'none'} data-testid={`board-count-${id ?? 'none'}`}>
            <TriageBadge config={config} triage={id} size="large" />
            <span className="board-number">{patients.filter((p) => p.triage === id).length}</span>
            <span>人</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function MovingTransports({ config, state, now }: { config: HospitalConfig; state: AppState; now: Date }) {
  // 長く移動している搬送ほど上に出す
  const moving = activeTransports(state)
    .filter((t) => t.steps.departed)
    .sort((a, b) => Date.parse(a.steps.departed!.observedAt) - Date.parse(b.steps.departed!.observedAt));
  return (
    <Panel title={`搬送中 ${moving.length}件`} testId="board-moving">
      {moving.length === 0 ? (
        <p className="board-empty">移動中の患者はいません</p>
      ) : (
        <ul className="board-list">
          {moving.slice(0, MAX_ROWS).map((t) => {
            const p = state.patients[t.patientId];
            return (
              <li key={t.id}>
                <div className="board-route">
                  {locationLabel(config, t.fromLocationId, now)} ▶ {locationLabel(config, t.toLocationId, now)}
                </div>
                <div className="board-sub">
                  <strong className="board-elapsed">{minutesSince(t.steps.departed!.observedAt, now)}分前に出発</strong>
                  <span className="board-id">
                    {t.patientId}
                    {p?.tagNumber && ` タッグ${p.tagNumber}`}
                  </span>
                  <TriageBadge config={config} triage={p?.triage ?? null} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <More total={moving.length} />
    </Panel>
  );
}

/** 対応が止まっているもの：受け入れの判断待ちの搬送、未対応・未完了の支援要請。種類に関係なく待ち時間の長い順 */
function Attention({ config, state, now }: { config: HospitalConfig; state: AppState; now: Date }) {
  const supports = openSupports(state).flatMap((s) => {
    const alert = supportAlert(s, config.supportPolicy, now);
    return alert
      ? [{ key: s.id, minutes: alert.minutes, main: `${alert.kind === 'unassigned' ? '未対応' : '未完了'} ${alert.minutes}分　${s.id} ${locationName(config, s.fromLocationId)}`, sub: s.items.map((it) => itemText(config, it)).join('、') }]
      : [];
  });
  const transports = activeTransports(state)
    .filter((t) => !t.steps.accepted && !t.steps.declined && !t.steps.departed)
    .map((t) => {
      const minutes = minutesSince(t.steps.requested.observedAt, now);
      return { key: t.id, minutes, main: `？ 受け入れ判断待ち ${minutes}分　${t.id} ${locationName(config, t.toLocationId)}`, sub: `${locationName(config, t.fromLocationId)}から` };
    });
  const rows = [...supports, ...transports].sort((a, b) => b.minutes - a.minutes);
  return (
    <Panel title={`対応待ち ${rows.length}件`} testId="board-attention">
      {rows.length === 0 ? (
        <p className="board-empty">止まっている要請・搬送はありません</p>
      ) : (
        <ul className="board-list">
          {rows.slice(0, MAX_ROWS).map((r) => (
            <li key={r.key}>
              <div className="board-route">{r.main}</div>
              <div className="board-sub">{r.sub}</div>
            </li>
          ))}
        </ul>
      )}
      <More total={rows.length} />
    </Panel>
  );
}

/** 災害時の用途（ゾーン）や受け入れ能力のある場所の受け入れ状況。場所が多くても収まるよう2列に並べる */
function Acceptance({ config, state, now }: { config: HospitalConfig; state: AppState; now: Date }) {
  const isOld = (r: Reported<unknown> | undefined) => !!r?.confirmedAt && minutesSince(r.confirmedAt, now) >= config.staleAfterMinutes;
  const places = config.locations.filter((l) => zonesForLocation(config, l.id, now.toISOString()).length > 0 || config.capacity.some((c) => c.locationId === l.id));
  return (
    <Panel title="受け入れ" note={`「古い」は確認から${config.staleAfterMinutes}分以上`} testId="board-acceptance">
      <ul className="board-places">
        {places.map((l) => {
          const v = locationView(state, l.id);
          const caps = config.triageCategories.filter((t) => config.capacity.some((c) => c.locationId === l.id && c.triage === t.id) || v.capacity[t.id]);
          return (
            <li key={l.id} data-testid={`board-place-${l.id}`}>
              <span className="board-place-name">{locationLabel(config, l.id, now)}</span>
              <span className={v.accepting.value === null ? 'unknown-value' : 'board-accepting'}>
                {v.accepting.value === null ? '受け入れ未確認' : v.accepting.value ? '○ 受け入れ可' : '✕ 受け入れ不可'}
              </span>
              {isOld(v.accepting) && <OldTag />}
              {caps.map((t) => {
                const r = remainingCapacity(config, state, l.id, t.id);
                return (
                  <span key={t.id} className="board-cap">
                    {t.symbol}
                    {t.label}
                    {/* 設定の初期値は確認済みの数字に見せない（未確認を先に、目安を後に） */}
                    {r.source === 'reported' ? (
                      <> 残り{r.remaining}{isOld(v.capacity[t.id]) && <OldTag />}</>
                    ) : (
                      <span className="unknown-value">残り未確認{r.value !== null && `（目安${r.remaining}）`}</span>
                    )}
                  </span>
                );
              })}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
