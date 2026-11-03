import { useEffect, useMemo, useRef, useState } from 'react';
import { reduce, type DomainEvent, type Mode } from '@hdc/shared';
import { fetchEvents } from './api';

export type SyncStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * サーバーの記録を読み込み、Server-Sent Events で追記を受け取る。
 * 画面の状態は常に記録全体から集計する（訂正イベントが過去の記録に効くため）。
 */
export function useEventLog(mode: Mode) {
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [status, setStatus] = useState<SyncStatus>('connecting');
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const known = useRef(new Set<string>());

  useEffect(() => {
    let closed = false;
    known.current = new Set();
    setEvents([]);

    const add = (incoming: DomainEvent[]) => {
      const fresh = incoming.filter((e) => !known.current.has(e.id));
      if (fresh.length === 0) return;
      for (const e of fresh) known.current.add(e.id);
      setEvents((prev) => [...prev, ...fresh]);
    };
    const lastId = () => {
      let last: string | null = null;
      for (const id of known.current) last = id;
      return last;
    };

    const source = new EventSource(`/api/${mode}/stream`);
    source.addEventListener('ready', async (msg) => {
      // 接続・再接続のたびに、取りこぼした記録を取り直す
      const { lastEventId } = JSON.parse((msg as MessageEvent).data) as { lastEventId: string | null };
      try {
        if (lastEventId !== lastId()) add(await fetchEvents(mode, lastId()).catch(() => fetchEvents(mode)));
        if (closed) return;
        setStatus('connected');
        setLastSyncedAt(new Date());
      } catch {
        setStatus('disconnected');
      }
    });
    source.addEventListener('domain-event', (msg) => {
      add([JSON.parse((msg as MessageEvent).data) as DomainEvent]);
      setLastSyncedAt(new Date());
    });
    source.onerror = () => {
      if (!closed) setStatus('disconnected');
    };
    return () => {
      closed = true;
      source.close();
    };
  }, [mode]);

  const state = useMemo(() => reduce(events), [events]);
  return { events, state, status, lastSyncedAt };
}
