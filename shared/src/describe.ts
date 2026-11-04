import type { HospitalConfig } from './config';
import {
  identifierLabels,
  messageChannelLabels,
  noteFieldLabels,
  sexLabels,
  type Decider,
  type DomainEvent,
  type EventType,
  type SupportItem,
} from './events';

// 記録（イベント）を、クロノロジーや振り返りで読む日本語の1行にする。名前はすべて病院設定から引く

export type EventCategory = 'patient' | 'transport' | 'transporter' | 'support' | 'location' | 'message' | 'correction';

export const eventCategoryLabels: Record<EventCategory, string> = {
  patient: '患者',
  transport: '搬送',
  transporter: '搬送要員',
  support: '支援要請',
  location: '場所',
  message: '連絡',
  correction: '訂正',
};

export interface EventDescription {
  category: EventCategory;
  /** 調整（依頼したこと）か事実（起きたこと）か、報告か */
  kind: 'coordination' | 'fact' | 'report' | 'record';
  /** 対象の番号（P-001、T-002 など。場所は場所名） */
  subjectLabel: string;
  text: string;
}

/** イベントの種類の短い名前（訂正の対象を示すときなど） */
export const eventTypeLabels: Record<EventType, string> = {
  PatientRegistered: '患者の登録',
  PatientIdentifierAdded: '識別情報の追加',
  PatientTriageChanged: '区分の変更',
  PatientNoteUpdated: 'メモの更新',
  PatientDetailsCorrected: '登録内容の訂正',
  PatientsMerged: '患者の統合',
  EventCorrected: '訂正',
  TransportRequested: '搬送の要請',
  TransportAccepted: '受け入れ了承',
  TransportDeclined: '受け入れの断り',
  TransportStaffAssigned: '搬送要員の割り当て',
  TransportOrdered: '搬送の指示',
  TransportAcknowledged: '指示の受領確認',
  TransportCancelled: '搬送の中止',
  TransportRedirected: '行き先の変更',
  TransportDeparted: '出発',
  TransportArrived: '到着',
  TransportHandedOver: '引き渡し',
  TransporterAvailabilityChanged: '搬送要員の対応可否',
  LocationStatusReported: '場所の状況の報告',
  StaffCountReported: '人員の報告',
  SupportRequested: '支援の要請',
  SupportAssigned: '要請の受付',
  SupportDispatched: '手配の指示',
  SupportReceived: '支援が届いた',
  SupportCompleted: '要請の完了',
  SupportCancelled: '要請の中止',
  MessageLogged: '連絡メモ',
};

export function describeEvent(e: DomainEvent, config: HospitalConfig, lookup: (eventId: string) => DomainEvent | undefined = () => undefined): EventDescription {
  const loc = (id: string | undefined) => (id ? (config.locations.find((l) => l.id === id)?.name ?? id) : '（場所不明）');
  const triage = (id: string | null) => {
    const t = config.triageCategories.find((c) => c.id === id);
    return t ? `${t.symbol}${t.label}` : '？未判定';
  };
  const decider = (d: Decider) => {
    const who = config.positions.find((p) => p.id === d.positionId)?.name ?? config.staff.find((s) => s.id === d.staffId)?.name ?? d.name ?? '（不明）';
    return d.asDeputy ? `${who}・代行` : who;
  };
  const item = (it: SupportItem) => {
    const qty = (unit: string) => (it.quantity === null ? '（数は未確認）' : `${it.quantity}${unit}`);
    if (it.professionId) return `${config.professions.find((p) => p.id === it.professionId)?.name ?? it.professionId} ${qty('人')}`;
    if (it.resourceId) {
      const r = config.resources.find((x) => x.id === it.resourceId);
      return `${r?.name ?? it.resourceId} ${qty(r?.unit ?? '')}`;
    }
    return it.text ?? '';
  };
  const count = (v: number | null) => (v === null ? '未確認' : `${v}人`);
  const id = e.subject.id;
  const d = (category: EventCategory, kind: EventDescription['kind'], text: string, subjectLabel = id): EventDescription => ({ category, kind, subjectLabel, text });

  switch (e.type) {
    case 'PatientRegistered': {
      const p = e.payload;
      const ids = [p.tagNumber && `タッグ${p.tagNumber}`, p.hospitalPatientId && `院内ID ${p.hospitalPatientId}`, p.name].filter(Boolean).join('、');
      const looks = [p.sex !== 'unknown' && sexLabels[p.sex], p.estimatedAge, p.features].filter(Boolean).join('、');
      return d('patient', 'record', `患者を登録：${triage(p.triage)}　${loc(p.locationId)}${ids ? `　${ids}` : ''}${looks ? `　特徴：${looks}` : ''}`);
    }
    case 'PatientIdentifierAdded':
      return d('patient', 'record', `${identifierLabels[e.payload.kind]}を記録：${e.payload.value}`);
    case 'PatientTriageChanged':
      return d('patient', 'record', `区分を${triage(e.payload.triage)}に変更`);
    case 'PatientNoteUpdated':
      return d('patient', 'record', `${noteFieldLabels[e.payload.field]}：${e.payload.value || '（消去）'}`);
    case 'PatientDetailsCorrected': {
      const f = e.payload.fields;
      const parts = [
        f.tagNumber !== undefined && `タッグ番号→${f.tagNumber || '（消去）'}`,
        f.hospitalPatientId !== undefined && `院内患者ID→${f.hospitalPatientId || '（消去）'}`,
        f.medicalId !== undefined && `メディカルID→${f.medicalId || '（消去）'}`,
        f.name !== undefined && `氏名→${f.name || '（消去）'}`,
        f.sex !== undefined && `性別→${sexLabels[f.sex]}`,
        f.estimatedAge !== undefined && `推定年齢→${f.estimatedAge || '（消去）'}`,
        f.features !== undefined && `特徴→${f.features || '（消去）'}`,
        f.conditionNote !== undefined && `状態→${f.conditionNote || '（消去）'}`,
        f.locationId !== undefined && `所在→${loc(f.locationId)}`,
        f.departmentLocationId !== undefined && `担当→${loc(f.departmentLocationId)}`,
      ].filter(Boolean);
      return d('patient', 'record', `登録内容を訂正：${parts.join('、')}（理由：${e.payload.reason}）`);
    }
    case 'PatientsMerged':
      return d('patient', 'record', `${e.payload.sourceId} を ${id} にまとめた（同じ患者。理由：${e.payload.reason}）`);
    case 'EventCorrected': {
      const target = e.corrects ? lookup(e.corrects) : undefined;
      const what = target ? `${target.subject.id} の「${eventTypeLabels[target.type]}」` : '記録';
      return d('correction', 'record', `${what}を${e.payload.retract ? '取り消し' : '訂正'}：${e.payload.reason}`);
    }
    case 'TransportRequested': {
      const p = e.payload;
      return d('transport', 'coordination', `搬送の要請：${p.patientId}　${loc(p.fromLocationId)} → ${loc(p.toLocationId)}`);
    }
    case 'TransportAccepted':
      return d('transport', 'coordination', `受け入れ了承（判断：${decider(e.payload.decidedBy)}）`);
    case 'TransportDeclined':
      return d('transport', 'coordination', `受け入れの断り（判断：${decider(e.payload.decidedBy)}）：${e.payload.reason}`);
    case 'TransportStaffAssigned': {
      const names = e.payload.transporterIds.map((t) => config.transporters.find((x) => x.id === t)?.name ?? t).join('、');
      const team = config.transporterTeams.find((t) => t.id === e.payload.teamId)?.name;
      return d('transport', 'coordination', `搬送要員を割り当て：${team ? `${team}（${names}）` : names}`);
    }
    case 'TransportOrdered':
      return d('transport', 'coordination', `搬送を指示（${decider(e.payload.orderedBy)}）`);
    case 'TransportAcknowledged':
      return d('transport', 'coordination', '指示の受領を確認');
    case 'TransportCancelled':
      return d('transport', 'coordination', `搬送を中止：${e.payload.reason}`);
    case 'TransportRedirected':
      return d('transport', 'coordination', `行き先を${loc(e.payload.toLocationId)}に変更：${e.payload.reason}`);
    case 'TransportDeparted':
      return d('transport', 'fact', '出発');
    case 'TransportArrived':
      return d('transport', 'fact', e.payload.handover ? '到着（引き渡し）' : '到着');
    case 'TransportHandedOver':
      return d('transport', 'fact', '引き渡し');
    case 'TransporterAvailabilityChanged': {
      const name = config.transporters.find((t) => t.id === id)?.name ?? id;
      return d('transporter', 'report', `${e.payload.available ? '待機に戻した' : '対応不可にした'}${e.payload.note ? `：${e.payload.note}` : ''}`, name);
    }
    case 'LocationStatusReported': {
      const p = e.payload;
      const parts = [
        p.accepting !== undefined && `受け入れ${p.accepting === null ? '未確認' : p.accepting ? '可' : '不可'}`,
        ...p.capacity.map((c) => `${triage(c.triage)}の受け入れ可能 ${count(c.value)}`),
        p.note && `メモ：${p.note}`,
      ].filter(Boolean);
      return d('location', 'report', `状況の報告：${parts.join('、') || '（変更なし）'}`, loc(id));
    }
    case 'StaffCountReported':
      return d(
        'location',
        'report',
        `人員の報告：${e.payload.counts.map((c) => `${config.professions.find((p) => p.id === c.professionId)?.name ?? c.professionId} ${count(c.value)}`).join('、')}`,
        loc(id),
      );
    case 'SupportRequested': {
      const kind = config.supportKinds.find((k) => k.id === e.payload.kindId)?.name ?? e.payload.kindId;
      return d('support', 'coordination', `支援の要請（${kind}）：${loc(e.payload.fromLocationId)}　${e.payload.items.map(item).join('、')}`);
    }
    case 'SupportAssigned':
      return d('support', 'coordination', `要請を受付（担当：${decider(e.payload.assignee)}）`);
    case 'SupportDispatched': {
      const p = e.payload;
      const provider = p.providerLocationId ? loc(p.providerLocationId) : p.providerName;
      return d('support', 'coordination', `手配を指示：${provider ? `${provider}から` : ''}${p.toLocationId ? `${loc(p.toLocationId)}へ` : '要請した場所へ'}`);
    }
    case 'SupportReceived':
      return d('support', 'fact', `支援が届いた${e.payload.note ? `：${e.payload.note}` : ''}`);
    case 'SupportCompleted':
      return d('support', 'fact', `要請を完了${e.payload.note ? `：${e.payload.note}` : ''}`);
    case 'SupportCancelled':
      return d('support', 'coordination', `要請を中止：${e.payload.reason}`);
    case 'MessageLogged': {
      const p = e.payload;
      const route = [p.fromLocationId && `${loc(p.fromLocationId)}から`, p.toLocationId && `${loc(p.toLocationId)}へ`].filter(Boolean).join('');
      return d('message', 'record', `${messageChannelLabels[p.channel]}${route ? `（${route}）` : ''}：${p.text}${p.relatedIds.length ? `　［${p.relatedIds.join('、')}］` : ''}`);
    }
  }
}
