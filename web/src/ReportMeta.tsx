import type { HospitalConfig, Reporter } from '@hdc/shared';
import { timeInputToIso } from './format';

// 無線・電話で受けた報告を代わりに入力するときの「報告元」と「現場で確認した時刻」

export interface ReportMetaValue {
  reporterLocationId: string;
  reporterName: string;
  /** HH:MM。空欄なら記録時刻（今） */
  observedTime: string;
}

export const emptyReportMeta: ReportMetaValue = { reporterLocationId: '', reporterName: '', observedTime: '' };

export function toReportMeta(v: ReportMetaValue, fixedLocationId?: string): { reportedBy: Reporter | null; observedAt?: string } {
  const locationId = fixedLocationId ?? (v.reporterLocationId || undefined);
  const name = v.reporterName.trim() || undefined;
  return {
    reportedBy: locationId || name ? { locationId, name } : null,
    observedAt: timeInputToIso(v.observedTime),
  };
}

export function isReportMetaSet(v: ReportMetaValue): boolean {
  return !!(v.reporterLocationId || v.reporterName.trim() || v.observedTime);
}

export function ReportMetaFields(props: {
  config: HospitalConfig;
  value: ReportMetaValue;
  onChange: (v: ReportMetaValue) => void;
  /** 報告元の場所が決まっている場合（場所の報告など） */
  fixedLocationId?: string;
  summary?: string;
}) {
  const { config, value, onChange, fixedLocationId } = props;
  const set = (patch: Partial<ReportMetaValue>) => onChange({ ...value, ...patch });
  return (
    <details className="more report-meta" open={isReportMetaSet(value) || undefined}>
      <summary>
        {props.summary ?? '無線・電話で受けた報告のとき（報告元・確認時刻）'}
        {isReportMetaSet(value) && <span className="report-meta-set">✓ 入力あり</span>}
      </summary>
      <div className="field-row">
        {!fixedLocationId && (
          <label className="field">
            <span>報告元の場所</span>
            <select value={value.reporterLocationId} onChange={(e) => set({ reporterLocationId: e.target.value })}>
              <option value="">（この端末で確認）</option>
              {config.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>報告した人</span>
          <input value={value.reporterName} onChange={(e) => set({ reporterName: e.target.value })} autoComplete="off" />
        </label>
        <label className="field">
          <span>現場で確認した時刻（空欄＝今）</span>
          <input type="time" value={value.observedTime} onChange={(e) => set({ observedTime: e.target.value })} />
        </label>
      </div>
    </details>
  );
}
