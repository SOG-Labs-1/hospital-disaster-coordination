import { useEffect, useRef, useState } from 'react';
import { activePatients, sexLabels, versionOf, type AppState, type HospitalConfig, type PatientView } from '@hdc/shared';
import { formatTime, minutesSince } from './format';
import { TriageBadge } from './Triage';
import { useCommands } from './useCommands';

interface Props {
  config: HospitalConfig;
  state: AppState;
  terminal: string;
  enteredBy: string | null;
  now: Date;
}

export function PatientList({ config, state, terminal, enteredBy, now }: Props) {
  const patients = activePatients(state);
  const [filter, setFilter] = useState<string>('all');
  const shown = filter === 'all' ? patients : patients.filter((p) => (p.triage ?? 'none') === filter);
  const count = (id: string | null) => patients.filter((p) => p.triage === id).length;

  return (
    <section className="panel patients" aria-labelledby="patients-title">
      <div className="panel-head">
        <h2 id="patients-title">
          患者一覧 <span className="count" data-testid="patient-count">{patients.length}人</span>
        </h2>
        <button type="button" className="btn no-print" onClick={() => window.print()}>
          印刷する
        </button>
      </div>

      <div className="filter-row no-print" role="group" aria-label="区分で絞り込む">
        <button type="button" className={`chip ${filter === 'all' ? 'is-selected' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          {filter === 'all' && '✓ '}すべて {patients.length}
        </button>
        {config.triageCategories.map((t) => (
          <button key={t.id} type="button" className={`chip ${filter === t.id ? 'is-selected' : ''}`} aria-pressed={filter === t.id} onClick={() => setFilter(t.id)}>
            {filter === t.id && '✓ '}
            {t.symbol} {t.label} {count(t.id)}
          </button>
        ))}
        <button type="button" className={`chip ${filter === 'none' ? 'is-selected' : ''}`} aria-pressed={filter === 'none'} onClick={() => setFilter('none')}>
          {filter === 'none' && '✓ '}？ 未判定 {count(null)}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="empty">{patients.length === 0 ? 'まだ患者は登録されていません。左の「患者を登録する」から登録します。' : 'この区分の患者はいません。'}</p>
      ) : (
        <ol className="patient-list" data-testid="patient-list">
          {[...shown].reverse().map((p) => (
            <PatientRow key={p.id} patient={p} config={config} state={state} terminal={terminal} enteredBy={enteredBy} now={now} />
          ))}
        </ol>
      )}
    </section>
  );
}

function PatientRow({ patient: p, config, state, terminal, enteredBy, now }: { patient: PatientView } & Props) {
  const { run, highlight, setHighlight } = useCommands();
  const [editing, setEditing] = useState<'none' | 'triage' | 'note'>('none');
  const ref = useRef<HTMLLIElement>(null);
  const location = config.locations.find((l) => l.id === p.locationId)?.name ?? p.locationId;
  const staffName = (id: string) => config.staff.find((s) => s.id === id)?.name ?? id;
  const age = minutesSince(p.lastObservedAt, now);
  const stale = age >= config.staleAfterMinutes;
  const isHighlighted = highlight === p.id;

  useEffect(() => {
    if (isHighlighted) {
      ref.current?.scrollIntoView({ block: 'center' });
      const t = setTimeout(() => setHighlight(null), 6000);
      return () => clearTimeout(t);
    }
  }, [isHighlighted, setHighlight]);

  const expectedVersion = versionOf(state, { kind: 'patient', id: p.id });
  const meta = { enteredBy: enteredBy ?? '', terminal, reportedBy: null };

  async function changeTriage(triage: string | null) {
    const r = await run(() => ({
      command: { type: 'ChangePatientTriage', patientId: p.id, payload: { triage } },
      meta,
      expectedVersion,
    }));
    if (r === 'accepted') setEditing('none');
  }

  return (
    <li ref={ref} className={`patient ${isHighlighted ? 'is-highlighted' : ''}`} data-testid={`patient-${p.id}`} data-print-border={config.triageCategories.find((t) => t.id === p.triage)?.printBorder ?? 'dotted'}>
      <div className="patient-id">
        <span className="patient-number">{p.id}</span>
        <span className="patient-tag">タッグ {p.tagNumber ? <strong>{p.tagNumber}</strong> : <span className="unknown">未記入</span>}</span>
        {isHighlighted && <span className="highlight-mark">◀ 開いた患者</span>}
      </div>
      <div className="patient-triage">
        <TriageBadge config={config} triage={p.triage} size="large" />
      </div>
      <dl className="patient-facts">
        <div>
          <dt>所在</dt>
          <dd>{location}</dd>
        </div>
        <div>
          <dt>特徴</dt>
          <dd>
            {[sexLabels[p.sex], p.estimatedAge, p.features].filter((v) => v && v !== sexLabels.unknown).join('、') || <span className="unknown">未記入</span>}
          </dd>
        </div>
        {p.conditionNote && (
          <div>
            <dt>状態</dt>
            <dd>{p.conditionNote}</dd>
          </div>
        )}
        {(p.hospitalPatientId || p.name) && (
          <div>
            <dt>識別</dt>
            <dd>{[p.hospitalPatientId && `院内ID ${p.hospitalPatientId}`, p.name].filter(Boolean).join('、')}</dd>
          </div>
        )}
        <div>
          <dt>確認</dt>
          <dd className={stale ? 'stale' : ''}>
            {formatTime(p.lastObservedAt)}
            {stale && <span className="stale-mark"> ⏱ {age}分前（古い）</span>}
          </dd>
        </div>
        {p.overrides.length > 0 && (
          <div>
            <dt>警告</dt>
            <dd className="override-note">⚠ 重複を承知で登録：{p.overrides.map((o) => o.reason).join('／')}</dd>
          </div>
        )}
      </dl>

      <div className="patient-actions no-print">
        <button type="button" className="btn" disabled={!enteredBy} aria-expanded={editing === 'triage'} onClick={() => setEditing(editing === 'triage' ? 'none' : 'triage')}>
          区分を変える
        </button>
        <button type="button" className="btn" disabled={!enteredBy} aria-expanded={editing === 'note'} onClick={() => setEditing(editing === 'note' ? 'none' : 'note')}>
          メモを直す
        </button>
      </div>

      {editing === 'triage' && (
        <div className="patient-edit no-print" role="group" aria-label={`${p.id} の区分を変える`}>
          {[...config.triageCategories.map((t) => t.id), null].map((id) => (
            <button key={id ?? 'none'} type="button" className="triage-button" disabled={id === p.triage} onClick={() => changeTriage(id)}>
              <TriageBadge config={config} triage={id} />
              {id === p.triage && <span className="btn-sub">（現在）</span>}
            </button>
          ))}
        </div>
      )}
      {editing === 'note' && <NoteEditor patient={p} onDone={() => setEditing('none')} meta={meta} expectedVersion={expectedVersion} />}

      <details className="history">
        <summary>区分の履歴（{p.triageHistory.length}件）</summary>
        <ol>
          {p.triageHistory.map((h) => (
            <li key={h.eventId} className={`history-${h.status}`}>
              {formatTime(h.observedAt)} <TriageBadge config={config} triage={h.triage} />
              {h.status === 'corrected' && <span>（訂正：{h.correctionReason}）</span>}
              {h.status === 'retracted' && <span>（取り消し：{h.correctionReason}）</span>}
              <span className="history-who">入力 {staffName(h.enteredBy)}</span>
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function NoteEditor({ patient, onDone, meta, expectedVersion }: { patient: PatientView; onDone: () => void; meta: { enteredBy: string; terminal: string; reportedBy: null }; expectedVersion: number }) {
  const { run } = useCommands();
  const [features, setFeatures] = useState(patient.features ?? '');
  const [conditionNote, setConditionNote] = useState(patient.conditionNote ?? '');

  async function save() {
    let version = expectedVersion;
    const changes = [
      ['features', features, patient.features ?? ''],
      ['conditionNote', conditionNote, patient.conditionNote ?? ''],
    ] as const;
    for (const [field, value, before] of changes) {
      if (value === before) continue;
      const r = await run(() => ({
        command: { type: 'UpdatePatientNote', patientId: patient.id, payload: { field, value } },
        meta,
        expectedVersion: version,
      }));
      if (r !== 'accepted') return;
      version += 1;
    }
    onDone();
  }

  return (
    <div className="patient-edit no-print">
      <label className="field">
        <span>特徴メモ</span>
        <input value={features} onChange={(e) => setFeatures(e.target.value)} />
      </label>
      <label className="field">
        <span>状態メモ</span>
        <input value={conditionNote} onChange={(e) => setConditionNote(e.target.value)} />
      </label>
      <div className="button-row">
        <button type="button" className="btn btn-primary" onClick={save}>
          メモを保存する
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          やめる
        </button>
      </div>
    </div>
  );
}
