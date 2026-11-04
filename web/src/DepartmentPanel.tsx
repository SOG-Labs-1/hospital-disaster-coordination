import { useEffect, useRef, useState, type ReactNode } from 'react';
import { openSupports, pendingForLocation, type AppState, type HospitalConfig, type SupportView, type TransportView } from '@hdc/shared';
import { minutesSince } from './format';
import { locationLabel, locationName, patientShort } from './labels';
import { LocationCard, makeIsStale } from './LocationBoard';
import { PatientList } from './PatientList';
import { itemText, SupportCard } from './SupportPanel';
import { TransportCard } from './TransportPanel';

interface Props {
  config: HospitalConfig;
  state: AppState;
  terminal: string;
  enteredBy: string | null;
  now: Date;
}

type Row = {
  key: string;
  label: string;
  /** 判断が必要な行（受け入れの判断）。ほかの記録より先に片付ける */
  decision: boolean;
  text: string;
  /** 経過分の説明と分数 */
  elapsed: { text: string; minutes: number };
} & ({ transport: TransportView; focus: 'accept' | 'depart' | 'arrive' | 'handover' } | { support: SupportView; focus?: 'receive' });

/** 一覧に最初から出す件数。超えた分は「ほか N件を表示」で開く */
const PINNED_VISIBLE = 4;

/**
 * 各部署の画面の上部に固定表示する「この部署への依頼・この部署が記録すること」。
 * どのタブを開いていても表示し、行ごとの「対応する」で、その行でするべき操作をその場で開く
 */
export function PinnedRequests(props: Props & { onChangeEnteredBy: (staffId: string) => void; loaded: boolean }) {
  const { config, state, terminal, enteredBy, now, onChangeEnteredBy, loaded } = props;
  const [openKey, setOpenKey] = useState<string | null>(null);
  // 並び順を固定する：最初に開いたときの順番を覚え、あとから来た依頼は末尾に足して「新着」と示す。
  // 新しい依頼が来るたびに並び替わると、「対応する」を押す瞬間に指の下の行が入れ替わるため（配置を変えない）
  const order = useRef<string[] | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const p = pendingForLocation(state, terminal);
  const patient = (t: TransportView) => patientShort(config, state.patients[t.patientId], t.patientId);
  const since = (label: string, iso: string) => ({ text: `${label}から${minutesSince(iso, now)}分`, minutes: minutesSince(iso, now) });
  const items = (s: SupportView) => (s.steps.dispatched?.items ?? s.items).map((it) => itemText(config, it)).join('、');

  const unordered: Row[] = [
    ...p.acceptRequests.map((t): Row => ({
      key: `accept-${t.id}`,
      label: '⚠ 受け入れの判断',
      decision: true,
      text: `${t.id} ${patient(t)}　${locationName(config, t.fromLocationId)}から`,
      elapsed: since('要請', t.steps.requested.observedAt),
      transport: t,
      focus: 'accept',
    })),
    ...p.arrivals.map((t): Row => ({
      key: `arrive-${t.id}`,
      label: '到着の記録',
      decision: false,
      text: `${t.id} ${patient(t)}　${locationName(config, t.fromLocationId)}から移動中`,
      elapsed: since('出発', t.steps.departed!.observedAt),
      transport: t,
      focus: 'arrive',
    })),
    ...p.handovers.map((t): Row => ({
      key: `handover-${t.id}`,
      label: '引き渡しの記録',
      decision: false,
      text: `${t.id} ${patient(t)}　${locationName(config, t.fromLocationId)}から到着済み`,
      elapsed: since('到着', t.steps.arrived!.observedAt),
      transport: t,
      focus: 'handover',
    })),
    ...p.departures.map((t): Row => ({
      key: `depart-${t.id}`,
      label: '出発の記録',
      decision: false,
      text: `${t.id} ${patient(t)}　${locationName(config, t.toLocationId)}へ（${t.steps.accepted ? '了承済み' : '了承は未記録'}）`,
      elapsed: since('要請', t.steps.requested.observedAt),
      transport: t,
      focus: 'depart',
    })),
    ...p.supportsToReceive.map((s): Row => {
      const d = s.steps.dispatched;
      return d
        ? {
            key: `receive-${s.id}`,
            label: '届くはずの支援',
            decision: false,
            text: `${s.id} ${items(s)}（${d.providerLocationId ? locationName(config, d.providerLocationId) : d.providerName}から）`,
            elapsed: since('手配', d.observedAt),
            support: s,
            focus: 'receive',
          }
        : {
            // 手配前の要請は「向かっている」と読めないように見出しを分ける
            key: `waiting-${s.id}`,
            label: '出した要請（手配待ち）',
            decision: false,
            text: `${s.id} ${items(s)}`,
            elapsed: since('要請', s.steps.requested.observedAt),
            support: s,
          };
    }),
    ...p.supportsToProvide.map((s): Row => ({
      key: `provide-${s.id}`,
      label: '送るはずの支援',
      decision: false,
      text: `${s.id} ${locationName(config, s.steps.dispatched!.toLocationId)}へ ${items(s)}`,
      elapsed: since('手配', s.steps.dispatched!.observedAt),
      support: s,
    })),
  ];
  const priority = (a: Row, b: Row) => Number(b.decision) - Number(a.decision) || b.elapsed.minutes - a.elapsed.minutes;
  // 並びと新着の印は、搬送・要請の番号（slot）で覚える。同じ搬送が「到着」→「引き渡し」と次の段階に進んでも、同じ位置のまま開いておける
  // 支援は「届くはず」と「送るはず」が同じ要請で2行になりうるので、行ごとの key を使う
  const slot = (r: Row) => ('transport' in r ? r.transport.id : r.key);
  // 記録を読み込み終えた時点の依頼は「新着」にせず、優先の順に並べる。読み込み前（記録の取得中）は並びを決めない
  if (order.current === null && loaded) order.current = [...unordered].sort(priority).map(slot);
  // 一覧から消えた行は並びと開閉から外す。同じ搬送が別の段階の依頼として戻ってきたら、新着として末尾に足す
  // （例：了承して消えた行が、出発のあと「到着の記録」として戻る）。到着→引き渡しのように同じ描画で入れ替わるときは位置を引き継ぐ
  const present = new Set(unordered.map(slot));
  if (order.current) order.current = order.current.filter((k) => present.has(k));
  const known = new Set(order.current ?? []);
  const arrived = order.current ? unordered.filter((r) => !known.has(slot(r))).map(slot) : [];
  if (order.current && arrived.length) {
    order.current = [...order.current, ...arrived];
    // 描画の途中で状態を変えないよう、新着の印は次の描画で付ける
    queueMicrotask(() => setFresh((f) => new Set([...f, ...arrived])));
  }
  const position = new Map((order.current ?? []).map((k, i) => [k, i]));
  const rows = [...unordered].sort((a, b) => (position.get(slot(a)) ?? 0) - (position.get(slot(b)) ?? 0));
  const resort = () => {
    order.current = [...unordered].sort(priority).map(slot);
    setFresh(new Set());
  };
  const openGone = openKey !== null && !present.has(openKey);
  useEffect(() => {
    if (openGone) setOpenKey(null);
  }, [openGone]);
  const open = (r: Row | null) => {
    setOpenKey(r ? slot(r) : null);
    if (r && fresh.has(slot(r))) setFresh((f) => new Set([...f].filter((k) => k !== slot(r))));
  };
  // 件数の上限で隠すのは、判断が要らず新着でもない行だけ。判断の依頼と新着は、並びを変えずに常に出す（見落とさないように）
  const important = (r: Row) => r.decision || fresh.has(slot(r));
  const shown = (r: Row, i: number) => i < PINNED_VISIBLE || important(r);
  const hidden = rows.filter((r, i) => !shown(r, i));

  const visible = showAll ? rows : rows.filter(shown);
  const localStaff = config.staff.filter((s) => s.locationId === terminal);

  return (
    <section className={`pinned ${rows.length ? 'has-items' : ''}`} aria-labelledby="pinned-title" data-testid="pinned-requests">
      <h2 id="pinned-title">
        {locationName(config, terminal)}への依頼・記録すること <span className="count">{rows.length}件</span>
      </h2>
      {rows.length === 0 ? (
        <p className="hint">いま、この部署が対応する依頼はありません。</p>
      ) : (
        <ul className="pinned-list">
          {visible.map((r) => (
            <li key={slot(r)} className={`pinned-row ${r.decision ? 'is-decision' : ''}`} data-testid={`pinned-${r.key}`}>
              <div className="pinned-line">
                {fresh.has(slot(r)) && <span className="pinned-new">★ 新着</span>}
                <span className="pinned-label">{r.label}</span>
                <span className="pinned-text">{r.text}</span>
                <span className="pinned-elapsed">{r.elapsed.text}</span>
                <button type="button" className="btn" aria-expanded={openKey === slot(r)} onClick={() => open(openKey === slot(r) ? null : r)}>
                  {openKey === slot(r) ? '閉じる' : '対応する'}
                </button>
              </div>
              {openKey === slot(r) && (
                <>
                  {!enteredBy && localStaff.length > 0 && (
                    // 入力者を選ばないと記録できないので、その場で名前を選べるようにする
                    <div className="pinned-who" role="group" aria-label="入力する人の名前">
                      <span>記録する人の名前を押してください：</span>
                      {localStaff.map((s) => (
                        <button key={s.id} type="button" className="btn" onClick={() => onChangeEnteredBy(s.id)}>
                          {s.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <ol className="transport-list pinned-card">
                    {'transport' in r ? <TransportCard transport={r.transport} focus={r.focus} {...props} /> : <SupportCard support={r.support} focus={r.focus} {...props} />}
                  </ol>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {(hidden.length > 0 || showAll) && rows.length > PINNED_VISIBLE && (
        <button type="button" className="btn btn-quiet" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll
            ? '表示を減らす（判断が必要なものと新着は出したまま）'
            : `ほか ${hidden.length}件を表示`}
        </button>
      )}
      {rows.length > 1 && (
        <button type="button" className="btn btn-quiet" onClick={resort}>
          判断が必要なもの・古いものを上に並べ直す
        </button>
      )}
    </section>
  );
}

/** 「この部署」タブ：自部署の受け入れ状況・人員、いる患者、出した支援要請 */
export function DepartmentTab(props: Props & { onRequestTransport: (patientId: string) => void }) {
  const { config, state, terminal, now, onRequestTransport } = props;
  const mySupports = openSupports(state).filter((s) => s.fromLocationId === terminal);
  return (
    <div className="layout department">
      <div className="stack">
        <LocationCard locationId={terminal} {...props} isStale={makeIsStale(config, now)} />
        <Section title={`${locationName(config, terminal)}が出した支援要請`} count={mySupports.length}>
          {mySupports.length === 0 ? (
            <p className="hint">対応中の要請はありません。「支援要請」タブから要請できます。</p>
          ) : (
            <ol className="transport-list">
              {mySupports.map((s) => (
                <SupportCard key={s.id} support={s} {...props} />
              ))}
            </ol>
          )}
        </Section>
      </div>
      <PatientList
        {...props}
        title={`${locationLabel(config, terminal, now)}の患者`}
        only={(p) => p.locationId === terminal || p.departmentLocationId === terminal}
        emptyText="いま、この部署にいる患者はいません（登録は「患者」タブ）。"
        onRequestTransport={onRequestTransport}
      />
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>
        {title} <span className="count">{count}件</span>
      </h2>
      {children}
    </section>
  );
}
