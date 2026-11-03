import { useEffect, useRef, useState } from 'react';
import type { DomainWarning, HospitalConfig, Override } from '@hdc/shared';

/** 重複などの警告。止めずに、既存の患者を開くか、理由を記録して実行するかを選ばせる */
export function WarningDialog(props: {
  config: HospitalConfig;
  warnings: DomainWarning[];
  onOpenPatient: (patientId: string) => void;
  onConfirm: (override: Override) => void;
  onCancel: () => void;
}) {
  const { config, warnings, onOpenPatient, onConfirm, onCancel } = props;
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
        <h3>同じ患者の場合</h3>
        <div className="button-row">
          {related.map((id) => (
            <button key={id} type="button" className="btn" onClick={() => onOpenPatient(id)}>
              既存の患者 {id} を開く
            </button>
          ))}
        </div>
      </div>

      <form
        className="dialog-choice"
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) onConfirm({ codes: warnings.map((w) => w.code), reasonId, reason });
        }}
      >
        <h3>別の患者として登録する場合は、理由を選んでください</h3>
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
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={!canConfirm}>
            理由を記録して実行する
          </button>
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            やめる
          </button>
        </div>
      </form>
    </dialog>
  );
}
