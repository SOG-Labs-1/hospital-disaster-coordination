import { modeLabels, type HospitalConfig, type Mode } from '@hdc/shared';
import { formatTime } from './format';
import { TerminalSettings } from './TerminalSettings';
import type { SyncStatus } from './useEventLog';

/** 画面上部に常に表示する帯：災害運用／訓練、最終更新時刻、同期状態 */
export function TopBar(props: {
  config: HospitalConfig;
  mode: Mode;
  terminalName: string;
  status: SyncStatus;
  lastSyncedAt: Date | null;
  otherHospitals: boolean;
}) {
  const { config, mode, terminalName, status, lastSyncedAt } = props;
  const sync = {
    // 「接続中」は「つながっている」と読まれやすいので、状態を言い切る言葉にする
    connecting: { symbol: '…', text: 'つなぎ直しています' },
    connected: { symbol: '●', text: 'つながっています' },
    disconnected: { symbol: '✕', text: 'つながっていません（つなぎ直しています）' },
  }[status];
  return (
    <header className={`topbar topbar-${mode}`} role="banner">
      <div className={`mode-badge mode-${mode}`} data-testid="mode-badge">
        <span aria-hidden="true">{mode === 'live' ? '■' : '◇'}</span>
        {modeLabels[mode]}
        {mode === 'training' && <span className="mode-note">（訓練の記録です）</span>}
      </div>
      <div className="topbar-place">
        <span className="hospital-name">{config.name}</span>
        <span className="terminal-name">端末：{terminalName}</span>
      </div>
      <div className="topbar-status">
        <div className="last-updated">
          最終更新 <strong data-testid="last-updated">{formatTime(lastSyncedAt)}</strong>
        </div>
        <div className={`sync sync-${status}`} role="status" aria-live="polite" data-testid="sync-status">
          <span aria-hidden="true">{sync.symbol}</span> {sync.text}
        </div>
        <TerminalSettings mode={mode} hospitalId={config.id} />
      </div>
    </header>
  );
}
