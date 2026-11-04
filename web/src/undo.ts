import type { DomainEvent } from '@hdc/shared';
import type { Notice } from './useCommands';
import type { useCommands } from './useCommands';

type Run = ReturnType<typeof useCommands>['run'];
type Meta = { enteredBy: string; terminal: string; reportedBy: null };

/**
 * 1クリックで記録した操作に「元に戻す」を添える知らせを作る。
 * 取り消しは訂正イベント（retract）の追記で行い、元の記録は残す。
 */
export function undoNotice(opts: {
  run: Run;
  event: DomainEvent;
  meta: Meta;
  /** この記録を追記した後の、対象の版番号 */
  versionAfter: number;
  text: string;
  undoneText: string;
}): Notice {
  const { run, event, meta, versionAfter, text, undoneText } = opts;
  // 知らせは消えずに残るので、いつの操作かが分かるよう記録した時刻を先頭に付ける
  const at = new Date(event.recordedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return {
    kind: 'done',
    text: `${at} ${text}`,
    // 元に戻す記録は、元の操作をした入力者のものとして残す。入力者が替わったら、この知らせは消す（知らせのバーで判定）
    owner: meta.enteredBy,
    action: {
      label: '元に戻す',
      onClick: () =>
        run(
          () => ({
            command: { type: 'CorrectEvent', eventId: event.id, payload: { reason: undoReason(event.recordedAt), retract: true } },
            meta,
            expectedVersion: versionAfter,
          }),
          { doneText: undoneText },
        ),
    },
  };
}

/** 取り消しの理由。知らせは消えずに残るので、記録からどれだけ後に元に戻したかを残す */
export function undoReason(recordedAt: string, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - Date.parse(recordedAt)) / 60000);
  return minutes < 1 ? '記録の直後に元に戻した' : `記録から${minutes}分後に元に戻した`;
}
