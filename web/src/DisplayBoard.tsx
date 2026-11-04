import { useEffect, useState } from 'react';
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
} from '@hdc/shared';
import { formatTime, minutesSince } from './format';
import { locationLabel, locationName } from './labels';
import { itemText } from './SupportPanel';
import { TriageBadge } from './Triage';
import { useEventLog, type SyncStatus } from './useEventLog';

/** 一覧に出す最大件数。超えた分は「ほか N件」と出し、自動で送ったり画面を切り替えたりはしない */
const MAX_ROWS = 3;

/**
 * 掲示用画面（本部の大型モニター）。操作なし・自動更新・勝手に切り替わらない。
 * 表示する内容と配置は固定で、記録が変わったときに値だけが変わる
 */
export function DisplayBoard({ config, mode }: { config: HospitalConfig; mode: Mode }) {
  const { state, status, lastSyncedAt } = useEventLog(mode);
  const now = useClock();

  useEffect(() => {
    document.title = `【${modeLabels[mode]}】${config.name} 掲示`;
  }, [mode, config.name]);

  return (
    <div className={`board board-${mode}`} data-testid="display-board">
      <BoardHeader config={config} mode={mode} now={now} status={status} lastSyncedAt={lastSyncedAt} />
      <main className="board-grid">
        <PatientCounts config={config} state={state} />
        <MovingTransports config={config} state={state} now={now} />
        <Attention config={config} state={state} now={now} />
        <Acceptance config={config} state={state} now={now} />
      </main>
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
  const sync = { connecting: '… 接続中', connected: '● 同期中', disconnected: '✕ 切断（再接続中）' }[status];
  return (
    <header className={`board-header topbar-${mode}`}>
      <div className={`mode-badge mode-${mode}`} data-testid="mode-badge">
        <span aria-hidden="true">{mode === 'live' ? '■' : '◇'}</span>
        {modeLabels[mode]}
      </div>
      <div className="board-hospital">{config.name}</div>
      <div className="board-clock" aria-label="現在時刻">
        {now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="board-sync">
        <div>最終更新 {formatTime(lastSyncedAt, now)}</div>
        <div className={`sync sync-${status}`} data-testid="sync-status">
          {sync}
        </div>
      </div>
    </header>
  );
}

function Panel({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="board-panel" data-testid={testId}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function More({ total }: { total: number }) {
  return total > MAX_ROWS ? <p className="board-more">ほか {total - MAX_ROWS}件（本部の端末で確認）</p> : null;
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
  const moving = activeTransports(state).filter((t) => t.steps.departed);
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
                  {t.patientId}
                  {p?.tagNumber && ` タッグ${p.tagNumber}`} <TriageBadge config={config} triage={p?.triage ?? null} />　出発 {formatTime(t.steps.departed!.observedAt, now)}（{minutesSince(t.steps.departed!.observedAt, now)}分前）
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

/** 対応が止まっているもの：受け入れの判断待ちの搬送、未対応・未完了の支援要請 */
function Attention({ config, state, now }: { config: HospitalConfig; state: AppState; now: Date }) {
  const waiting = activeTransports(state).filter((t) => !t.steps.accepted && !t.steps.declined && !t.steps.departed);
  const supports = openSupports(state)
    .map((s) => ({ s, alert: supportAlert(s, config.supportPolicy, now) }))
    .filter((x) => x.alert);
  const rows = [
    ...supports.map(({ s, alert }) => ({
      key: s.id,
      main: `⏱ ${alert!.kind === 'unassigned' ? '未対応' : '未完了'} ${alert!.minutes}分　${s.id} ${locationName(config, s.fromLocationId)}`,
      sub: s.items.map((it) => itemText(config, it)).join('、'),
    })),
    ...waiting.map((t) => ({
      key: t.id,
      main: `○ 受け入れ判断待ち　${t.id} ${locationName(config, t.toLocationId)}`,
      sub: `${locationName(config, t.fromLocationId)}から　要請 ${formatTime(t.steps.requested.observedAt, now)}（${minutesSince(t.steps.requested.observedAt, now)}分前）`,
    })),
  ];
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

/** 災害時の用途（ゾーン）が割り当てられた場所の受け入れ状況 */
function Acceptance({ config, state, now }: { config: HospitalConfig; state: AppState; now: Date }) {
  const places = config.locations.filter((l) => zonesForLocation(config, l.id, now.toISOString()).length > 0 || config.capacity.some((c) => c.locationId === l.id));
  return (
    <Panel title="受け入れ" testId="board-acceptance">
      <table className="board-table">
        <tbody>
          {places.map((l) => {
            const v = locationView(state, l.id);
            const accepting = v.accepting.value === null ? '未確認' : v.accepting.value ? '○ 可' : '✕ 不可';
            const stale = v.accepting.confirmedAt && minutesSince(v.accepting.confirmedAt, now) >= config.staleAfterMinutes;
            const caps = config.triageCategories.filter((t) => config.capacity.some((c) => c.locationId === l.id && c.triage === t.id) || v.capacity[t.id]);
            return (
              <tr key={l.id} data-testid={`board-place-${l.id}`}>
                <th scope="row">{locationLabel(config, l.id, now)}</th>
                <td className={v.accepting.value === null ? 'unknown-value' : ''}>
                  {accepting}
                  {stale && ' ⏱'}
                </td>
                <td>
                  {caps.map((t) => {
                    const r = remainingCapacity(config, state, l.id, t.id);
                    return (
                      <span key={t.id} className="board-cap">
                        {t.symbol}
                        {t.label} 残り{r.remaining === null ? '未確認' : `${r.remaining}`}
                        {r.source === 'config' && '*'}
                      </span>
                    );
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="board-note">* は病院設定の初期値（未確認）　⏱ は確認が{config.staleAfterMinutes}分以上前</p>
    </Panel>
  );
}
