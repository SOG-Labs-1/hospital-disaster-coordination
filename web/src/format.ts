/** 時刻。今日でなければ日付も付ける（日をまたいだ記録を取り違えないように） */
export function formatTime(iso: string | Date | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function formatDateTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 経過分。端末とサーバーの時計の小さなずれで負にならないようにする */
export function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60000));
}

/**
 * 今より12時間以上先の時刻なら、前日の時刻とみなす（0:10 に「23:50」と入れたとき）。
 * 端末の時計が数分ずれているだけなら今日のまま（約24時間前と記録しない）
 */
const FUTURE_TOLERANCE_MS = 12 * 60 * 60_000;

/**
 * 時刻入力（HH:MM）を日付つきの時刻にする。空欄なら undefined（＝今）。
 * 今より先の時刻は前日とみなす（0:10 に「23:50に確認」と入れたとき、未来の時刻として拒否されないように）
 */
export function timeInputToDate(value: string, now = new Date()): Date | undefined {
  if (!value) return undefined;
  const [h, m] = value.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  if (d.getTime() - now.getTime() > FUTURE_TOLERANCE_MS) d.setDate(d.getDate() - 1);
  return d;
}

export function timeInputToIso(value: string): string | undefined {
  return timeInputToDate(value)?.toISOString();
}

/** 時刻入力が前日の時刻として扱われるときの説明。今日なら null */
export function timeInputNote(value: string, now = new Date()): string | null {
  const d = timeInputToDate(value, now);
  if (!d || d.toDateString() === now.toDateString()) return null;
  return `前日（${d.getMonth() + 1}/${d.getDate()}）の ${value} として記録します`;
}
