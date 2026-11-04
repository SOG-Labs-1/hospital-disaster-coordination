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

/** URL の ?terminal= を優先し、なければこのブラウザに保存した値 */
export function readTerminal(): string | null {
  const fromUrl = new URLSearchParams(location.search).get('terminal');
  if (fromUrl) {
    safeSet('hdc.terminal', fromUrl);
    return fromUrl;
  }
  return safeGet('hdc.terminal');
}

export function setTerminalInUrl(terminal: string) {
  safeSet('hdc.terminal', terminal);
  const params = new URLSearchParams(location.search);
  params.set('terminal', terminal);
  location.search = params.toString();
}

export function readEnteredBy(terminal: string): string | null {
  return safeGet(`hdc.enteredBy.${terminal}`);
}
export function saveEnteredBy(terminal: string, staffId: string | null) {
  safeSet(`hdc.enteredBy.${terminal}`, staffId);
}
