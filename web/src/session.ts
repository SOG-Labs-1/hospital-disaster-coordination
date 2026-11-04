import type { Mode } from '@hdc/shared';

// 端末の設定（どの場所に置いた端末か、実運用／訓練、選んでいる入力者）。ログインはしない。

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 保存できなくても動く */
  }
}

/** URL の ?mode=。省略時は実運用。知らない値は null（黙って実運用にしない） */
export function readMode(): Mode | null {
  const value = new URLSearchParams(location.search).get('mode');
  if (value === null || value === 'live') return 'live';
  if (value === 'training') return 'training';
  return null;
}

export function setModeInUrl(mode: Mode) {
  const params = new URLSearchParams(location.search);
  params.set('mode', mode);
  location.search = params.toString();
}

/** URL の ?hospital= を優先し、なければこのブラウザに保存した値、なければサーバーの既定 */
export function readHospital(available: string[], serverDefault: string | null): string | null {
  const fromUrl = new URLSearchParams(location.search).get('hospital');
  if (fromUrl === '') return null; // 「別の病院を選ぶ」を押したとき
  if (fromUrl && available.includes(fromUrl)) {
    safeSet('hdc.hospital', fromUrl);
    return fromUrl;
  }
  if (fromUrl) return null; // 知らない病院を指定されたら選び直させる
  const saved = safeGet('hdc.hospital');
  if (saved && available.includes(saved)) return saved;
  return serverDefault;
}

/** 病院を切り替える。空文字なら保存を消して、病院を選ぶ画面に戻す */
export function setHospitalInUrl(hospitalId: string, mode?: Mode) {
  safeSet('hdc.hospital', hospitalId || null);
  const params = new URLSearchParams(location.search);
  params.set('hospital', hospitalId);
  if (mode) params.set('mode', mode);
  // 病院が変われば場所も変わるので、端末の場所は選び直す
  params.delete('terminal');
  location.search = params.toString();
}

// 端末の場所と入力者は病院ごとに保存する（病院Aの場所を病院Bで使わない）
let hospitalKey = '';
export function setSessionHospital(id: string) {
  hospitalKey = id;
}

/** URL の ?terminal= を優先し、なければこのブラウザに保存した値 */
export function readTerminal(): string | null {
  const fromUrl = new URLSearchParams(location.search).get('terminal');
  if (fromUrl) {
    safeSet(`hdc.terminal.${hospitalKey}`, fromUrl);
    return fromUrl;
  }
  return safeGet(`hdc.terminal.${hospitalKey}`);
}

export function setTerminalInUrl(terminal: string) {
  safeSet(`hdc.terminal.${hospitalKey}`, terminal);
  const params = new URLSearchParams(location.search);
  params.set('terminal', terminal);
  location.search = params.toString();
}

/** 端末の場所の設定を消して、場所を選ぶ画面に戻す */
export function clearTerminal() {
  safeSet(`hdc.terminal.${hospitalKey}`, null);
  const params = new URLSearchParams(location.search);
  params.delete('terminal');
  location.search = params.toString();
}

export function readEnteredBy(terminal: string): string | null {
  return safeGet(`hdc.enteredBy.${hospitalKey}.${terminal}`);
}
export function saveEnteredBy(terminal: string, staffId: string | null) {
  safeSet(`hdc.enteredBy.${hospitalKey}.${terminal}`, staffId);
}
