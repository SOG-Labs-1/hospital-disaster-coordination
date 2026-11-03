import { useState, type FormEvent } from 'react';
import { sexLabels, sexes, type HospitalConfig } from '@hdc/shared';
import { timeInputToIso } from './format';
import { TriageBadge } from './Triage';
import { useCommands } from './useCommands';

const empty = {
  tagNumber: '',
  hospitalPatientId: '',
  medicalId: '',
  name: '',
  sex: 'unknown' as (typeof sexes)[number],
  estimatedAge: '',
  features: '',
  conditionNote: '',
  triage: null as string | null,
  locationId: '',
  observedTime: '',
  reporterLocationId: '',
  reporterName: '',
};

/** 患者の登録。無線・電話で受けた内容を代わりに入力することを前提にする */
export function RegisterForm(props: { config: HospitalConfig; terminal: string; enteredBy: string | null }) {
  const { config, terminal, enteredBy } = props;
  const { run } = useCommands();
  const defaultLocation = config.locations.find((l) => l.id === terminal && l.kind !== 'headquarters')?.id ?? '';
  const [form, setForm] = useState({ ...empty, locationId: defaultLocation });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const canSubmit = !!enteredBy && !!form.locationId && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !enteredBy) return;
    setBusy(true);
    const opt = (v: string) => (v.trim() ? v.trim() : undefined);
    const reportedBy =
      form.reporterLocationId || form.reporterName.trim()
        ? { locationId: opt(form.reporterLocationId), name: opt(form.reporterName) }
        : null;
    const result = await run(
      (override) => ({
        command: {
          type: 'RegisterPatient',
          payload: {
            tagNumber: opt(form.tagNumber),
            hospitalPatientId: opt(form.hospitalPatientId),
            medicalId: opt(form.medicalId),
            name: opt(form.name),
            sex: form.sex,
            estimatedAge: opt(form.estimatedAge),
            features: opt(form.features),
            conditionNote: opt(form.conditionNote),
            triage: form.triage,
            locationId: form.locationId,
          },
        },
        meta: { enteredBy, terminal, reportedBy, observedAt: timeInputToIso(form.observedTime) },
        override,
      }),
      { doneText: '{id} を登録しました' },
    );
    setBusy(false);
    if (result === 'accepted') setForm({ ...empty, locationId: form.locationId, reporterLocationId: form.reporterLocationId });
  }

  return (
    <form className="panel register" onSubmit={onSubmit} aria-labelledby="register-title">
      <h2 id="register-title">患者を登録する</h2>
      <p className="hint">わかる項目だけ入れてください。管理番号は自動で付きます。</p>

      <fieldset className="group">
        <legend>トリアージ区分</legend>
        <div className="triage-choices">
          {[...config.triageCategories.map((t) => t.id), null].map((id) => (
            <label key={id ?? 'none'} className={`triage-choice ${form.triage === id ? 'is-selected' : ''}`}>
              <input type="radio" name="triage" checked={form.triage === id} onChange={() => set('triage', id)} />
              <TriageBadge config={config} triage={id} />
              {form.triage === id && <span className="selected-mark">✓ 選択中</span>}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="field">
        <span>所在（いま患者がいる場所）<em className="required">必須</em></span>
        <select value={form.locationId} onChange={(e) => set('locationId', e.target.value)} required>
          <option value="">選んでください</option>
          {config.locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>

      <div className="field-row">
        <label className="field">
          <span>タッグ番号</span>
          <input value={form.tagNumber} onChange={(e) => set('tagNumber', e.target.value)} inputMode="numeric" autoComplete="off" />
        </label>
        <label className="field">
          <span>院内患者ID</span>
          <input value={form.hospitalPatientId} onChange={(e) => set('hospitalPatientId', e.target.value)} autoComplete="off" />
        </label>
      </div>

      <fieldset className="group">
        <legend>性別</legend>
        <div className="button-row">
          {sexes.map((s) => (
            <label key={s} className={`chip ${form.sex === s ? 'is-selected' : ''}`}>
              <input type="radio" name="sex" checked={form.sex === s} onChange={() => set('sex', s)} />
              {form.sex === s && <span aria-hidden="true">✓ </span>}
              {sexLabels[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field-row">
        <label className="field">
          <span>推定年齢</span>
          <input value={form.estimatedAge} onChange={(e) => set('estimatedAge', e.target.value)} placeholder="例：70代" autoComplete="off" />
        </label>
        <label className="field">
          <span>氏名（わかれば）</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="off" />
        </label>
      </div>

      <label className="field">
        <span>特徴メモ（服装・体格・持ち物など）</span>
        <input value={form.features} onChange={(e) => set('features', e.target.value)} placeholder="例：紺の上着、眼鏡" autoComplete="off" />
      </label>

      <label className="field">
        <span>状態メモ（搬送の判断に必要な最小限）</span>
        <input value={form.conditionNote} onChange={(e) => set('conditionNote', e.target.value)} placeholder="例：車いす、付き添い要" autoComplete="off" />
      </label>

      <details className="more">
        <summary>報告元・確認時刻・メディカルID</summary>
        <div className="field-row">
          <label className="field">
            <span>報告元の場所</span>
            <select value={form.reporterLocationId} onChange={(e) => set('reporterLocationId', e.target.value)}>
              <option value="">（この端末で確認）</option>
              {config.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>報告した人</span>
            <input value={form.reporterName} onChange={(e) => set('reporterName', e.target.value)} autoComplete="off" />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>現場で確認した時刻（空欄＝今）</span>
            <input type="time" value={form.observedTime} onChange={(e) => set('observedTime', e.target.value)} />
          </label>
          <label className="field">
            <span>メディカルID</span>
            <input value={form.medicalId} onChange={(e) => set('medicalId', e.target.value)} placeholder="生年月日8桁＋性別＋カナ7文字" autoComplete="off" />
          </label>
        </div>
      </details>

      {!enteredBy && <p className="inline-alert">⚠ 先に、画面上の一覧から入力者を選んでください。</p>}
      <button type="submit" className="btn btn-primary btn-wide" disabled={!canSubmit}>
        {busy ? '送信中…' : '登録する'}
      </button>
    </form>
  );
}
