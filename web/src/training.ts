import { useEffect, useState } from 'react';

// 訓練の進行（シミュレーター）の状態を受け取る。実運用モードでは使わない
// 実際の状態（シミュレーターの truth）は受け取らない。参加者が見られるのは無線の受信と自分の送信だけ

export interface TrainingSnapshot {
  serverTime: string;
  provider: string;
  scenarios: { id: string; title: string; description: string; durationMinutes: number; roles: { locationId: string; name: string }[] }[];
  run: {
    runId: string;
    scenarioId: string;
    title: string;
    running: boolean;
    speed: number;
    simMs: number;
    durationMs: number;
    ended: { simMs: number; reason: 'time' | 'manual' } | null;
    startedAt: string;
  } | null;
  inbox: { messageId: string; from: string; fromName: string; text: string; simMs: number; heard: boolean }[];
  outbox: { messageId: string; to: string; toName: string; text: string; simMs: number }[];
  pendingReplies: number;
  review: {
    findings: {
      id: string;
      category: string;
      categoryLabel: string;
      kind: 'no-record' | 'not-done';
      title: string;
      detail: string;
      evidence: string[];
      note?: string;
      explanation?: { text: string; evidence: string[] };
    }[];
    checks: { id: string; text: string; source: 'scenario' | 'hospital'; result: 'met' | 'no-record' | 'not-met' | 'not-reached' | 'self-check'; evidence: string[] }[];
    explainedBy: string | null;
  } | null;
}

let base = '';
export function setTrainingHospital(hospitalId: string) {
  base = `/api/h/${encodeURIComponent(hospitalId)}/training/sim`;
}

export async function trainingPost(path: 'control' | 'message' | 'heard' | 'note' | 'explain', body: unknown): Promise<{ ok: true; snapshot: TrainingSnapshot } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    return res.ok ? { ok: true, snapshot: json } : { ok: false, error: (json.errors ?? ['送れなかった']).join(' ／ ') };
  } catch {
    return { ok: false, error: 'サーバーに届かなかった' };
  }
}

/** 訓練の状態。null は「この病院には訓練のシナリオがない」、undefined は読み込み中 */
export function useTraining(enabled: boolean): TrainingSnapshot | null | undefined {
  const [snap, setSnap] = useState<TrainingSnapshot | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let source: EventSource | null = null;
    // シナリオのない病院では配信を開かない（404 への再接続を繰り返さない）
    fetch(base)
      .then((r) => {
        if (closed) return;
        if (r.status === 404) return setSnap(null);
        source = new EventSource(`${base}/stream`);
        source.addEventListener('sim', (msg) => setSnap(JSON.parse((msg as MessageEvent).data)));
      })
      .catch(() => {
        /* サーバーに届かないときは、上部の同期状態に「切断」と出る */
      });
    return () => {
      closed = true;
      source?.close();
    };
  }, [enabled]);
  return snap;
}

/** 訓練の時計。サーバーの時刻からの経過で、表示用に進める */
export function liveSimMs(s: TrainingSnapshot, now: Date): number {
  const r = s.run;
  if (!r) return 0;
  if (r.ended || !r.running) return r.simMs;
  return Math.min(r.durationMs, r.simMs + (now.getTime() - Date.parse(s.serverTime)) * r.speed);
}

export function formatSim(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
