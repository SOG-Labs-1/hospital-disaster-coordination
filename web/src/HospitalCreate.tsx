import { useEffect, useState, type ReactNode } from 'react';
import { locationKindLabels, locationKinds, type HospitalDraftInput, type HospitalTemplate } from '@hdc/shared';
import { setHospitalInUrl } from './session';
import { TriageBadge } from './Triage';

// 病院を作る画面。段階ごとに入力し、最後に確認してから作る。
// 画面で入力しない値（トリアージ区分の表示・職種・警告の理由など）は、標準の値（テンプレート）から始める。

/** 入力中の下書き（送るときに HospitalDraftInput の形にする） */
type Draft = {
  name: string;
  fictional: boolean;
  staleAfterMinutes?: number;
  locations: { name: string; kind: (typeof locationKinds)[number]; hasTerminal: boolean; capacity: Record<string, number> }[];
  zoneAssignments: { zoneId: string; locationIndex: number }[];
  positions: { hqChief: boolean; hqTransport: boolean; locationLeads: boolean };
  staff: { name: string; locationIndex: number; professionId: string; staffNumber?: string }[];
  transporters: string[];
};

const steps = ['基本', '場所', '災害時の用途', '役職', '入力者', '確認'] as const;

export function HospitalCreate() {
  const [template, setTemplate] = useState<HospitalTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    name: '',
    fictional: false,
    staleAfterMinutes: undefined,
    locations: [{ name: '災害対策本部', kind: 'headquarters', hasTerminal: true, capacity: {} }],
    zoneAssignments: [],
    positions: { hqChief: true, hqTransport: false, locationLeads: true },
    staff: [],
    transporters: [],
  });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  useEffect(() => {
    fetch('/api/hospital-template').then(
      async (r) => (r.ok ? setTemplate(await r.json()) : setError('この環境では病院を作れません')),
      () => setError('サーバーに届かなかった'),
    );
  }, []);

  if (error) return <main className="setup"><p className="inline-alert">⚠ {error}</p></main>;
  if (!template) return <main className="setup"><p>読み込み中…</p></main>;

  // 役職の名前と説明は標準の値（positionTemplates）から取る
  const pt = template.positionTemplates;
  // 段階ごとに、先へ進めない理由
  const problems: string[][] = [
    [!draft.name.trim() && '病院名を書いてください', !draft.fictional && '「架空の病院です」を確かめてください'].filter(Boolean) as string[],
    [
      draft.locations.some((l) => !l.name.trim()) && '名前のない場所があります',
      !draft.locations.some((l) => l.kind === 'headquarters') && '本部の場所を1つ入れてください',
      new Set(draft.locations.map((l) => l.name.trim())).size !== draft.locations.length && '場所の名前が重なっています',
    ].filter(Boolean) as string[],
    [],
    [!draft.positions.hqChief && !draft.positions.hqTransport && `${pt.hqChief.name}か${pt.hqTransport.name}のどちらかを入れてください（搬送の指示を出す役職）`].filter(Boolean) as string[],
    [
      draft.staff.length === 0 && '入力者を1人以上入れてください',
      draft.staff.some((s) => s.name.trim().length < 2) && 'フルネームのない入力者がいます',
      draft.staff.some((s) => !s.professionId) && '職種を選んでいない入力者がいます',
    ].filter(Boolean) as string[],
    [],
  ];
  const canNext = problems[step]!.length === 0;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/hospitals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: { ...draft, transporters: draft.transporters.filter((t) => t.trim()) } satisfies Omit<HospitalDraftInput, 'fictional'> & { fictional: boolean } }),
      });
      const body = await res.json();
      if (res.ok) setHospitalInUrl(body.hospital.id, 'live');
      else setError((body.errors ?? ['作れませんでした']).join(' ／ '));
    } catch {
      setError('サーバーに届かなかった');
    }
    setBusy(false);
  }

  const nonHq = draft.locations.map((l, i) => ({ ...l, index: i })).filter((l) => l.kind !== 'headquarters');

  return (
    <main className="setup hospital-create" aria-labelledby="create-title">
      <h1 id="create-title">病院を作る</h1>
      <ol className="create-steps" aria-label="入力の段階">
        {steps.map((s, i) => (
          <li key={s} className={i === step ? 'is-current' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>
            {i < step ? '✓ ' : ''}
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      <section className="panel">
        {step === 0 && (
          <>
            <h2>基本</h2>
            <label className="field">
              <span>
                病院名<em className="required">必須</em>
              </span>
              <input value={draft.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" placeholder="例：みなと中央病院(仮)" />
            </label>
            <label className="field">
              <span>確認が古いと見なすまでの時間（分。空欄＝標準の{template.staleAfterMinutes}分）</span>
              <input
                inputMode="numeric"
                value={draft.staleAfterMinutes ?? ''}
                onChange={(e) => {
                  const v = e.target.value.normalize('NFKC').replace(/[^0-9]/g, '');
                  set({ staleAfterMinutes: v ? Number(v) : undefined });
                }}
              />
            </label>
            <label className="radio fictional-check">
              <input type="checkbox" checked={draft.fictional} onChange={(e) => set({ fictional: e.target.checked })} />
              架空の病院です（このハッカソン版では、実在の病院・職員の情報を入れません）
            </label>
          </>
        )}

        {step === 1 && (
          <>
            <h2>場所</h2>
            <p className="hint">本部・救急外来・病棟など、患者や職員がいる場所を入れます。区分ごとの受け入れ枠は、分からなければ空欄で構いません（あとで報告で入れられます）。</p>
            <ol className="create-list">
              {draft.locations.map((l, i) => (
                <li key={i} className="create-row" data-testid={`create-location-${i}`}>
                  <div className="field-row">
                    <label className="field">
                      <span>場所の名前</span>
                      <input
                        value={l.name}
                        onChange={(e) => set({ locations: draft.locations.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                        autoComplete="off"
                      />
                    </label>
                    <label className="field">
                      <span>種類</span>
                      <select value={l.kind} onChange={(e) => set({ locations: draft.locations.map((x, j) => (j === i ? { ...x, kind: e.target.value as typeof l.kind } : x)) })}>
                        {locationKinds.map((k) => (
                          <option key={k} value={k}>
                            {locationKindLabels[k]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="radio">
                    <input type="checkbox" checked={l.hasTerminal} onChange={(e) => set({ locations: draft.locations.map((x, j) => (j === i ? { ...x, hasTerminal: e.target.checked } : x)) })} />
                    この場所に端末（パソコン）を置く
                  </label>
                  {l.kind !== 'headquarters' && (
                    <fieldset className="group">
                      <legend>区分ごとの受け入れ枠（人。空欄＝なし）</legend>
                      <div className="escort-grid">
                        {template.triageCategories.map((t) => (
                          <label key={t.id} className="escort">
                            <TriageBadge config={{ triageCategories: template.triageCategories } as never} triage={t.id} />
                            <input
                              inputMode="numeric"
                              aria-label={`${l.name || '場所'}の${t.label}の受け入れ枠`}
                              value={l.capacity[t.id] ?? ''}
                              onChange={(e) => {
                                const v = e.target.value.normalize('NFKC').replace(/[^0-9]/g, '');
                                const capacity = { ...l.capacity };
                                if (v) capacity[t.id] = Number(v);
                                else delete capacity[t.id];
                                set({ locations: draft.locations.map((x, j) => (j === i ? { ...x, capacity } : x)) });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={draft.locations.length === 1}
                    onClick={() =>
                      set({
                        locations: draft.locations.filter((_, j) => j !== i),
                        // 消した場所を指していた割り当て・入力者は外し、後ろの番号を詰める
                        zoneAssignments: draft.zoneAssignments.filter((z) => z.locationIndex !== i).map((z) => ({ ...z, locationIndex: z.locationIndex > i ? z.locationIndex - 1 : z.locationIndex })),
                        staff: draft.staff.filter((s) => s.locationIndex !== i).map((s) => ({ ...s, locationIndex: s.locationIndex > i ? s.locationIndex - 1 : s.locationIndex })),
                      })
                    }
                  >
                    この場所を消す
                  </button>
                </li>
              ))}
            </ol>
            <button type="button" className="btn" onClick={() => set({ locations: [...draft.locations, { name: '', kind: 'ward', hasTerminal: true, capacity: {} }] })}>
              ＋ 場所を足す
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <h2>災害時の用途（ゾーン）</h2>
            <p className="hint">それぞれのゾーンを、どの場所に置くかを選びます。1つの場所に複数のゾーンを置けます。あとから画面（院内の状況）で変えることもできます。</p>
            {template.zones.map((z) => (
              <fieldset key={z.id} className="group zone-pick">
                <legend>{z.name}</legend>
                <div className="button-row">
                  {nonHq.length === 0 && <span className="hint">本部以外の場所がありません。</span>}
                  {nonHq.map((l) => {
                    const on = draft.zoneAssignments.some((a) => a.zoneId === z.id && a.locationIndex === l.index);
                    return (
                      <button
                        key={l.index}
                        type="button"
                        className={`chip ${on ? 'is-selected' : ''}`}
                        aria-pressed={on}
                        onClick={() =>
                          set({
                            zoneAssignments: on
                              ? draft.zoneAssignments.filter((a) => !(a.zoneId === z.id && a.locationIndex === l.index))
                              : [...draft.zoneAssignments, { zoneId: z.id, locationIndex: l.index }],
                          })
                        }
                      >
                        {on && '✓ '}
                        {l.name || `場所${l.index + 1}`}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </>
        )}

        {step === 3 && (
          <>
            <h2>役職</h2>
            <p className="hint">搬送の指示や受け入れの判断をする役職です。名前は作ったあとに病院設定のファイルで変えられます。</p>
            {(
              [
                ['hqChief', pt.hqChief.name, pt.hqChief.description],
                ['hqTransport', `${pt.hqTransport.name}（本部）`, pt.hqTransport.description],
                ['locationLeads', pt.locationLead.name, pt.locationLead.description],
              ] as const
            ).map(([k, label, desc]) => (
              <label key={k} className="radio">
                <input type="checkbox" checked={draft.positions[k]} onChange={(e) => set({ positions: { ...draft.positions, [k]: e.target.checked } })} />
                <span>
                  <strong>{label}</strong>　{desc}
                </span>
              </label>
            ))}
          </>
        )}

        {step === 4 && (
          <>
            <h2>入力者</h2>
            <p className="hint">名前の一覧から選んで入力する人です。1人以上入れてください。あとから画面で追加することもできます。</p>
            <ol className="create-list">
              {draft.staff.map((s, i) => (
                <li key={i} className="create-row" data-testid={`create-staff-${i}`}>
                  <div className="field-row">
                    <label className="field">
                      <span>フルネーム</span>
                      <input value={s.name} onChange={(e) => set({ staff: draft.staff.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} autoComplete="off" />
                    </label>
                    <label className="field">
                      <span>職員番号（任意）</span>
                      <input value={s.staffNumber ?? ''} onChange={(e) => set({ staff: draft.staff.map((x, j) => (j === i ? { ...x, staffNumber: e.target.value || undefined } : x)) })} autoComplete="off" />
                    </label>
                  </div>
                  <div className="field-row">
                    <label className="field">
                      <span>部署</span>
                      <select value={s.locationIndex} onChange={(e) => set({ staff: draft.staff.map((x, j) => (j === i ? { ...x, locationIndex: Number(e.target.value) } : x)) })}>
                        {draft.locations.map((l, li) => (
                          <option key={li} value={li}>
                            {l.name || `場所${li + 1}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>職種</span>
                      <select value={s.professionId} onChange={(e) => set({ staff: draft.staff.map((x, j) => (j === i ? { ...x, professionId: e.target.value } : x)) })}>
                        <option value="">選んでください</option>
                        {template.professions.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button type="button" className="btn btn-quiet" onClick={() => set({ staff: draft.staff.filter((_, j) => j !== i) })}>
                    この人を消す
                  </button>
                </li>
              ))}
            </ol>
            <button type="button" className="btn" onClick={() => set({ staff: [...draft.staff, { name: '', locationIndex: 0, professionId: '' }] })}>
              ＋ 入力者を足す
            </button>
            <label className="field">
              <span>搬送要員の呼び名（任意。1行に1人。例：搬送1）</span>
              <textarea rows={3} value={draft.transporters.join('\n')} onChange={(e) => set({ transporters: e.target.value.split('\n') })} />
            </label>
          </>
        )}

        {step === 5 && (
          <>
            <h2>確認</h2>
            <dl className="create-summary">
              <Row label="病院名">{draft.name}</Row>
              <Row label="場所">
                {draft.locations.map((l, i) => (
                  <div key={i}>
                    {l.name}（{locationKindLabels[l.kind]}
                    {l.hasTerminal ? '・端末あり' : '・端末なし'}
                    {Object.entries(l.capacity).length > 0 &&
                      `・受け入れ枠 ${Object.entries(l.capacity)
                        .map(([t, v]) => `${template.triageCategories.find((x) => x.id === t)?.label}${v}人`)
                        .join('、')}`}
                    ）
                  </div>
                ))}
              </Row>
              <Row label="用途">
                {template.zones.map((z) => (
                  <div key={z.id}>
                    {z.name}：
                    {draft.zoneAssignments
                      .filter((a) => a.zoneId === z.id)
                      .map((a) => draft.locations[a.locationIndex]?.name)
                      .join('、') || 'なし'}
                  </div>
                ))}
              </Row>
              <Row label="役職">
                {[draft.positions.hqChief && pt.hqChief.name, draft.positions.hqTransport && pt.hqTransport.name, draft.positions.locationLeads && pt.locationLead.name].filter(Boolean).join('、')}
              </Row>
              <Row label="入力者">{draft.staff.map((s) => `${s.name}（${draft.locations[s.locationIndex]?.name}・${template.professions.find((p) => p.id === s.professionId)?.name}）`).join('、')}</Row>
              <Row label="搬送要員">{draft.transporters.filter((t) => t.trim()).join('、') || 'なし'}</Row>
              <Row label="そのほか">トリアージ区分の表示・職種・警告の理由・支援要請の種類・搬送の方針は、標準の値で作ります。</Row>
            </dl>
            <p className="hint">作った病院設定は、この端末のサーバーの data/hospitals/ に保存されます（git の管理外）。作成後は場所の用途の変更と入力者の追加を画面で行えます。</p>
          </>
        )}
      </section>

      {problems[step]!.length > 0 && (
        <ul className="inline-alert create-problems">
          {problems[step]!.map((p) => (
            <li key={p}>⚠ {p}</li>
          ))}
        </ul>
      )}
      {error && <p className="inline-alert">⚠ {error}</p>}
      {/* 「戻る」「次へ」はどの段階でも同じ位置に置く */}
      <div className="button-row create-nav">
        <button type="button" className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>
          ← 戻る
        </button>
        {step < steps.length - 1 ? (
          <button type="button" className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            次へ →
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={create}>
            {busy ? '作っています…' : 'この内容で病院を作る'}
          </button>
        )}
        <button type="button" className="btn btn-quiet" onClick={() => setHospitalInUrl('')}>
          やめる（病院を選ぶ画面に戻る）
        </button>
      </div>
    </main>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
