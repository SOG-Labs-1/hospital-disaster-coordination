export function formatTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 経過分 */
export function minutesSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 60000);
}

/** 時刻入力（HH:MM）を今日の日付の ISO 文字列にする。空欄なら undefined（＝今） */
export function timeInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const [h, m] = value.split(':').map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toISOString();
}
