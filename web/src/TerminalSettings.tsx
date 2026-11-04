import { useState } from 'react';
import { modeLabels, type Mode } from '@hdc/shared';
import { clearTerminal, setHospitalInUrl, setModeInUrl } from './session';

/**
 * 端末の設定（場所・病院・実運用／訓練）。入力者を選んでいなくても、いつでも上部の帯から開ける。
 * どれも押し間違えると困るので、確かめてから切り替える
 */
export function TerminalSettings({ mode, otherHospitals }: { mode: Mode; otherHospitals: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | { text: string; run: () => void; label: string }>(null);
  const other: Mode = mode === 'live' ? 'training' : 'live';
  const ask = (text: string, label: string, run: () => void) => setConfirm({ text, label, run });

  return (
    <div className="terminal-settings no-print">
      <button type="button" className="btn settings-button" aria-expanded={open} aria-controls="terminal-settings-panel" onClick={() => {
        setOpen(!open);
        setConfirm(null);
      }}>
        <span aria-hidden="true">⚙</span> 端末の設定
      </button>
      {open && (
        <div id="terminal-settings-panel" className="settings-panel" role="dialog" aria-label="端末の設定">
          {confirm ? (
            <>
              <p className="settings-confirm">{confirm.text}</p>
              <div className="button-row">
                <button type="button" className="btn btn-primary" onClick={confirm.run}>
                  {confirm.label}
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirm(null)}>
                  やめる
                </button>
              </div>
            </>
          ) : (
            <div className="settings-actions">
              <button type="button" className="btn" onClick={() => ask('この端末を置いた場所を選び直します。よいですか？', '場所を選び直す', clearTerminal)}>
                端末の場所を変える
              </button>
              {otherHospitals && (
                <button type="button" className="btn" onClick={() => ask('別の病院を選び直します。よいですか？', '病院を選び直す', () => setHospitalInUrl(''))}>
                  病院を変える
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() =>
                  ask(
                    other === 'training'
                      ? '訓練モードに切り替えます。訓練の記録は、実運用とは別のファイルに保存されます。よいですか？'
                      : '実運用に戻します。ここから先の入力は実運用の記録になります。よいですか？',
                    `${modeLabels[other]}に切り替える`,
                    () => setModeInUrl(other),
                  )
                }
              >
                {other === 'training' ? '◇ 訓練モードに切り替える' : '■ 実運用に戻す'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
