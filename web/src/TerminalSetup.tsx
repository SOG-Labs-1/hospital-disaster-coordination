import type { HospitalConfig } from '@hdc/shared';
import { setTerminalInUrl } from './session';

/** 端末を置いた場所を選ぶ（最初の1回だけ） */
export function TerminalSetup({ config }: { config: HospitalConfig }) {
  return (
    <main className="setup">
      <h1>この端末を置いた場所を選んでください</h1>
      <p>選んだ場所はこのブラウザに保存されます。あとで変えるときは、URL の terminal を書き換えます。</p>
      <div className="button-grid">
        {config.locations
          .filter((l) => l.hasTerminal)
          .map((l) => (
            <button key={l.id} type="button" className="btn btn-large" onClick={() => setTerminalInUrl(l.id)}>
              {l.name}
            </button>
          ))}
      </div>
    </main>
  );
}
