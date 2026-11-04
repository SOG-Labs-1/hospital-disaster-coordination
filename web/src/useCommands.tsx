import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppState, CommandEnvelopeInput, DomainEvent, DomainWarning, HospitalConfig, Mode, Override } from '@hdc/shared';
import { sendCommand } from './api';
import { WarningDialog } from './WarningDialog';

type Build = (override?: Override) => CommandEnvelopeInput;
export type RunResult = 'accepted' | 'cancelled' | 'failed';

export interface Notice {
  kind: 'error' | 'conflict' | 'done' | 'info';
  text: string;
  /** 「元に戻す」など、知らせに添える操作 */
  action?: { label: string; onClick: () => void };
}

interface RunOptions {
  doneText?: string;
  /** 警告を承知で実行するボタンの言葉（例：別の患者として登録する） */
  overrideLabel?: string;
  /** 登録などを取りやめたときの知らせ */
  cancelledText?: string;
  onAccepted?: (events: DomainEvent[]) => void;
}

interface Ctx {
  run: (build: Build, opts?: RunOptions) => Promise<RunResult>;
  notice: Notice | null;
  showNotice: (notice: Notice | null) => void;
  highlight: string | null;
  setHighlight: (patientId: string | null) => void;
}

const CommandContext = createContext<Ctx | null>(null);

export function useCommands(): Ctx {
  const c = useContext(CommandContext);
  if (!c) throw new Error('CommandProvider の外で使われた');
  return c;
}

/** 完了の知らせは、古い内容が残り続けないように一定時間で消す */
const DONE_NOTICE_MS = 20_000;

/** コマンドの送信。警告が返ったら理由を選ばせて再送し、競合なら知らせる */
export function CommandProvider(props: { mode: Mode; config: HospitalConfig; state: AppState; children: ReactNode }) {
  const { mode, config, state, children } = props;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    warnings: DomainWarning[];
    overrideLabel: string;
    resolve: (answer: Override | { openPatient: string } | null) => void;
  } | null>(null);

  useEffect(() => {
    if (notice?.kind !== 'done') return;
    const t = setTimeout(() => setNotice((n) => (n === notice ? null : n)), DONE_NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const run = useCallback<Ctx['run']>(
    async (build, opts = {}) => {
      let override: Override | undefined;
      for (;;) {
        const r = await sendCommand(mode, build(override));
        if (r.status === 'accepted') {
          setNotice(opts.doneText ? { kind: 'done', text: opts.doneText.replace('{id}', r.events[0]?.subject.id ?? '') } : null);
          opts.onAccepted?.(r.events);
          return 'accepted';
        }
        if (r.status === 'warnings') {
          const answer = await new Promise<Override | { openPatient: string } | null>((resolve) =>
            setPending({ warnings: r.warnings, overrideLabel: opts.overrideLabel ?? '警告を承知で記録する', resolve }),
          );
          setPending(null);
          if (answer && 'openPatient' in answer) {
            setHighlight(answer.openPatient);
            setNotice({
              kind: 'info',
              text: `記録はしていません。入力した内容はそのまま残っています。一覧で ${answer.openPatient} を表示しています。`,
            });
            return 'cancelled';
          }
          if (!answer) {
            setNotice({ kind: 'info', text: opts.cancelledText ?? '記録はしていません。入力した内容はそのまま残っています。' });
            return 'cancelled';
          }
          override = answer;
          continue;
        }
        if (r.status === 'conflict') {
          setNotice({
            kind: 'conflict',
            text: `${r.subject.id} はほかの端末で先に更新されました。一覧の最新の内容を確かめて、もう一度操作してください。`,
          });
          return 'failed';
        }
        setNotice({ kind: 'error', text: `記録できませんでした：${r.errors.join(' ／ ')}` });
        return 'failed';
      }
    },
    [mode],
  );

  return (
    <CommandContext.Provider value={{ run, notice, showNotice: setNotice, highlight, setHighlight }}>
      {children}
      {pending && (
        <WarningDialog
          config={config}
          state={state}
          warnings={pending.warnings}
          confirmLabel={pending.overrideLabel}
          onOpenPatient={(id) => pending.resolve({ openPatient: id })}
          onConfirm={(o) => pending.resolve(o)}
          onCancel={() => pending.resolve(null)}
        />
      )}
    </CommandContext.Provider>
  );
}
