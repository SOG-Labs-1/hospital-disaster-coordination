import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { modeLabels, modes, type HospitalConfig, type Mode } from '@hdc/shared';
import { fetchConfig } from './api';
import { EnteredByPicker } from './EnteredByPicker';
import { formatDateTime } from './format';
import { PatientList } from './PatientList';
import { RegisterForm } from './RegisterForm';
import { readEnteredBy, readMode, readTerminal, saveEnteredBy, setModeInUrl } from './session';
import { TerminalSetup } from './TerminalSetup';
import { TopBar } from './TopBar';
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
  const terminalName = config.locations.find((l) => l.id === terminal)?.name ?? terminal;

  useEffect(() => {
    document.title = `【${modeLabels[mode]}】${config.name} 調整ツール`;
  }, [mode, config.name]);

  return (
    <CommandProvider mode={mode} config={config} state={state}>
      <div className={`app app-${mode}`}>
        <TopBar config={config} mode={mode} terminalName={terminalName} status={status} lastSyncedAt={lastSyncedAt} />
        <div className="print-header print-only">
          【{modeLabels[mode]}】{config.name} 患者一覧　出力 {formatDateTime(printedAt)}　（各患者の「確認」は現場で確認した時刻）
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
        </div>
        <main className="layout">
          <div className="no-print">
            <RegisterForm config={config} terminal={terminal} enteredBy={enteredBy} />
          </div>
          <PatientList config={config} state={state} terminal={terminal} enteredBy={enteredBy} now={now} />
        </main>
      </div>
    </CommandProvider>
  );
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
