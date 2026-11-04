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
  return {
    kind: 'done',
    text,
    action: {
      label: '元に戻す',
      onClick: () =>
        run(
          () => ({
            command: { type: 'CorrectEvent', eventId: event.id, payload: { reason: '記録の直後に元に戻した', retract: true } },
            meta,
            expectedVersion: versionAfter,
          }),
          { doneText: undoneText },
        ),
    },
  };
}
