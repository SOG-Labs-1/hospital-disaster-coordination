import { zonesForLocation, type Decider, type HospitalConfig, type PatientView } from '@hdc/shared';

// 病院設定の id を画面の言葉にする。名前はすべて病院設定から読む

export function locationName(config: HospitalConfig, id: string): string {
  return config.locations.find((l) => l.id === id)?.name ?? id;
}

/** 場所名に、いま割り当てられている災害時の用途（ゾーン）を添える。例：救急外来（赤ゾーン） */
export function locationLabel(config: HospitalConfig, id: string, at: Date = new Date()): string {
  const zones = zonesForLocation(config, id, at.toISOString()).map((z) => config.zones.find((x) => x.id === z)?.name ?? z);
  return zones.length ? `${locationName(config, id)}（${zones.join('・')}）` : locationName(config, id);
}

export function hasTerminal(config: HospitalConfig, id: string): boolean {
  return config.locations.find((l) => l.id === id)?.hasTerminal ?? false;
}

export function triageText(config: HospitalConfig, id: string | null): string {
  const t = config.triageCategories.find((c) => c.id === id);
  return t ? `${t.symbol}${t.label}` : '？未判定';
}

export function staffName(config: HospitalConfig, id: string): string {
  return config.staff.find((s) => s.id === id)?.name ?? id;
}

export function transporterName(config: HospitalConfig, id: string): string {
  return config.transporters.find((t) => t.id === id)?.name ?? id;
}

/** 職種の名前。病院設定から消えた職種（設定を変える前の記録）は、英字の id のままにせず、その旨を添える */
export function professionName(config: HospitalConfig, id: string): string {
  return config.professions.find((p) => p.id === id)?.name ?? `設定にない職種（${id}）`;
}

export function deciderLabel(config: HospitalConfig, d: Decider): string {
  const who =
    config.positions.find((p) => p.id === d.positionId)?.name ??
    (d.staffId ? staffName(config, d.staffId) : undefined) ??
    d.name ??
    '（不明）';
  return d.asDeputy ? `${who}・代行` : who;
}

/** 患者を短く示す。例：P-003 タッグ12 ◆赤 */
export function patientShort(config: HospitalConfig, p: PatientView | undefined, id: string): string {
  if (!p) return id;
  return [p.id, p.tagNumber && `タッグ${p.tagNumber}`, triageText(config, p.triage)].filter(Boolean).join(' ');
}
