import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { activeTransports, activeTransportsForLocation, effectiveConfig, modeLabels, modes, openSupports, openSupportsForLocation, supportAlert, type HospitalConfig, type Mode } from '@hdc/shared';
import { fetchConfig, fetchHospitals, setApiHospital, type HospitalList } from './api';
import { ChronologyPanel } from './ChronologyPanel';
import { DepartmentTab, PinnedRequests } from './DepartmentPanel';
import { DisplayBoard } from './DisplayBoard';
import { HospitalCreate } from './HospitalCreate';
import { EnteredByPicker } from './EnteredByPicker';
import { formatDateTime } from './format';
import { LocationBoard } from './LocationBoard';
import { PatientList } from './PatientList';
import { RegisterForm } from './RegisterForm';
import { modeMissingAfterTraining, readEnteredBy, readHospital, readMode, readTerminal, saveEnteredBy, setHospitalInUrl, setModeInUrl, setSessionHospital } from './session';
import { TerminalSetup } from './TerminalSetup';
import { TopBar } from './TopBar';
import { setTrainingHospital, useTraining } from './training';
import { ReviewPanel } from './ReviewPanel';
import { RadioInbox, TrainingTab } from './TrainingPanel';
import { SupportPanel } from './SupportPanel';
import { TransportPanel } from './TransportPanel';
import { CommandProvider, useCommands } from './useCommands';
import { useEventLog } from './useEventLog';

export function App() {
  const [config, setConfig] = useState<HospitalConfig | null>(null);
  const [list, setList] = useState<HospitalList | null>(null);
  const [needPick, setNeedPick] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // サーバーの起動が遅れても、つながるまで取り直す
    let stopped = false;
    const load = async () => {
      try {
        const l = await fetchHospitals();
        if (stopped) return;
        setList(l);
        const hospitalId = readHospital(
          l.hospitals.map((h) => h.id),
          l.defaultHospitalId,
        );
        if (!hospitalId) return setNeedPick(true);
        setApiHospital(hospitalId);
        setSessionHospital(hospitalId);
        setTrainingHospital(hospitalId);
        const c = await fetchConfig();
        if (!stopped) setConfig(c);
      } catch (e) {
        if (stopped) return;
        setError((e as Error).message);
        setTimeout(load, 2000);
      }
    };
    load();
    return () => {
      stopped = true;
    };
  }, []);

  // 病院を作る画面（病院を選ぶ画面から開く）
  if (new URLSearchParams(location.search).get('view') === 'create-hospital') return <HospitalCreate />;
  if (needPick && list) return <HospitalSetup list={list} />;
  if (!config && error) return <main className="setup"><p className="inline-alert">⚠ {error}。サーバーが起動しているか確認してください。</p></main>;
  if (!config) return <main className="setup"><p>読み込み中…</p></main>;

  // 掲示用画面（本部の大型モニター）は端末の場所も入力者も使わない
  if (new URLSearchParams(location.search).get('view') === 'board') {
    const boardMode = readMode();
    return boardMode ? <DisplayBoard config={config} mode={boardMode} /> : <ModeSetup />;
  }

  // 災害運用か訓練かを先に決める（決まらないまま端末の場所の画面に「災害運用」と出さないように）
  const mode = readMode();
  if (!mode) return <ModeSetup />;
  const terminal = readTerminal();
  if (!terminal || !config.locations.some((l) => l.id === terminal)) return <TerminalSetup config={config} mode={mode} otherHospitals={(list?.hospitals.length ?? 1) > 1} />;
  return <Headquarters config={config} terminal={terminal} mode={mode} otherHospitals={(list?.hospitals.length ?? 1) > 1} />;
}

/** 病院を選ぶ（複数の病院設定があり、既定の病院が決まっていないとき） */
function HospitalSetup({ list }: { list: HospitalList }) {
  return (
    <main className="setup">
      <h1>病院を選んでください</h1>
      <p>この端末で使う病院の設定を選びます。選んだ病院はこのブラウザに保存されます。訓練をするときは「訓練モードで開く」を押します（訓練の記録は災害運用とは別に保存されます）。</p>
      <ul className="hospital-list">
        {list.hospitals.map((h) => (
          <li key={h.id} className="hospital-choice">
            <h2>{h.name}</h2>
            <div className="button-row">
              <button type="button" className="btn btn-large btn-primary" onClick={() => setHospitalInUrl(h.id, 'live')}>
                ■ 災害運用で開く
              </button>
              <button type="button" className="btn btn-large" onClick={() => setHospitalInUrl(h.id, 'training')}>
                ◇ 訓練モードで開く
              </button>
            </div>
          </li>
        ))}
      </ul>
      {list.canCreate && (
        <a className="btn btn-large create-link" href="?view=create-hospital">
          ＋ 病院を作る
        </a>
      )}
    </main>
  );
}

/** ?mode= の値が正しくないときは、災害運用か訓練かを選び直させる（書き間違いで訓練の入力が災害運用に入らないように） */
function ModeSetup() {
  return (
    <main className="setup">
      <h1>災害運用か訓練かを選んでください</h1>
      <p className="inline-alert">
        {modeMissingAfterTraining()
          ? '⚠ 前回この端末では訓練モードを開いていました。アドレスに災害運用か訓練かの指定がないため、記録を開いていません。'
          : '⚠ アドレスの mode の指定が正しくないため、記録を開いていません。'}
      </p>
      <div className="button-grid">
        {modes.map((m) => (
          <button key={m} type="button" className="btn btn-large" onClick={() => setModeInUrl(m)}>
            {m === 'live' ? '■' : '◇'} {modeLabels[m]}で開く
          </button>
        ))}
      </div>
    </main>
  );
}

function Headquarters({ config, terminal, mode, otherHospitals }: { config: HospitalConfig; terminal: string; mode: Mode; otherHospitals: boolean }) {
  const { events, state, status, lastSyncedAt, loaded } = useEventLog(mode);
  // 病院設定に、記録で足した内容（画面から追加した入力者・場所の用途の変更）を合わせる
  const cfg = useMemo(() => effectiveConfig(config, state), [config, state]);
  // 画面から追加した入力者は記録を読み込んでから一覧に入るので、保存した名前はそのまま持ち、一覧にいるときだけ使う
  const [savedEnteredBy, setEnteredBy] = useState<string | null>(() => readEnteredBy(terminal));
  const enteredBy = cfg.staff.some((s) => s.id === savedEnteredBy) ? savedEnteredBy : null;
  const tick = useNow(mode === 'training' ? 1_000 : 30_000);
  // 新しい記録が届いたらすぐに時刻を進める。端末の時計が少し遅れていても、最新の記録の時刻より前にはしない
  // （例：いま変えた場所の用途が、次の時計の刻みまで画面に出ない、を防ぐ）
  const now = useMemo(() => {
    const latest = state.lastRecordedAt ? Date.parse(state.lastRecordedAt) : 0;
    return new Date(Math.max(Date.now(), tick.getTime(), latest));
  }, [tick, state]);
  const printedAt = usePrintTime();
  // 本部以外の端末は「各部署の画面」：上部に依頼を固定表示し、「この部署」タブを先頭に置く
  const isDepartment = config.locations.find((l) => l.id === terminal)?.kind !== 'headquarters';
  // 訓練モードの本部端末だけ、無線の受信と「訓練」タブを出す（参加者の役は本部）
  const training = useTraining(mode === 'training' && !isDepartment);
  // タブの件数：本部はすべて、部署はその部署に関係するものだけ
  const myTransports = isDepartment ? activeTransportsForLocation(state, terminal) : activeTransports(state);
  const mySupports = isDepartment ? openSupportsForLocation(state, terminal) : openSupports(state);
  const tabs = allTabs.filter((t) => (t.id !== 'department' || isDepartment) && (t.id !== 'training' || (mode === 'training' && !isDepartment && !!training)));
  const [tab, setTab] = useState<Tab>(() => readTab(`${config.id}.${terminal}`, tabs));
  const [preselect, setPreselect] = useState<string | null>(null);
  const clearPreselect = useCallback(() => setPreselect(null), []);
  const openTab = (t: Tab) => {
    setTab(t);
    saveTab(`${config.id}.${terminal}`, t);
  };
  const terminalName = config.locations.find((l) => l.id === terminal)?.name ?? terminal;

  useEffect(() => {
    document.title = `【${modeLabels[mode]}】${config.name} 調整ツール`;
  }, [mode, config.name]);

  return (
    <CommandProvider mode={mode} config={cfg} state={state}>
      <div className={`app app-${mode}`}>
        {/* 上部の帯と操作結果の知らせは、画面を下へ送っても常に見える位置に固定する（押した結果と「元に戻す」を見落とさない） */}
        <div className="sticky-head">
          <TopBar config={cfg} mode={mode} terminalName={terminalName} status={status} lastSyncedAt={lastSyncedAt} otherHospitals={otherHospitals} />
          <div className="no-print">
            <NoticeBar enteredBy={enteredBy} />
          </div>
        </div>
        <div className="print-header print-only">
          【{modeLabels[mode]}】{config.name} {tabs.find((t) => t.id === tab)!.printTitle}　出力 {formatDateTime(printedAt)}　（時刻は現場で確認した時刻）
        </div>
        <div className="no-print">
          <EnteredByPicker
            config={cfg}
            terminal={terminal}
            value={enteredBy}
            onChange={(id) => {
              setEnteredBy(id);
              saveEnteredBy(terminal, id);
            }}
          />
          {training && <RadioInbox config={cfg} snapshot={training} terminal={terminal} enteredBy={enteredBy} now={now} />}
          {isDepartment && (
            <PinnedRequests
              config={cfg}
              state={state}
              terminal={terminal}
              enteredBy={enteredBy}
              now={now}
              loaded={loaded}
              onChangeEnteredBy={(id) => {
                setEnteredBy(id);
                saveEnteredBy(terminal, id);
              }}
            />
          )}
          <nav className="tabs" role="tablist" aria-label="画面の切り替え">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="tab-panel"
                className={`tab ${tab === t.id ? 'is-selected' : ''}`}
                onClick={() => openTab(t.id)}
              >
                {/* ▼ は「押すと入力欄が開く」印に使うので、選んでいるタブは ● で示す */}
                {tab === t.id && <span aria-hidden="true">● </span>}
                {t.label}
                {/* 件数は赤の二重枠で目立たせる。部署の端末では、その部署に関係するものだけを数える（関係のない搬送・要請で目立たせない） */}
                {t.id === 'transports' && myTransports.length > 0 && (
                  <span className="tab-count tab-count-alert" aria-label={isDepartment ? `この部署に関係する搬送 ${myTransports.length}件` : `進行中の搬送 ${myTransports.length}件`}>
                    {myTransports.length}件
                  </span>
                )}
                {t.id === 'supports' && mySupports.length > 0 && (
                  <span className="tab-count tab-count-alert" aria-label={isDepartment ? `この部署に関係する支援要請 ${mySupports.length}件` : `対応中の支援要請 ${mySupports.length}件`}>
                    {mySupports.some((s) => supportAlert(s, config.supportPolicy, now)) && '⏱ '}
                    {mySupports.length}件
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
        <main id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="tab-panel">
          {tab === 'department' && (
            <DepartmentTab
              config={cfg}
              state={state}
              terminal={terminal}
              enteredBy={enteredBy}
              now={now}
              onRequestTransport={(patientId) => {
                setPreselect(patientId);
                openTab('transports');
              }}
            />
          )}
          {tab === 'patients' && (
            <div className="layout">
              <div className="no-print">
                <RegisterForm config={cfg} terminal={terminal} enteredBy={enteredBy} />
              </div>
              <PatientList
                config={cfg}
                state={state}
                terminal={terminal}
                enteredBy={enteredBy}
                now={now}
                onRequestTransport={(patientId) => {
                  setPreselect(patientId);
                  openTab('transports');
                }}
              />
            </div>
          )}
          {tab === 'transports' && (
            <TransportPanel
              config={cfg}
              state={state}
              terminal={terminal}
              enteredBy={enteredBy}
              now={now}
              preselectPatientId={preselect}
              onPreselectUsed={clearPreselect}
            />
          )}
          {tab === 'supports' && <SupportPanel config={cfg} state={state} terminal={terminal} enteredBy={enteredBy} now={now} />}
          {tab === 'training' && training && (
            <TrainingTab config={cfg} snapshot={training} terminal={terminal} enteredBy={enteredBy} now={now} review={<ReviewPanel snapshot={training} now={now} />} />
          )}
          {tab === 'chronology' && <ChronologyPanel config={cfg} events={events} terminal={terminal} enteredBy={enteredBy} now={now} />}
          {tab === 'locations' && <LocationBoard config={cfg} state={state} terminal={terminal} enteredBy={enteredBy} now={now} />}
        </main>
      </div>
    </CommandProvider>
  );
}

type Tab = 'department' | 'patients' | 'transports' | 'supports' | 'locations' | 'chronology' | 'training';
const allTabs: { id: Tab; label: string; printTitle: string }[] = [
  { id: 'department', label: 'この部署', printTitle: '部署の状況' },
  { id: 'patients', label: '患者', printTitle: '患者一覧' },
  { id: 'transports', label: '搬送', printTitle: '搬送一覧' },
  { id: 'supports', label: '支援要請', printTitle: '支援要請一覧' },
  { id: 'locations', label: '院内の状況', printTitle: '院内の状況' },
  { id: 'chronology', label: '対応記録', printTitle: '対応記録' },
  { id: 'training', label: '訓練', printTitle: '訓練の振り返り' },
];

function readTab(terminal: string, tabs: { id: Tab }[]): Tab {
  try {
    const t = localStorage.getItem(`hdc.tab.${terminal}`);
    return tabs.some((x) => x.id === t) ? (t as Tab) : tabs[0]!.id;
  } catch {
    return tabs[0]!.id;
  }
}
function saveTab(terminal: string, tab: Tab) {
  try {
    localStorage.setItem(`hdc.tab.${terminal}`, tab);
  } catch {
    /* 保存できなくても動く */
  }
}

function NoticeBar({ enteredBy }: { enteredBy: string | null }) {
  const { notice, showNotice } = useCommands();
  const stale = !!notice?.action && notice.owner !== undefined && notice.owner !== enteredBy;
  useEffect(() => {
    if (stale) showNotice(null);
  }, [stale, showNotice]);
  if (!notice || stale) return null;
  const symbol = { done: '✓', conflict: '⟳', error: '⚠', info: 'ⓘ' }[notice.kind];
  return (
    <div className={`notice notice-${notice.kind}`} role={notice.kind === 'done' ? 'status' : 'alert'} data-testid="notice">
      <span>
        <span aria-hidden="true">{symbol}</span> {notice.text}
      </span>
      <span className="button-row">
        {notice.action && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              // 「元に戻す」は一度だけ。押したら知らせから操作を外す（二度押しで「先に更新されました」と出ないように）
              const act = notice.action!;
              showNotice({ ...notice, action: undefined });
              act.onClick();
            }}
          >
            {notice.action.label}
          </button>
        )}
        <button type="button" className="btn btn-quiet" onClick={() => showNotice(null)}>
          閉じる
        </button>
      </span>
    </div>
  );
}

/** 印刷する瞬間の時刻（30秒ごとの時計では出力時刻が古くなるため） */
function usePrintTime(): Date {
  const [at, setAt] = useState(() => new Date());
  useEffect(() => {
    const onBeforePrint = () => flushSync(() => setAt(new Date()));
    window.addEventListener('beforeprint', onBeforePrint);
    return () => window.removeEventListener('beforeprint', onBeforePrint);
  }, []);
  return at;
}

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
