import { useState, type FormEvent } from 'react';
import type { HospitalConfig } from '@hdc/shared';
import { useCommands } from './useCommands';

/** 入力者を名前の一覧から1クリックで選ぶ。一覧にいなければ、その場で名前を追加できる */
export function EnteredByPicker(props: {
  config: HospitalConfig;
  terminal: string;
  value: string | null;
  onChange: (staffId: string | null) => void;
}) {
  const { config, terminal, value, onChange } = props;
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
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
      <div className="button-row">
        {local.length > 0 && (
          <button type="button" className="btn btn-quiet" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'この場所の職員だけ表示する' : 'ほかの場所の職員も表示する'}
          </button>
        )}
        <button type="button" className="btn" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          ＋ 一覧にない名前を追加する
        </button>
      </div>
      {adding && (
        <AddStaffForm
          config={config}
          terminal={terminal}
          onAdded={(id) => {
            setAdding(false);
            onChange(id);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </section>
  );
}

/** 入力者の追加。フルネーム・部署・職種は必須、職員番号は任意。追加した本人がそのまま入力者になる */
function AddStaffForm({ config, terminal, onAdded, onCancel }: { config: HospitalConfig; terminal: string; onAdded: (id: string) => void; onCancel: () => void }) {
  const { run } = useCommands();
  const terminalIsDept = config.locations.some((l) => l.id === terminal);
  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState(terminalIsDept ? terminal : '');
  const [professionId, setProfessionId] = useState('');
  const [staffNumber, setStaffNumber] = useState('');
  const missing = name.trim().length < 2 ? 'フルネームを書くと追加できます。' : !locationId ? '部署を選ぶと追加できます。' : !professionId ? '職種を選ぶと追加できます。' : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (missing) return;
    let newId: string | null = null;
    const r = await run(
      (override) => ({
        command: { type: 'RegisterStaff', payload: { name: name.trim(), locationId, professionId, staffNumber: staffNumber.trim() || undefined } },
        // 追加した本人を入力者として記録する
        meta: { enteredBy: 'self', terminal, reportedBy: null },
        override,
      }),
      {
        doneText: `${name.trim()} さんを入力者に追加しました`,
        overrideLabel: '別の人として追加する',
        onAccepted: ([event]) => {
          newId = event?.subject.id ?? null;
        },
      },
    );
    if (r === 'accepted' && newId) onAdded(newId);
  }

  return (
    <form className="action-form add-staff" aria-label="入力者の追加" onSubmit={onSubmit}>
      <div className="field-row">
        <label className="field">
          <span>
            フルネーム<em className="required">必須</em>
          </span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="例：山田 花子" />
        </label>
        <label className="field">
          <span>職員番号（任意）</span>
          <input value={staffNumber} onChange={(e) => setStaffNumber(e.target.value)} autoComplete="off" />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>
            部署<em className="required">必須</em>
          </span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">選んでください</option>
            {config.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="group">
          <legend>
            職種<em className="required">必須</em>
          </legend>
          <div className="button-row">
            {config.professions.map((p) => (
              <label key={p.id} className={`chip ${professionId === p.id ? 'is-selected' : ''}`}>
                <input type="radio" name="staff-profession" checked={professionId === p.id} onChange={() => setProfessionId(p.id)} />
                {professionId === p.id && '✓ '}
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {missing && <p className="hint">{missing}</p>}
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!!missing}>
          追加して入力を始める
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}
