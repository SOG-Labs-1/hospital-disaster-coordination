import { useState, type ReactNode } from 'react';
import { openSupports, pendingForLocation, type AppState, type HospitalConfig, type SupportView, type TransportView } from '@hdc/shared';
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

type Row =
  | { key: string; label: string; text: string; transport: TransportView }
  | { key: string; label: string; text: string; support: SupportView };

/**
 * 各部署の画面の上部に固定表示する「この部署への依頼・この部署が記録すること」。
 * どのタブを開いていても表示し、行ごとの「対応する」で搬送・要請のカードをその場で開く
 */
export function PinnedRequests(props: Props) {
  const { config, state, terminal } = props;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const p = pendingForLocation(state, terminal);
  const patient = (t: TransportView) => patientShort(config, state.patients[t.patientId], t.patientId);
  const rows: Row[] = [
    ...p.acceptRequests.map((t) => ({
      key: `accept-${t.id}`,
      label: '受け入れの判断',
      text: `${t.id} ${patient(t)}　${locationName(config, t.fromLocationId)}から（了承・断りが未記録）`,
      transport: t,
    })),
    ...p.arrivals.map((t) => ({
      key: `arrive-${t.id}`,
      label: '到着の記録',
      text: `${t.id} ${patient(t)}　${locationName(config, t.fromLocationId)}から移動中`,
      transport: t,
    })),
    ...p.departures.map((t) => ({
      key: `depart-${t.id}`,
      label: '出発の記録',
      text: `${t.id} ${patient(t)}　${locationName(config, t.toLocationId)}へ（${t.steps.accepted ? '了承済み' : '了承は未記録'}）`,
      transport: t,
    })),
    ...p.supportsToReceive.map((s) => ({
      key: `receive-${s.id}`,
      label: '届くはずの支援',
      text: `${s.id} ${(s.steps.dispatched?.items ?? s.items).map((it) => itemText(config, it)).join('、')}${
        s.steps.dispatched ? `（${s.steps.dispatched.providerLocationId ? locationName(config, s.steps.dispatched.providerLocationId) : s.steps.dispatched.providerName}から）` : '（手配はまだ）'
      }`,
      support: s,
    })),
    ...p.supportsToProvide.map((s) => ({
      key: `provide-${s.id}`,
      label: '送るはずの支援',
      text: `${s.id} ${locationName(config, s.steps.dispatched!.toLocationId)}へ ${s.steps.dispatched!.items.map((it) => itemText(config, it)).join('、')}`,
      support: s,
    })),
  ];

  return (
    <section className={`pinned ${rows.length ? 'has-items' : ''}`} aria-labelledby="pinned-title" data-testid="pinned-requests">
      <h2 id="pinned-title">
        {locationName(config, terminal)}への依頼・記録すること <span className="count">{rows.length}件</span>
      </h2>
      {rows.length === 0 ? (
        <p className="hint">いま、この部署が対応する依頼はありません。</p>
      ) : (
        <ul className="pinned-list">
          {rows.map((r) => (
            <li key={r.key} className="pinned-row" data-testid={`pinned-${r.key}`}>
              <div className="pinned-line">
                <span className="pinned-label">{r.label}</span>
                <span className="pinned-text">{r.text}</span>
                <button type="button" className="btn" aria-expanded={openKey === r.key} onClick={() => setOpenKey(openKey === r.key ? null : r.key)}>
                  {openKey === r.key ? '閉じる' : '対応する'}
                </button>
              </div>
              {openKey === r.key && (
                <ol className="transport-list pinned-card">
                  {'transport' in r ? <TransportCard transport={r.transport} {...props} /> : <SupportCard support={r.support} {...props} />}
                </ol>
              )}
            </li>
          ))}
        </ul>
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
