import { useState } from 'react';
import type { HospitalConfig } from '@hdc/shared';

/** 入力者を名前の一覧から1クリックで選ぶ */
export function EnteredByPicker(props: {
  config: HospitalConfig;
  terminal: string;
  value: string | null;
  onChange: (staffId: string | null) => void;
}) {
  const { config, terminal, value, onChange } = props;
  const [showAll, setShowAll] = useState(false);
  const current = config.staff.find((s) => s.id === value);
  const local = config.staff.filter((s) => s.locationId === terminal);
  const list = showAll || local.length === 0 ? config.staff : local;
  const profession = (id: string) => config.professions.find((p) => p.id === id)?.name ?? '';

  if (current) {
    return (
      <section className="entered-by entered-by-selected" aria-label="入力者">
        <span>
          入力者：<strong data-testid="entered-by">{current.name}</strong>（{profession(current.professionId)}）
        </span>
        <button type="button" className="btn btn-quiet" onClick={() => onChange(null)}>
          入力者を替える
        </button>
      </section>
    );
  }
  return (
    <section className="entered-by" aria-labelledby="entered-by-title">
      <h2 id="entered-by-title">入力する人の名前を押してください</h2>
      <div className="button-grid">
        {list.map((s) => (
          <button key={s.id} type="button" className="btn" onClick={() => onChange(s.id)}>
            {s.name}
            <span className="btn-sub">{profession(s.professionId)}</span>
          </button>
        ))}
      </div>
      {local.length > 0 && (
        <button type="button" className="btn btn-quiet" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'この場所の職員だけ表示する' : 'ほかの場所の職員も表示する'}
        </button>
      )}
    </section>
  );
}
