import type { CommandEnvelopeInput, DomainEvent, DomainWarning, HospitalConfig, Mode, Subject } from '@hdc/shared';

export type CommandResponse =
  | { status: 'accepted'; events: DomainEvent[]; lastEventId: string }
  | { status: 'conflict'; subject: Subject; expectedVersion: number; currentVersion: number }
  | { status: 'warnings'; warnings: DomainWarning[] }
  | { status: 'rejected'; errors: string[] }
  | { status: 'error'; errors: string[] };

// 1つの画面で扱う病院は1つ。起動時に決めた病院の API を呼ぶ
let hospitalId = '';
export function setApiHospital(id: string) {
  hospitalId = id;
}
export function apiBase(mode: Mode): string {
  return `/api/h/${encodeURIComponent(hospitalId)}/${mode}`;
}

export interface HospitalList {
  hospitals: { id: string; name: string }[];
  defaultHospitalId: string | null;
  /** 画面から病院を作れるか */
  canCreate: boolean;
  /** インターネットに公開した審査用のデモか（画面に案内を出す） */
  publicDemo?: boolean;
}

/** 公開デモか（病院の一覧を読み込んだときに決まる）。訓練の画面の案内に使う */
export let isPublicDemo = false;

export async function fetchHospitals(): Promise<HospitalList> {
  const res = await fetch('/api/hospitals');
  if (!res.ok) throw new Error('病院の一覧を読み込めない');
  const list = (await res.json()) as HospitalList;
  isPublicDemo = !!list.publicDemo;
  return list;
}

export async function fetchConfig(): Promise<HospitalConfig> {
  const res = await fetch(`/api/h/${encodeURIComponent(hospitalId)}/config`);
  if (!res.ok) throw new Error('病院設定を読み込めない');
  return res.json();
}

export async function fetchEvents(mode: Mode, after?: string | null): Promise<DomainEvent[]> {
  const q = after ? `?after=${encodeURIComponent(after)}` : '';
  const res = await fetch(`${apiBase(mode)}/events${q}`);
  if (!res.ok) throw new Error(`記録を読み込めない（${res.status}）`);
  return (await res.json()).events;
}

export async function sendCommand(mode: Mode, envelope: CommandEnvelopeInput): Promise<CommandResponse> {
  try {
    const res = await fetch(`${apiBase(mode)}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    return await res.json();
  } catch {
    return { status: 'error', errors: ['サーバーに届かなかった。接続を確認して、もう一度送ってください'] };
  }
}
