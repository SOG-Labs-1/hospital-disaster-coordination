import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { CommandEnvelopeInput, DomainWarning, HospitalConfig, Mode, Override } from '@hdc/shared';
import { sendCommand } from './api';
import { WarningDialog } from './WarningDialog';

type Build = (override?: Override) => CommandEnvelopeInput;
export type RunResult = 'accepted' | 'cancelled' | 'failed';

interface Notice {
  kind: 'error' | 'conflict' | 'done';
  text: string;
}

interface Ctx {
  run: (build: Build, opts?: { doneText?: string }) => Promise<RunResult>;
  notice: Notice | null;
  clearNotice: () => void;
  highlight: string | null;
  setHighlight: (patientId: string | null) => void;
}

const CommandContext = createContext<Ctx | null>(null);

export function useCommands(): Ctx {
  const c = useContext(CommandContext);
  if (!c) throw new Error('CommandProvider の外で使われた');
  return c;
}

/** コマンドの送信。警告が返ったら理由を選ばせて再送し、競合なら知らせる */
export function CommandProvider({ mode, config, children }: { mode: Mode; config: HospitalConfig; children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    warnings: DomainWarning[];
    resolve: (override: Override | null) => void;
  } | null>(null);

  const run = useCallback<Ctx['run']>(
    async (build, opts) => {
      let override: Override | undefined;
      for (;;) {
        const r = await sendCommand(mode, build(override));
        if (r.status === 'accepted') {
          setNotice(opts?.doneText ? { kind: 'done', text: opts.doneText.replace('{id}', r.events[0]?.subject.id ?? '') } : null);
          return 'accepted';
        }
        if (r.status === 'warnings') {
          const answer = await new Promise<Override | null>((resolve) => setPending({ warnings: r.warnings, resolve }));
          setPending(null);
          if (!answer) return 'cancelled';
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
    <CommandContext.Provider value={{ run, notice, clearNotice: () => setNotice(null), highlight, setHighlight }}>
      {children}
      {pending && (
        <WarningDialog
          config={config}
          warnings={pending.warnings}
          onOpenPatient={(id) => {
            setHighlight(id);
            pending.resolve(null);
          }}
          onConfirm={(o) => pending.resolve(o)}
          onCancel={() => pending.resolve(null)}
        />
      )}
    </CommandContext.Provider>
  );
}
