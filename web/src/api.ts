import type { CommandEnvelopeInput, DomainEvent, DomainWarning, HospitalConfig, Mode, Subject } from '@hdc/shared';

export type CommandResponse =
  | { status: 'accepted'; events: DomainEvent[]; lastEventId: string }
  | { status: 'conflict'; subject: Subject; expectedVersion: number; currentVersion: number }
  | { status: 'warnings'; warnings: DomainWarning[] }
  | { status: 'rejected'; errors: string[] }
  | { status: 'error'; errors: string[] };

export async function fetchConfig(): Promise<HospitalConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('病院設定を読み込めない');
  return res.json();
}

export async function fetchEvents(mode: Mode, after?: string | null): Promise<DomainEvent[]> {
  const q = after ? `?after=${encodeURIComponent(after)}` : '';
  const res = await fetch(`/api/${mode}/events${q}`);
  if (!res.ok) throw new Error(`記録を読み込めない（${res.status}）`);
  return (await res.json()).events;
}

export async function sendCommand(mode: Mode, envelope: CommandEnvelopeInput): Promise<CommandResponse> {
  try {
    const res = await fetch(`/api/${mode}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    return await res.json();
  } catch {
    return { status: 'error', errors: ['サーバーに届かなかった。接続を確認して、もう一度送ってください'] };
  }
}
