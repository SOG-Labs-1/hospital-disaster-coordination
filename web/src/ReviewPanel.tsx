import { useState } from 'react';
import { formatDateTime } from './format';
import { trainingPost, type TrainingSnapshot } from './training';
import { useCommands } from './useCommands';

// 訓練の振り返り。点数や順位は付けない。
// 照合（何が記録されなかったか）はプログラムが行い、AI は根拠の番号を示して説明文を書くだけ。
// 「記録がない（起きたがボードにない）」と「実施されなかった」を分け、参加者が画面外の対応を補足できる。

type Review = NonNullable<TrainingSnapshot['review']>;

const kindLabels = { 'no-record': '記録がない', 'not-done': '実施されていない' } as const;
const resultLabels = {
  met: { symbol: '○', text: '満たした' },
  'no-record': { symbol: '△', text: '起きたが記録がない' },
  'not-met': { symbol: '✕', text: '満たしていない' },
  'self-check': { symbol: '□', text: '自分で確かめる' },
} as const;

export function ReviewPanel({ snapshot, now }: { snapshot: TrainingSnapshot; now: Date }) {
  const review = snapshot.review;
  const { showNotice } = useCommands();
  if (!review) return null;
  const groups = Object.entries(
    review.findings.reduce<Record<string, Review['findings']>>((acc, f) => ({ ...acc, [f.categoryLabel]: [...(acc[f.categoryLabel] ?? []), f] }), {}),
  );
  const explainer = review.explainedBy === 'anthropic' ? 'Claude（AI）' : review.explainedBy === 'mock' ? '決まった文（mock）' : null;

  async function reExplain() {
    const r = await trainingPost('explain', {});
    showNotice(r.ok ? { kind: 'done', text: '説明文を作り直しています' } : { kind: 'error', text: r.error });
  }

  return (
    <section className="panel review" aria-labelledby="review-title" data-testid="review">
      <div className="panel-head">
        <h2 id="review-title">振り返り：{snapshot.run?.title}</h2>
        <button type="button" className="btn no-print" onClick={() => window.print()}>
          印刷する
        </button>
      </div>
      <p className="hint">
        点数は付けません。ボードの記録と、訓練の中で実際に起きたこと・確認項目を照合した結果です。照合はプログラムが行い、説明文は{explainer ?? '（作成中）'}が根拠の番号を示して書いています。
      </p>
      <p className="print-only">出力 {formatDateTime(now)}　【訓練】</p>

      <h3>確認項目</h3>
      <table className="chrono-table" data-testid="review-checks">
        <tbody>
          {review.checks.map((c) => (
            <tr key={c.id} data-testid={`check-${c.id}`}>
              <td className={`check-result result-${c.result}`}>
                <span aria-hidden="true">{resultLabels[c.result].symbol}</span> {resultLabels[c.result].text}
              </td>
              <td>
                {c.text}
                {c.source === 'hospital' && <span className="chrono-note">病院の確認項目</span>}
              </td>
              <td>{c.evidence.join('、')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>記録から見えたこと {review.findings.length}件</h3>
      {review.findings.length === 0 && <p className="empty">照合で見つかった抜けはありません。</p>}
      {groups.map(([label, items]) => (
        <div key={label} className="finding-group">
          <h4>
            {label}（{items.length}件）
          </h4>
          <ul className="finding-list">
            {items.map((f) => (
              <Finding key={f.id} finding={f} />
            ))}
          </ul>
        </div>
      ))}
      <button type="button" className="btn no-print" onClick={reExplain}>
        補足を反映して説明文を作り直す
      </button>
    </section>
  );
}

function Finding({ finding: f }: { finding: Review['findings'][number] }) {
  const { showNotice } = useCommands();
  const [note, setNote] = useState(f.note ?? '');
  const [editing, setEditing] = useState(false);

  async function save() {
    const r = await trainingPost('note', { findingId: f.id, note });
    if (r.ok) setEditing(false);
    else showNotice({ kind: 'error', text: r.error });
  }

  return (
    <li className={`finding finding-${f.kind}`} data-testid={`finding-${f.id}`}>
      <div className="finding-head">
        <span className={`finding-kind kind-${f.kind}`}>{kindLabels[f.kind]}</span>
        <strong>{f.title}</strong>
      </div>
      <p className="finding-detail">{f.detail}</p>
      {f.explanation && <p className="finding-explanation">{f.explanation.text}</p>}
      {f.evidence.length > 0 && <p className="finding-evidence">根拠：{f.evidence.join('、')}（クロノロジー・無線の受信で確かめられます）</p>}
      {f.note && !editing && <p className="finding-note">参加者の補足：{f.note}</p>}
      {editing ? (
        <div className="action-form no-print">
          <label className="field">
            <span>補足（画面の外で対応したこと・判断の理由）</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
          </label>
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={save}>
              補足を残す
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(false)}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-quiet no-print" onClick={() => setEditing(true)}>
          {f.note ? '補足を直す' : '補足を書く'}
        </button>
      )}
    </li>
  );
}
