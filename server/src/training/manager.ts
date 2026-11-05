import {
  advance,
  buildReview,
  pendingBoardWrites,
  reasonsForWarnings,
  reduce,
  TRANSPORTER_ROLE,
  type CommandEnvelopeInput,
  buildRoleContext,
  containsMedicalAdvice,
  reduceSim,
  resolveProposals,
  simMsAt,
  type DomainEvent,
  type HospitalConfig,
  type Review,
  type Scenario,
  type SimEvent,
  type SimEventInput,
  type SimView,
} from '@hdc/shared';
import type { AiProvider } from '../ai';
import { MockProvider } from '../ai/mock';
import { SimStore } from './sim-store';

/** 本部から部署役への連絡の長さ（無線で伝える1回分。プロンプトを大きくしすぎない） */
export const MAX_HQ_MESSAGE_LENGTH = 300;
/** 1回の訓練で本部から送れる連絡の数 */
export const MAX_HQ_MESSAGES_PER_RUN = 60;
/** 1回の訓練で振り返りの説明文を作れる回数（自動と手動の合計）と、そのうち自動で作り直す回数 */
export const MAX_EXPLAIN_ATTEMPTS = 3;
export const MAX_AUTO_EXPLAIN_ATTEMPTS = 2;

// 訓練の進行。シミュレーター（shared）を時計で動かし、部署役（AiProvider）に刺激を渡し、
// 返ってきた提案をシミュレーターで検証して記録する。
// 「このツールを使った訓練」なので、部署の端末からの記録（患者の登録・受け入れ状況・支援要請・受け入れの判断・
// 到着・支援の受け取り）は、ふつうの端末と同じコマンドの検証（サーバーの decide）を通してボードに記録する。
// AI が直接ボードを書き換えることはない（AI の判断は、シミュレーターの検証とコマンドの検証の両方を通る）。

/** ボードの読み取り、部署の端末からの記録（コマンドの検証を通す）、訓練の回ごとのボードの切り替え */
export interface BoardAccess {
  events(): readonly DomainEvent[];
  /** 部署の端末からの記録として、コマンドを検証して追記する。結果（受け付け・警告・却下）を返す */
  submit(envelope: CommandEnvelopeInput): { status: string; errors?: string[]; warnings?: { code: string }[]; events?: { subject: { id: string } }[] };
  /** 新しい回を始めるとき、その回のボード（別ファイル）に切り替える */
  switchRun(runId: string | null): void;
}

export interface TrainingDeps {
  config: HospitalConfig;
  scenarios: Scenario[];
  simStorePath: string;
  provider: AiProvider;
  board: BoardAccess;
  newId: () => string;
  now?: () => Date;
  /** 何かが変わったときに呼ぶ（画面への配信） */
  onChange?: () => void;
  /** 部署役の返事を待つ時間（ms）。過ぎたら決まった返事で補う */
  replyTimeoutMs?: number;
  /** 進行中の回があるあいだは、新しい回を始めさせない（公開デモで、別の人の訓練を途中で終わらせないように） */
  exclusiveRuns?: boolean;
  /** 1日（日本時間）に部署役の AI で始められる回数。超えた回は決まった返事（mock）で動かす（費用の上限） */
  runsPerDay?: number;
}

/** 時間内に終わらなければ失敗にする */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${ms}ms 以内に返事がなかった`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const NOTE_MAX = 300;

export type ControlAction = { action: 'start'; scenarioId: string } | { action: 'pause' } | { action: 'resume' } | { action: 'speed'; speed: number } | { action: 'end' };

export class TrainingManager {
  private store: SimStore;
  private runId: string | null;
  private events: SimEvent[];
  private inflight = new Set<string>();
  private now: () => Date;
  /** AI が失敗したときに補う、決まった返事 */
  private fallback = new MockProvider();
  /** この回の部署役。1日の上限を超えた回は決まった返事（mock）にする */
  private runProvider: AiProvider | null = null;
  private runsToday = { day: '', count: 0 };

  private get provider(): AiProvider {
    return this.runProvider ?? this.deps.provider;
  }

  constructor(private deps: TrainingDeps) {
    this.store = new SimStore(deps.simStorePath);
    this.now = deps.now ?? (() => new Date());
    this.runId = this.store.latestRunId();
    this.events = this.runId ? this.store.runEvents(this.runId) : [];
  }

  get currentRunId(): string | null {
    return this.runId;
  }

  get providerName(): string {
    return this.provider.name;
  }

  scenario(): Scenario | undefined {
    const v = this.events.find((e) => e.type === 'RunStarted');
    return v?.type === 'RunStarted' ? this.deps.scenarios.find((s) => s.id === v.scenarioId) : undefined;
  }

  view(): SimView | null {
    const sc = this.scenario();
    return sc ? reduceSim(this.events, sc, this.deps.config) : null;
  }

  simEvents(): readonly SimEvent[] {
    return this.events;
  }

  private append(inputs: SimEventInput[]): void {
    if (!this.runId || inputs.length === 0) return;
    const at = this.now().toISOString();
    const events = inputs.map((e) => ({ ...e, id: this.deps.newId(), at }) as SimEvent);
    this.store.append(this.runId, events);
    this.events.push(...events);
  }

  /** 時計を進める。出来事を起こし、ボードを観察し、返事の時間が来た刺激を部署役に渡す */
  tick(): void {
    const sc = this.scenario();
    if (!sc) return;
    const before = this.events.length;
    const r = advance({ scenario: sc, config: this.deps.config, simEvents: this.events, boardEvents: this.deps.board.events(), now: this.now() });
    this.append(r.events);
    this.writeBoard(sc);
    // 再起動などで、渡したまま返事を受け取っていない刺激があれば渡し直す
    const view = reduceSim(this.events, sc, this.deps.config);
    // 終わった回には聞き直さない（終了後の返事は振り返りに混ぜない。API も呼ばない）
    if (!view.ended) for (const [id, st] of view.stimuli) if (st.dispatched && !st.resolved && !this.inflight.has(`${this.runId}:${id}`)) this.ask(id);
    if (this.events.length !== before) this.deps.onChange?.();
    this.explainOnceAfterEnd();
  }

  /** 部署の端末からの記録を、ボードに入れる（同じものは二度入れない。結果はシミュレーターに残す） */
  private writeBoard(sc: Scenario): void {
    const view = reduceSim(this.events, sc, this.deps.config);
    if (view.ended) return;
    for (const w of pendingBoardWrites(view, sc, this.deps.config, reduce(this.deps.board.events()))) {
      // 記録しないと決めたもの（行き先が変わった後の古い判断など）は、記録しなかったことだけを残す
      if (w.skipReason) {
        this.append([{ type: 'BoardWritten', key: w.key, ok: false, error: w.skipReason }]);
        continue;
      }
      let r = this.deps.board.submit(w.envelope);
      // 了承がボードの受け入れ可能数を超える（参加者が手で別の了承を記録していた など）なら、断りとして記録する
      let declinedInstead = false;
      if (r.status === 'warnings' && w.declineInstead) {
        r = this.deps.board.submit(w.declineInstead);
        declinedInstead = r.status === 'accepted';
      }
      // 同じタッグ番号などの警告は、部署で確かめた扱いで理由を付けて記録する（ふつうの端末と同じ手順）
      if (r.status === 'warnings' && w.overrideReason) {
        const codes = (r.warnings ?? []).map((x) => x.code);
        const reasonId = reasonsForWarnings(this.deps.config, codes as never)[0]?.id;
        r = this.deps.board.submit({ ...w.envelope, override: { codes, reasonId, reason: w.overrideReason } });
      }
      // 版番号の食い違い（参加者の操作と重なった）は一時的なので、印を付けずに次の進行でやり直す
      if (r.status === 'conflict') continue;
      const ok = r.status === 'accepted';
      if (!ok) console.warn(`訓練：部署の端末からの記録（${w.key}）を入れられなかった`, r.errors ?? r.status);
      this.append([{ type: 'BoardWritten', key: w.key, ok, ...(ok ? {} : { error: (r.errors ?? [r.status]).join('、').slice(0, 300) }), ...(w.timelineIndex !== undefined ? { timelineIndex: w.timelineIndex } : {}), ...(w.decisionFor ? { decisionFor: w.decisionFor } : {}), ...(declinedInstead ? { declinedInstead } : {}), ...(r.events?.length ? { boardIds: [...new Set(r.events.map((e) => e.subject.id))] } : {}) }]);
    }
  }

  private ask(stimulusId: string): void {
    const sc = this.scenario();
    if (!sc) return;
    const runId = this.runId;
    // 刺激の番号（S-001）は回ごとに同じ番号を使うので、回を含めて覚える（前の回の遅れた返事が、新しい回の待ちを消さないように）
    const key = `${runId}:${stimulusId}`;
    this.inflight.add(key);
    const ctx = buildRoleContext(reduceSim(this.events, sc, this.deps.config), sc, this.deps.config, stimulusId);
    // AI（Claude API）が失敗・時間切れのときは、決まった返事（mock）で補い、そのことを記録する。
    // 訓練は API が止まっても続けられる（補った回数は画面に出す）
    withTimeout(this.provider.proposeForRole(ctx), this.deps.replyTimeoutMs ?? 20_000)
      .then((proposals) => ({ proposals, failed: null as string | null }))
      .catch(async (err) => {
        console.error('部署役の提案を受け取れなかった。決まった返事で補う', err);
        return { proposals: await this.fallback.proposeForRole(ctx), failed: String((err as Error)?.message ?? err) };
      })
      .then(async ({ proposals, failed }) => {
        this.inflight.delete(key);
        if (this.runId !== runId) return; // 回が変わった後の返事は使わない
        let resolved = resolveProposals(this.events, sc, this.deps.config, stimulusId, proposals, this.now());
        // すでに解決済み・終了した回なら何もしない（失敗とも数えない）
        if (resolved.length === 0) return;
        if (failed) this.append([{ type: 'ProviderFailed', stimulusId, error: failed }]);
        // 報告するべき場面で提案がすべて却下されたら、本部に何も届かなくなるので決まった返事で補う（補ったことは記録する）
        // 受け入れの判断（部署）と、到着・知らせの無線（搬送要員）は、必ず何かを返す
        // ただし、返事を考えているあいだに参加者が取り消し・行き先変更・判断の記録をした依頼には、補わない（正しい却下）
        const st = ctx.stimulus;
        const tNow = st.kind === 'transportRequest' ? reduceSim(this.events, sc, this.deps.config).transports[st.transportId] : undefined;
        const stale = st.kind === 'transportRequest' && (!tNow || tNow.cancelled || tNow.toLocationId !== ctx.locationId || tNow.roleAccepted !== null);
        const mustReport = !stale && ['notice', 'patientArrivedByTransport', 'transportRequest'].includes(st.kind);
        if (!failed && mustReport && resolved.every((e) => e.type === 'ProposalResolved' && !e.accepted)) {
          const backup = await this.fallback.proposeForRole(ctx);
          this.append([{ type: 'ProviderFailed', stimulusId, error: '提案がすべて却下されたため、決まった返事で補った' }]);
          resolved = resolveProposals(this.events, sc, this.deps.config, stimulusId, [...proposals, ...backup], this.now());
        }
        this.append(resolved);
        // 受け入れの判断は、到着先の端末から記録する
        this.writeBoard(sc);
        this.deps.onChange?.();
      });
  }

  /** 返事待ちの部署役・説明文がなくなるまで待つ（テスト用） */
  async settle(): Promise<void> {
    while ([...this.inflight].some((k) => k.startsWith(`${this.runId}:`)) || this.explaining) await new Promise((r) => setTimeout(r, 5));
  }

  /** 振り返り。訓練が終わってからだけ作る（実際の状態は訓練中の参加者には見せない） */
  review(): Review | null {
    const sc = this.scenario();
    const view = this.view();
    if (!sc || !view?.ended) return null;
    return buildReview({ scenario: sc, config: this.deps.config, view, boardEvents: this.deps.board.events() });
  }

  private explaining = false;
  /** 回ごとの説明文の生成回数。失敗が続いても API を呼び続けないよう、上限を設ける（費用の枯渇を防ぐ） */
  private explainAttempts = new Map<string, number>();

  /**
   * 振り返りの説明文を AI に書かせる。照合の結果（指摘と根拠）はプログラムが作り、AI は説明だけを書く。
   * 根拠は、こちらが渡した番号だけを残す（AI が作った番号は使わない）
   */
  explain(): { ok: true } | { ok: false; error: string } {
    const review = this.review();
    const sc = this.scenario();
    if (!review || !sc) return { ok: false, error: '訓練が終わってから説明を作る' };
    if (this.explaining) return { ok: true };
    const runId = this.runId;
    const attempts = this.explainAttempts.get(runId ?? '') ?? 0;
    if (attempts >= MAX_EXPLAIN_ATTEMPTS) return { ok: false, error: `この回の説明文は${MAX_EXPLAIN_ATTEMPTS}回まで作れる（照合の結果は説明文がなくても見られる）` };
    this.explainAttempts.set(runId ?? '', attempts + 1);
    this.explaining = true;
    const notes = this.view()!.notes;
    const findings = review.findings.map((f) => ({ id: f.id, title: f.title, detail: f.detail, evidence: f.evidence, participantNote: notes[f.id] }));
    withTimeout(this.provider.explainReview({ scenarioTitle: sc.title, findings }), (this.deps.replyTimeoutMs ?? 20_000) * 3)
      .catch((err) => {
        console.error('振り返りの説明文を受け取れなかった。前の説明文を残す', err);
        return null;
      })
      .then((explanations) => {
        this.explaining = false;
        if (this.runId !== runId) return;
        // 失敗したときは追記しない（前の説明文を残す。照合の結果は説明文がなくても見られる）
        if (!explanations) return this.deps.onChange?.();
        const byId = new Map(findings.map((f) => [f.id, f]));
        // 医療的な判断を含む説明文は捨てる（照合の結果はプログラムが出すので、説明文がなくても見られる）
        const valid = explanations
          .filter((x) => byId.has(x.findingId) && x.text.trim() && !containsMedicalAdvice(x.text, this.deps.config))
          .map((x) => ({ findingId: x.findingId, text: x.text.trim(), evidence: x.evidence.filter((e) => byId.get(x.findingId)!.evidence.includes(e)) }));
        this.recordExplanations(valid);
      });
    return { ok: true };
  }

  control(c: ControlAction): { ok: true } | { ok: false; error: string } {
    const view = this.view();
    const sim = view ? simMsAt(view, this.now()) : 0;
    const last = view?.clock.at(-1);
    const live = view && !view.ended;
    switch (c.action) {
      case 'start': {
        if (!this.deps.scenarios.some((s) => s.id === c.scenarioId)) return { ok: false, error: `シナリオ「${c.scenarioId}」がない` };
        // 一時停止のまま10分以上たった回は、放置されたとみなして新しく始められる（公開デモ）
        const abandoned = !!last && !last.running && this.now().getTime() - last.at > 10 * 60_000;
        if (live && this.deps.exclusiveRuns && !abandoned) {
          const sc = this.scenario()!;
          const speed = last?.speed ?? 1;
          const leftMin = Math.max(1, Math.ceil((sc.durationMinutes * 60_000 - sim) / speed / 60_000));
          return { ok: false, error: `ほかの方が訓練中です（残り約${leftMin}分）。終わってから始めてください` };
        }
        // 1日の上限を超えたら、この回は決まった返事（mock）で動かす
        const day = new Date(this.now().getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
        if (this.runsToday.day !== day) this.runsToday = { day, count: 0 };
        this.runsToday.count++;
        this.runProvider = this.deps.runsPerDay !== undefined && this.runsToday.count > this.deps.runsPerDay ? this.fallback : null;
        if (live) this.append([{ type: 'RunEnded', simMs: sim, reason: 'manual' }]);
        this.runId = this.deps.newId();
        this.events = [];
        this.inflight.clear();
        this.deps.board.switchRun(this.runId);
        this.append([{ type: 'RunStarted', runId: this.runId, scenarioId: c.scenarioId, hospitalId: this.deps.config.id, provider: this.provider.name }]);
        break;
      }
      case 'pause':
        if (!live) return { ok: false, error: '進行中の訓練がない' };
        if (last!.running) this.append([{ type: 'ClockChanged', running: false, speed: last!.speed }]);
        break;
      case 'resume':
        if (!live) return { ok: false, error: '進行中の訓練がない' };
        if (!last!.running) this.append([{ type: 'ClockChanged', running: true, speed: last!.speed }]);
        break;
      case 'speed':
        if (!live) return { ok: false, error: '進行中の訓練がない' };
        if (![1, 2].includes(c.speed)) return { ok: false, error: '速さは1倍か2倍' };
        this.append([{ type: 'ClockChanged', running: last!.running, speed: c.speed }]);
        break;
      case 'end':
        if (!live) return { ok: false, error: '進行中の訓練がない' };
        this.append([{ type: 'RunEnded', simMs: sim, reason: 'manual' }]);
        break;
    }
    this.tick();
    this.deps.onChange?.();
    return { ok: true };
  }

  /** 時間切れ・終了の直後に、振り返りの説明文を作る。失敗したときの自動の作り直しは、回ごとに上限まで */
  private explainOnceAfterEnd(): void {
    const view = this.view();
    if (view?.ended && !view.explanations && !this.explaining && (this.explainAttempts.get(this.runId ?? '') ?? 0) < MAX_AUTO_EXPLAIN_ATTEMPTS) this.explain();
  }

  /** 本部から部署役へ連絡する（無線で伝えたことにあたる） */
  message(to: string, text: string): { ok: true } | { ok: false; error: string } {
    const sc = this.scenario();
    const view = this.view();
    if (!sc || !view || view.ended) return { ok: false, error: '進行中の訓練がない' };
    // 無線でやりとりするのは搬送要員だけ。部署とは、このツールの記録でやりとりする
    if (to !== TRANSPORTER_ROLE || !sc.transporter) return { ok: false, error: '無線で連絡できるのは搬送要員だけです（部署とは、このツールの記録でやりとりします）' };
    if (!text.trim()) return { ok: false, error: '内容を書く' };
    if (text.trim().length > MAX_HQ_MESSAGE_LENGTH) return { ok: false, error: `連絡は${MAX_HQ_MESSAGE_LENGTH}字までにする` };
    // 部署役への連絡は1通ごとに AI を呼ぶので、回ごとの通数に上限を設ける（費用の枯渇を防ぐ）
    if (view.outbox.length >= MAX_HQ_MESSAGES_PER_RUN) return { ok: false, error: `この回の連絡は${MAX_HQ_MESSAGES_PER_RUN}通まで` };
    const sim = simMsAt(view, this.now());
    const n = view.outbox.length + 1;
    this.append([
      { type: 'MessageFromHQ', messageId: `H-${String(n).padStart(3, '0')}`, to, text: text.trim(), simMs: sim },
      { type: 'StimulusQueued', stimulusId: `S-H${n}`, role: to, stimulus: { kind: 'hqMessage', text: text.trim() }, dueSimMs: sim + sc.settings.responseDelaySeconds * 1000 },
    ]);
    this.deps.onChange?.();
    return { ok: true };
  }

  heard(messageId: string): { ok: true } | { ok: false; error: string } {
    const view = this.view();
    if (!view?.inbox.some((m) => m.messageId === messageId)) return { ok: false, error: 'その連絡がない' };
    this.append([{ type: 'MessageHeard', messageId }]);
    this.deps.onChange?.();
    return { ok: true };
  }

  addNote(findingId: string, note: string): { ok: true } | { ok: false; error: string } {
    if (!this.view()?.ended) return { ok: false, error: '訓練が終わってから補足する' };
    if (!this.review()?.findings.some((f) => f.id === findingId)) return { ok: false, error: 'その指摘がない' };
    if (note.trim().length > NOTE_MAX) return { ok: false, error: `補足は${NOTE_MAX}字までにする` };
    this.append([{ type: 'ReviewNoteAdded', findingId, note: note.trim() }]);
    this.deps.onChange?.();
    return { ok: true };
  }

  recordExplanations(explanations: Extract<SimEvent, { type: 'ReviewExplained' }>['explanations']): void {
    this.append([{ type: 'ReviewExplained', provider: this.provider.name, explanations }]);
    this.deps.onChange?.();
  }

  close(): void {
    this.store.close();
  }
}
