import type { HospitalConfig } from '@hdc/shared';
import { setHospitalInUrl, setTerminalInUrl } from './session';

/** 端末を置いた場所を選ぶ（最初の1回だけ） */
export function TerminalSetup({ config, otherHospitals }: { config: HospitalConfig; otherHospitals: boolean }) {
  return (
    <main className="setup">
      <h1>この端末を置いた場所を選んでください</h1>
      <p>
        病院：<strong>{config.name}</strong>
      </p>
      <p>選んだ場所はこのブラウザに保存されます。あとで変えるときは、画面上の「端末の場所を変える」を押します。</p>
      <div className="button-grid">
        {config.locations
          .filter((l) => l.hasTerminal)
          .map((l) => (
            <button key={l.id} type="button" className="btn btn-large" onClick={() => setTerminalInUrl(l.id)}>
              {l.name}
            </button>
          ))}
      </div>
      {otherHospitals && (
        <button type="button" className="btn btn-quiet" onClick={() => setHospitalInUrl('')}>
          別の病院を選ぶ
        </button>
      )}
    </main>
  );
}
