import { modeLabels, type HospitalConfig, type Mode } from '@hdc/shared';
import { setHospitalInUrl, setTerminalInUrl } from './session';
import { boardUrl } from './TerminalSettings';

/** 端末を置いた場所を選ぶ（最初の1回だけ） */
export function TerminalSetup({ config, mode, otherHospitals }: { config: HospitalConfig; mode: Mode; otherHospitals: boolean }) {
  return (
    <main className="setup">
      <h1>このパソコンを置いた場所を選んでください</h1>
      <p>
        病院：<strong>{config.name}</strong>
      </p>
      <p>
        モード：<strong>{mode === 'training' ? '◇' : '■'} {modeLabels[mode]}</strong>
      </p>
      <p>このパソコン（端末）で入力した記録は、選んだ場所からの記録になります。選んだ場所はこのブラウザに保存されます。あとで変えるときは、画面上部の「⚙ 端末の設定」から変えられます。</p>
      <div className="button-grid">
        {config.locations
          .filter((l) => l.hasTerminal)
          .map((l) => (
            <button key={l.id} type="button" className="btn btn-large" onClick={() => setTerminalInUrl(l.id)}>
              {l.name}
            </button>
          ))}
      </div>
      <h2>本部の大型モニターに映すとき</h2>
      <p>掲示用画面は操作のない画面で、記録が変わると自動で更新されます。大型モニターにつないだパソコンで開き、全画面表示（F11 キー、Mac は control＋command＋F）にします。</p>
      <a className="btn btn-large" href={boardUrl(config.id, mode)}>
        この端末を掲示用画面にする
      </a>
      {otherHospitals && (
        <button type="button" className="btn btn-quiet" onClick={() => setHospitalInUrl('')}>
          別の病院を選ぶ
        </button>
      )}
    </main>
  );
}
