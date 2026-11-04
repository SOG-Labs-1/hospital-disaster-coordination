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

/** 時刻入力（HH:MM）を今日の日付の ISO 文字列にする。空欄なら undefined（＝今） */
export function timeInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const [h, m] = value.split(':').map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toISOString();
}
