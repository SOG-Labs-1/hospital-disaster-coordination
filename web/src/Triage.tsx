import type { HospitalConfig } from '@hdc/shared';

/** トリアージ区分の表示。色・記号・文字の3つで示す（色だけに頼らない） */
export function TriageBadge({ config, triage, size = 'normal' }: { config: HospitalConfig; triage: string | null; size?: 'normal' | 'large' }) {
  const t = config.triageCategories.find((c) => c.id === triage);
  if (!t) {
    return (
      <span className={`triage triage-none triage-${size}`} data-print-border="dotted">
        <span aria-hidden="true">？</span> 未判定
      </span>
    );
  }
  return (
    <span
      className={`triage triage-${size}`}
      style={{ background: t.color, color: t.textColor }}
      data-print-border={t.printBorder}
      title={t.description}
    >
      <span aria-hidden="true" className="triage-symbol">{t.symbol}</span> {t.label}
      <span className="triage-desc">{t.description}</span>
    </span>
  );
}
