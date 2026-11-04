import { useEffect, useRef, useState } from 'react';
import { sexLabels, type AppState, type DomainWarning, type HospitalConfig, type Override } from '@hdc/shared';
import { formatTime } from './format';
import { TriageBadge } from './Triage';

/** 重複などの警告。止めずに、既存の患者を開くか、理由を記録して実行するかを選ばせる */
export function WarningDialog(props: {
  config: HospitalConfig;
  state: AppState;
  warnings: DomainWarning[];
  confirmLabel: string;
  onOpenPatient: (patientId: string) => void;
  onConfirm: (override: Override) => void;
  onCancel: () => void;
}) {
  const { config, state, warnings, confirmLabel, onOpenPatient, onConfirm, onCancel } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const [reasonId, setReasonId] = useState<string>('');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const chosen = config.warningReasons.find((r) => r.id === reasonId);
  const needsDetail = chosen?.requiresDetail ?? false;
  const reason = [chosen?.label, detail.trim()].filter(Boolean).join('：');
  const canConfirm = !!chosen && !(needsDetail && !detail.trim());
  const related = [...new Set(warnings.flatMap((w) => w.relatedPatientIds))];
  const locationName = (id: string) => config.locations.find((l) => l.id === id)?.name ?? id;

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="warn-title" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <h2 id="warn-title">
        <span aria-hidden="true">⚠</span> 確認してください
      </h2>
      <ul className="warning-list">
        {warnings.map((w) => (
          <li key={w.code}>{w.message}</li>
        ))}
      </ul>

      <div className="dialog-choice">
        <h3>すでにいる患者（同じ人か確かめてください）</h3>
        <ul className="existing-list">
          {related.map((id) => {
            const p = state.patients[id];
            return (
              <li key={id} className="existing" data-testid={`existing-${id}`}>
                <div className="existing-head">
                  <strong className="existing-number">{id}</strong>
                  {p && <TriageBadge config={config} triage={p.triage} />}
                </div>
                {p && (
                  <dl className="existing-facts">
                    <div><dt>タッグ</dt><dd>{p.tagNumber ?? '未記入'}</dd></div>
                    <div><dt>所在</dt><dd>{locationName(p.locationId)}</dd></div>
                    <div>
                      <dt>特徴</dt>
                      <dd>{[p.sex !== 'unknown' && sexLabels[p.sex], p.estimatedAge, p.features].filter(Boolean).join('、') || '未記入'}</dd>
                    </div>
                    <div><dt>確認</dt><dd>{formatTime(p.lastObservedAt)}</dd></div>
                  </dl>
                )}
                <button type="button" className="btn" onClick={() => onOpenPatient(id)}>
                  同じ患者なので {id} を開く（記録しない）
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <form
        className="dialog-choice"
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) onConfirm({ codes: warnings.map((w) => w.code), reasonId, reason });
        }}
      >
        <h3>別の患者の場合は、理由を選んでください</h3>
        <fieldset className="radio-list">
          <legend className="visually-hidden">理由</legend>
          {config.warningReasons.map((r) => (
            <label key={r.id} className="radio">
              <input type="radio" name="reason" value={r.id} checked={reasonId === r.id} onChange={() => setReasonId(r.id)} />
              {r.label}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>補足{needsDetail ? '（必ず書く）' : '（任意）'}</span>
          <input type="text" value={detail} onChange={(e) => setDetail(e.target.value)} />
        </label>
        {!canConfirm && (
          <p className="hint" id="confirm-hint">
            {chosen ? '補足を書くと押せます。' : '理由を1つ選ぶと押せます。'}
          </p>
        )}
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={!canConfirm} aria-describedby={!canConfirm ? 'confirm-hint' : undefined}>
            {confirmLabel}
          </button>
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            やめる（記録しない）
          </button>
        </div>
      </form>
    </dialog>
  );
}
