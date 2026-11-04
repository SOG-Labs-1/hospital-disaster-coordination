import { useState } from 'react';
import type { Mode } from '@hdc/shared';
import { clearTerminal, setHospitalInUrl } from './session';

/**
 * 端末の設定（場所・病院）。入力者を選んでいなくても、いつでも上部の帯から開ける。
 * どれも押し間違えると困るので、確かめてから切り替える。
 * 災害運用と訓練の切り替えはここに置かない（同じ画面のままモードが変わる誤操作を防ぐ）。病院を選ぶ画面でだけ選ぶ
 */
export function TerminalSettings({ mode }: { mode: Mode }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | { text: string; run: () => void; label: string }>(null);
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
              <button
                type="button"
                className="btn"
                onClick={() =>
                  ask(
                    mode === 'training'
                      ? '病院を選ぶ画面に戻ります。災害運用に戻すときも、そこで「災害運用で開く」を押します。よいですか？'
                      : '病院を選ぶ画面に戻ります。よいですか？',
                    '病院を選び直す',
                    () => setHospitalInUrl(''),
                  )
                }
              >
                病院を変える
              </button>
              <p className="hint">災害運用と訓練の切り替えは、病院を選ぶ画面で行います。</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
