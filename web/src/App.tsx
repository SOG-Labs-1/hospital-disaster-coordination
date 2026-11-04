import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { modeLabels, modes, openSupports, supportAlert, type HospitalConfig, type Mode } from '@hdc/shared';
import { fetchConfig } from './api';
import { DepartmentTab, PinnedRequests } from './DepartmentPanel';
import { DisplayBoard } from './DisplayBoard';
import { EnteredByPicker } from './EnteredByPicker';
import { formatDateTime } from './format';
import { LocationBoard } from './LocationBoard';
import { PatientList } from './PatientList';
import { RegisterForm } from './RegisterForm';
import { readEnteredBy, readMode, readTerminal, saveEnteredBy, setModeInUrl } from './session';
import { TerminalSetup } from './TerminalSetup';
import { TopBar } from './TopBar';
import { SupportPanel } from './SupportPanel';
import { TransportPanel } from './TransportPanel';
import { CommandProvider, useCommands } from './useCommands';
import { useEventLog } from './useEventLog';

export function App() {
  const [config, setConfig] = useState<HospitalConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // サーバーの起動が遅れても、つながるまで取り直す
    let stopped = false;
    const load = () =>
      fetchConfig().then(
        (c) => !stopped && setConfig(c),
        (e: Error) => {
          if (stopped) return;
          setError(e.message);
          setTimeout(load, 2000);
        },
      );
    load();
    return () => {
      stopped = true;
    };
  }, []);

  if (!config && error) return <main className="setup"><p className="inline-alert">⚠ {error}。サーバーが起動しているか確認してください。</p></main>;
  if (!config) return <main className="setup"><p>読み込み中…</p></main>;

  // 掲示用画面（本部の大型モニター）は端末の場所も入力者も使わない
  if (new URLSearchParams(location.search).get('view') === 'board') {
    const boardMode = readMode();
    return boardMode ? <DisplayBoard config={config} mode={boardMode} /> : <ModeSetup />;
  }

  const terminal = readTerminal();
  if (!terminal || !config.locations.some((l) => l.id === terminal)) return <TerminalSetup config={config} />;
  const mode = readMode();
  if (!mode) return <ModeSetup />;
  return <Headquarters config={config} terminal={terminal} mode={mode} />;
}

/** ?mode= の値が正しくないときは、実運用か訓練かを選び直させる（書き間違いで訓練の入力が実運用に入らないように） */
function ModeSetup() {
  return (
    <main className="setup">
      <h1>実運用か訓練かを選んでください</h1>
      <p className="inline-alert">⚠ アドレスの mode の指定が正しくないため、記録を開いていません。</p>
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

function Headquarters({ config, terminal, mode }: { config: HospitalConfig; terminal: string; mode: Mode }) {
  const { state, status, lastSyncedAt } = useEventLog(mode);
  const [enteredBy, setEnteredBy] = useState<string | null>(() => {
    const saved = readEnteredBy(terminal);
    return config.staff.some((s) => s.id === saved) ? saved : null;
  });
  const now = useNow(30_000);
  const printedAt = usePrintTime();
  // 本部以外の端末は「各部署の画面」：上部に依頼を固定表示し、「この部署」タブを先頭に置く
  const isDepartment = config.locations.find((l) => l.id === terminal)?.kind !== 'headquarters';
  const tabs = isDepartment ? allTabs : allTabs.filter((t) => t.id !== 'department');
  const [tab, setTab] = useState<Tab>(() => readTab(terminal, tabs));
  const [preselect, setPreselect] = useState<string | null>(null);
  const clearPreselect = useCallback(() => setPreselect(null), []);
  const openTab = (t: Tab) => {
    setTab(t);
    saveTab(terminal, t);
  };
  const terminalName = config.locations.find((l) => l.id === terminal)?.name ?? terminal;

  useEffect(() => {
    document.title = `【${modeLabels[mode]}】${config.name} 調整ツール`;
  }, [mode, config.name]);

  return (
    <CommandProvider mode={mode} config={config} state={state}>
      <div className={`app app-${mode}`}>
        <TopBar config={config} mode={mode} terminalName={terminalName} status={status} lastSyncedAt={lastSyncedAt} />
        <div className="print-header print-only">
          【{modeLabels[mode]}】{config.name} {tabs.find((t) => t.id === tab)!.printTitle}　出力 {formatDateTime(printedAt)}　（時刻は現場で確認した時刻）
        </div>
        <div className="no-print">
          <EnteredByPicker
            config={config}
            terminal={terminal}
            value={enteredBy}
            onChange={(id) => {
              setEnteredBy(id);
              saveEnteredBy(terminal, id);
            }}
          />
          <NoticeBar />
          {isDepartment && (
            <PinnedRequests
              config={config}
              state={state}
              terminal={terminal}
              enteredBy={enteredBy}
              now={now}
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
                {tab === t.id && <span aria-hidden="true">▼ </span>}
                {t.label}
                {t.id === 'transports' && activeTransportCount(state) > 0 && <span className="tab-count">{activeTransportCount(state)}件</span>}
                {t.id === 'supports' && openSupports(state).length > 0 && (
                  <span className="tab-count">
                    {openSupports(state).some((s) => supportAlert(s, config.supportPolicy, now)) && '⏱ '}
                    {openSupports(state).length}件
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
        <main id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="tab-panel">
          {tab === 'department' && (
            <DepartmentTab
              config={config}
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
                <RegisterForm config={config} terminal={terminal} enteredBy={enteredBy} />
              </div>
              <PatientList
                config={config}
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
              config={config}
              state={state}
              terminal={terminal}
              enteredBy={enteredBy}
              now={now}
              preselectPatientId={preselect}
              onPreselectUsed={clearPreselect}
            />
          )}
          {tab === 'supports' && <SupportPanel config={config} state={state} terminal={terminal} enteredBy={enteredBy} now={now} />}
          {tab === 'locations' && <LocationBoard config={config} state={state} terminal={terminal} enteredBy={enteredBy} now={now} />}
        </main>
      </div>
    </CommandProvider>
  );
}

type Tab = 'department' | 'patients' | 'transports' | 'supports' | 'locations';
const allTabs: { id: Tab; label: string; printTitle: string }[] = [
  { id: 'department', label: 'この部署', printTitle: '部署の状況' },
  { id: 'patients', label: '患者', printTitle: '患者一覧' },
  { id: 'transports', label: '搬送', printTitle: '搬送一覧' },
  { id: 'supports', label: '支援要請', printTitle: '支援要請一覧' },
  { id: 'locations', label: '院内の状況', printTitle: '院内の状況' },
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

function activeTransportCount(state: import('@hdc/shared').AppState): number {
  return state.transportOrder.filter((id) => !state.transports[id]!.closed && !state.transports[id]!.retracted).length;
}

function NoticeBar() {
  const { notice, showNotice } = useCommands();
  if (!notice) return null;
  const symbol = { done: '✓', conflict: '⟳', error: '⚠', info: 'ⓘ' }[notice.kind];
  return (
    <div className={`notice notice-${notice.kind}`} role={notice.kind === 'done' ? 'status' : 'alert'} data-testid="notice">
      <span>
        <span aria-hidden="true">{symbol}</span> {notice.text}
      </span>
      <span className="button-row">
        {notice.action && (
          <button type="button" className="btn" onClick={notice.action.onClick}>
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
