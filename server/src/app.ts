import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { monotonicFactory } from 'ulid';
import { mkdirSync, writeFileSync } from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { buildHospitalConfig, decide, modes, reduce, type AppState, type DomainEvent, type HospitalConfig, type HospitalTemplate, type Mode, type Scenario } from '@hdc/shared';
import type { AiProvider } from './ai';
import { EventStore } from './store';
import { TrainingManager, type ControlAction } from './training/manager';
import { buildSnapshot } from './training/snapshot';

// HTTP API と Server-Sent Events の配信。
// 状態を変える入口は POST /api/h/:hospital/:mode/commands だけで、必ず shared の decide() で検証してから追記する。
// 複数の病院設定を同時に扱える。記録は病院ごと・災害運用／訓練ごとに別ファイルに保存する。

interface ModeContext {
  config: HospitalConfig;
  mode: Mode;
  store: EventStore;
  events: DomainEvent[];
  state: AppState;
  clients: Set<ServerResponse>;
}

export interface AppOptions {
  hospitals: HospitalConfig[];
  /** 記録の保存先。病院ごとにサブフォルダを作る */
  dataDir: string;
  /** 病院を指定せずに開いたときに使う病院。省略時は病院が1つだけのときにその病院 */
  defaultHospitalId?: string;
  /** ビルド済みの画面（web/dist）。あれば配信する */
  staticDir?: string;
  now?: () => Date;
  heartbeatMs?: number;
  /** 訓練モード（シナリオと部署役）。省略すると訓練の進行は使えない（記録の入力はできる） */
  training?: { scenarios: Scenario[]; provider: AiProvider; tickMs?: number; replyTimeoutMs?: number };
  /** 画面から病院を作る（標準の値と、作った病院設定の保存先）。省略すると作れない */
  hospitalCreation?: { template: HospitalTemplate; dir: string };
  /**
   * 映像の録画専用に起動したサーバーであることの目印（/api/health で返す）。
   * デモ用データのスクリプトは、この目印があるサーバーにだけ書き込む（通常の記録に架空のデモ用データを混ぜない）
   */
  demoCapture?: boolean;
  /**
   * 開いてよいホスト名（Host ヘッダー）。localhost・IP アドレス・*.local は常に許す。
   * それ以外の名前（院内の DNS 名など）で開くときに指定する（DNS リバインディング対策）
   */
  allowedHosts?: string[];
  /**
   * インターネットに公開する審査用のデモ（PUBLIC_DEMO=1）。架空のデータだけを使い、記録は定期的に最初に戻す。
   * 画面に案内を出し、書き込みの頻度と、作れる病院の数を絞り、訓練は同時に1回だけ・1日の回数に上限を付ける
   */
  publicDemo?: { maxCreatedHospitals: number; writesPerMinute: number; trainingRunsPerDay: number };
}

export interface App {
  server: Server;
  /** 最後に記録を書き込んだ時刻（公開デモで、しばらく操作がなければ最初に戻すため）。まだなければ null */
  lastWriteAt: () => number | null;
  close: () => Promise<void>;
  /** 訓練の進行役（テスト用） */
  training: (hospitalId: string) => TrainingManager | undefined;
}

const MAX_BODY = 1_000_000;
/** 画面から作れる病院の数（作りすぎて開くファイルが尽きないように） */
const MAX_CREATED_HOSPITALS = 20;
/** 全端末への配信（SSE）の同時接続の上限（病院・モードごと）。つなぎっぱなしで資源を使い切られないように */
const MAX_STREAM_CLIENTS = 200;

/** 病院名の比べ方：全角・半角の違い、見えない文字（ゼロ幅など）、空白を無視する（そっくりな名前の病院を作らせない） */
export function normalizeHospitalName(name: string): string {
  return name.normalize('NFKC').replace(/[\s\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '').toLowerCase();
}

/** Host ヘッダーが、この院内のサーバーを指しているか（攻撃者のドメインを院内の IP に向ける DNS リバインディングを防ぐ） */
export function isAllowedHost(host: string | undefined, allowed: readonly string[] = []): boolean {
  if (!host) return false;
  const name = (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')).toLowerCase();
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
    /^\[[0-9a-f:.]+\]$/.test(name) ||
    allowed.some((a) => a.toLowerCase() === name)
  );
}

/**
 * 書き込み（POST）を受けてよいか。ほかのサイトのページから送られた依頼（CSRF）を断る。
 * - 本文は JSON だけ（text/plain などの「事前確認なしに送れる形」を断る）
 * - Origin ヘッダーがあれば、開いているサーバーと同じであること
 */
function writeRefusal(req: IncomingMessage): { code: number; error: string } | null {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) return { code: 415, error: '本文は JSON（application/json）で送る' };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { code: 403, error: 'ほかのサイトからの書き込みは受け付けない' };
    }
    if (originHost.toLowerCase() !== (req.headers.host ?? '').toLowerCase()) return { code: 403, error: 'ほかのサイトからの書き込みは受け付けない' };
  }
  return null;
}

export function createApp(options: AppOptions): App {
  const { dataDir, staticDir } = options;
  // 画面から作った病院を、止めずに足せるように持つ
  const hospitals = [...options.hospitals];
  const now = options.now ?? (() => new Date());
  const ulid = monotonicFactory();
  if (hospitals.length === 0) throw new Error('病院設定が1つもない');
  if (options.defaultHospitalId && !hospitals.some((h) => h.id === options.defaultHospitalId)) throw new Error(`既定の病院「${options.defaultHospitalId}」の設定がない`);
  /** 病院を指定せずに開いたときの病院。指定がなければ、病院が1つだけのときにその病院 */
  const defaultHospitalId = () => options.defaultHospitalId ?? (hospitals.length === 1 ? hospitals[0]!.id : null);

  const contexts = new Map<string, ModeContext>();
  const key = (hospitalId: string, mode: Mode) => `${hospitalId}:${mode}`;
  function addContexts(config: HospitalConfig) {
    for (const mode of modes) {
      const store = EventStore.open(join(dataDir, config.id), mode);
      const events = store.all();
      contexts.set(key(config.id, mode), { config, mode, store, events, state: reduce(events), clients: new Set() });
    }
  }
  for (const config of hospitals) addContexts(config);

  // 訓練：病院ごとに進行役を置く。進行役はボードを読むだけで、書き込まない
  const managers = new Map<string, TrainingManager>();
  const simClients = new Map<string, Set<ServerResponse>>();
  function snapshotOf(hospitalId: string) {
    const m = managers.get(hospitalId)!;
    const config = hospitals.find((h) => h.id === hospitalId)!;
    return buildSnapshot({ config, scenarios: options.training!.scenarios.filter((s) => s.hospital === hospitalId), view: m.view(), scenario: m.scenario(), provider: m.providerName, now: now(), review: m.review() });
  }
  function broadcastSim(hospitalId: string) {
    const clients = simClients.get(hospitalId);
    if (!clients?.size) return;
    const chunk = `event: sim\ndata: ${JSON.stringify(snapshotOf(hospitalId))}\n\n`;
    for (const c of clients) c.write(chunk);
  }
  if (options.training) {
    for (const config of hospitals) {
      const scenarios = options.training.scenarios.filter((s) => s.hospital === config.id);
      if (scenarios.length === 0) continue;
      const ctx = contexts.get(key(config.id, 'training'))!;
      const manager = new TrainingManager({
        config,
        scenarios,
        simStorePath: join(dataDir, config.id, 'training-sim.sqlite'),
        provider: options.training.provider,
        replyTimeoutMs: options.training.replyTimeoutMs,
        ...(options.publicDemo ? { exclusiveRuns: true, runsPerDay: options.publicDemo.trainingRunsPerDay } : {}),
        newId: () => ulid(),
        now,
        onChange: () => broadcastSim(config.id),
        board: {
          events: () => ctx.events,
          // 部署の端末からの記録（訓練）。参加者の操作と同じ検証を通す。進行役の中から呼ぶので、進行役を進め直さない
          submit: (envelope) => handleCommand(ctx, envelope, { fromSimulator: true }).body as never,
          // 訓練の回ごとに、ボード（参加者の記録）を別のファイルに切り替える
          switchRun: (runId) => {
            switchTrainingBoard(ctx, runId);
            for (const c of ctx.clients) c.write('event: reset\ndata: {}\n\n');
          },
        },
      });
      if (manager.currentRunId) switchTrainingBoard(ctx, manager.currentRunId);
      managers.set(config.id, manager);
      simClients.set(config.id, new Set());
    }
  }
  function switchTrainingBoard(ctx: ModeContext, runId: string | null) {
    ctx.store.close();
    if (runId) {
      const dir = join(dataDir, ctx.config.id, 'training');
      mkdirSync(dir, { recursive: true });
      ctx.store = new EventStore(join(dir, `${runId}.sqlite`), 'training');
    } else {
      ctx.store = EventStore.open(join(dataDir, ctx.config.id), 'training');
    }
    ctx.events = ctx.store.all();
    ctx.state = reduce(ctx.events);
  }
  const ticker = setInterval(() => {
    for (const m of managers.values()) m.tick();
  }, options.training?.tickMs ?? 500);

  const heartbeat = setInterval(() => {
    for (const ctx of contexts.values()) for (const c of ctx.clients) c.write(': ping\n\n');
    for (const set of simClients.values()) for (const c of set) c.write(': ping\n\n');
  }, options.heartbeatMs ?? 15_000);

  function broadcast(ctx: ModeContext, events: DomainEvent[]) {
    for (const e of events) {
      const chunk = `id: ${e.id}\nevent: domain-event\ndata: ${JSON.stringify(e)}\n\n`;
      for (const c of ctx.clients) c.write(chunk);
    }
  }

  function handleCommand(ctx: ModeContext, body: unknown, opts: { fromSimulator?: boolean } = {}) {
    // 検証から追記までを同期処理で行うので、同時に届いたコマンドが割り込むことはない
    const result = decide(ctx.state, ctx.config, body as never, {
      mode: ctx.mode,
      now: now().toISOString(),
      newId: () => ulid(),
    });
    if (result.status === 'accepted') {
      // 保存する前に集計できることを確かめる。記録は追記のみで消せないので、集計を壊す記録を1件でも残すと、
      // 以後すべての端末とサーバーの起動が止まる
      let next: AppState;
      try {
        next = reduce([...ctx.events, ...result.events]);
      } catch (err) {
        console.error('集計できない記録になるため、保存しなかった', err);
        return { code: 400, body: { status: 'rejected', errors: ['この内容は記録できない（集計できない形になる）'] } };
      }
      ctx.store.append(result.events);
      ctx.events.push(...result.events);
      ctx.state = next;
      broadcast(ctx, result.events);
      // 訓練では、参加者の記録をすぐにシミュレーターに見せる（部署役への依頼などが届く）
      if (ctx.mode === 'training' && !opts.fromSimulator) managers.get(ctx.config.id)?.tick();
      return { code: 200, body: { ...result, lastEventId: ctx.state.lastEventId } };
    }
    const code = { conflict: 409, warnings: 422, rejected: 400 }[result.status];
    return { code, body: result };
  }

  let lastWriteAt: number | null = null;
  // 書き込みの頻度の上限（公開デモ）：送り元ごとに1分あたりの回数を数える
  const writeCounts = new Map<string, { minute: number; count: number }>();
  function tooManyWrites(req: IncomingMessage): boolean {
    if (!options.publicDemo) return false;
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim();
    const client = forwarded || req.socket.remoteAddress || 'unknown';
    const minute = Math.floor(Date.now() / 60_000);
    const c = writeCounts.get(client);
    if (!c || c.minute !== minute) {
      if (writeCounts.size > 10_000) writeCounts.clear();
      writeCounts.set(client, { minute, count: 1 });
      return false;
    }
    c.count++;
    return c.count > options.publicDemo.writesPerMinute;
  }

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, 500, { status: 'error', errors: ['サーバー内部のエラー'] });
      else res.end();
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!isAllowedHost(req.headers.host, options.allowedHosts)) return json(res, 421, { status: 'error', errors: ['このホスト名では開けない（ALLOWED_HOSTS に追加する）'] });
    if (options.publicDemo) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (req.method === 'POST') {
      const refusal = writeRefusal(req);
      if (refusal) return json(res, refusal.code, { status: 'rejected', errors: [refusal.error] });
      if (tooManyWrites(req)) return json(res, 429, { status: 'rejected', errors: ['書き込みが多すぎます。少し待ってから操作してください'] });
      // 公開デモでは、外から（Cloud Run の中継を通って）来た書き込みだけを数える。起動時のデモ用データの投入は数えない
      if (!options.publicDemo || req.headers['x-forwarded-for']) lastWriteAt = Date.now();
    }

    if (path === '/api/health') return json(res, 200, { ok: true, serverTime: now().toISOString(), ...(options.demoCapture ? { demoCapture: true } : {}) });
    if (path === '/api/hospitals' && req.method === 'GET')
      return json(res, 200, {
        hospitals: hospitals.map((h) => ({ id: h.id, name: h.name })),
        defaultHospitalId: defaultHospitalId(),
        canCreate: !!options.hospitalCreation,
        ...(options.publicDemo ? { publicDemo: true } : {}),
      });
    if (path === '/api/hospital-template' && req.method === 'GET') {
      if (!options.hospitalCreation) return json(res, 404, { status: 'error', errors: ['病院を作る機能は使えない'] });
      return json(res, 200, options.hospitalCreation.template);
    }
    if (path === '/api/hospitals' && req.method === 'POST') {
      const creation = options.hospitalCreation;
      if (!creation) return json(res, 404, { status: 'error', errors: ['病院を作る機能は使えない'] });
      let body: { draft?: unknown };
      try {
        body = JSON.parse(await readBody(req)) ?? {};
      } catch {
        return json(res, 400, { status: 'rejected', errors: ['JSON として読めない'] });
      }
      // id は英数字で自動で付ける（病院名は日本語でもよい）
      const id = `h-${ulid().toLowerCase().slice(-10)}`;
      const r = buildHospitalConfig(body.draft as never, creation.template, id);
      if (!r.ok) return json(res, 400, { status: 'rejected', errors: r.errors });
      const maxCreated = options.publicDemo?.maxCreatedHospitals ?? MAX_CREATED_HOSPITALS;
      if (hospitals.length - options.hospitals.length >= maxCreated) return json(res, 400, { status: 'rejected', errors: [`画面から作れる病院は${maxCreated}件まで${options.publicDemo ? '（公開デモは、しばらく操作がないと最初の状態に戻ります）' : ''}`] });
      if (hospitals.some((h) => normalizeHospitalName(h.name) === normalizeHospitalName(r.config.name))) return json(res, 400, { status: 'rejected', errors: [`同じ名前の病院「${r.config.name}」がすでにある`] });
      mkdirSync(creation.dir, { recursive: true });
      // 作った病院設定はファイルとして残す（記録の保存先と同じく git の管理外）。次の起動でも読み込む
      writeFileSync(join(creation.dir, `${id}.yaml`), `# 画面から作った病院設定（${now().toISOString()}）\n${stringifyYaml(r.config)}`, { flag: 'wx' });
      hospitals.push(r.config);
      addContexts(r.config);
      return json(res, 200, { status: 'accepted', hospital: { id, name: r.config.name } });
    }

    const c = path.match(/^\/api\/h\/([a-z0-9-]+)\/config$/);
    if (c && req.method === 'GET') {
      const config = hospitals.find((h) => h.id === c[1]);
      return config ? json(res, 200, config) : json(res, 404, { status: 'error', errors: [`病院「${c[1]}」の設定がない`] });
    }

    const t = path.match(/^\/api\/h\/([a-z0-9-]+)\/training\/sim(?:\/(stream|control|message|heard|note|explain))?$/);
    if (t) {
      const manager = managers.get(t[1]!);
      if (!manager) return json(res, 404, { status: 'error', errors: ['この病院には訓練のシナリオがない'] });
      const action = t[2] ?? 'snapshot';
      if (req.method === 'GET' && action === 'snapshot') return json(res, 200, snapshotOf(t[1]!));
      if (req.method === 'GET' && action === 'stream') {
        if (simClients.get(t[1]!)!.size >= MAX_STREAM_CLIENTS) return json(res, 503, { status: 'error', errors: ['接続が多すぎます。少し待ってから開き直してください'] });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
        res.write(`retry: 2000\nevent: sim\ndata: ${JSON.stringify(snapshotOf(t[1]!))}\n\n`);
        const set = simClients.get(t[1]!)!;
        set.add(res);
        req.on('close', () => set.delete(res));
        return;
      }
      if (req.method !== 'POST') return json(res, 405, { status: 'error', errors: ['この操作はできない'] });
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) ?? {};
      } catch {
        return json(res, 400, { status: 'rejected', errors: ['JSON として読めない'] });
      }
      const r =
        action === 'control'
          ? manager.control(body as ControlAction)
          : action === 'message'
            ? manager.message(String(body.to ?? ''), String(body.text ?? ''))
            : action === 'heard'
              ? manager.heard(String(body.messageId ?? ''))
              : action === 'explain'
                ? manager.explain()
                : manager.addNote(String(body.findingId ?? ''), String(body.note ?? ''));
      return r.ok ? json(res, 200, snapshotOf(t[1]!)) : json(res, 400, { status: 'rejected', errors: [r.error] });
    }

    const m = path.match(/^\/api\/h\/([a-z0-9-]+)\/(live|training)\/(events|state|commands|stream)$/);
    if (m) {
      const ctx = contexts.get(key(m[1]!, m[2] as Mode));
      if (!ctx) return json(res, 404, { status: 'error', errors: [`病院「${m[1]}」の設定がない`] });
      const mode = ctx.mode;
      switch (`${req.method} ${m[3]}`) {
        case 'GET events': {
          const after = url.searchParams.get('after');
          const idx = after ? ctx.events.findIndex((e) => e.id === after) : -1;
          if (after && idx < 0) return json(res, 404, { status: 'error', errors: [`記録「${after}」が見つからない`] });
          return json(res, 200, { mode, events: ctx.events.slice(idx + 1), lastEventId: ctx.state.lastEventId });
        }
        case 'GET state': {
          const { eventMeta: _omit, ...state } = ctx.state;
          return json(res, 200, { mode, state });
        }
        case 'POST commands': {
          let body: unknown;
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return json(res, 400, { status: 'rejected', errors: ['JSON として読めない'] });
          }
          const r = handleCommand(ctx, body);
          return json(res, r.code, r.body);
        }
        case 'GET stream': {
          if (ctx.clients.size >= MAX_STREAM_CLIENTS) return json(res, 503, { status: 'error', errors: ['接続が多すぎます。少し待ってから開き直してください'] });
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });
          res.write(`retry: 2000\nevent: ready\ndata: ${JSON.stringify({ mode, lastEventId: ctx.state.lastEventId })}\n\n`);
          ctx.clients.add(res);
          req.on('close', () => ctx.clients.delete(res));
          return;
        }
      }
      return json(res, 405, { status: 'error', errors: ['この操作はできない'] });
    }

    if (path.startsWith('/api/')) return json(res, 404, { status: 'error', errors: ['見つからない'] });
    if (staticDir && req.method === 'GET') return serveStatic(staticDir, path, res);
    json(res, 404, { status: 'error', errors: ['見つからない'] });
  }

  return {
    server,
    lastWriteAt: () => lastWriteAt,
    training: (hospitalId) => managers.get(hospitalId),
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(ticker);
      for (const m of managers.values()) {
        await m.settle();
        m.close();
      }
      for (const set of simClients.values()) for (const c of set) c.end();
      for (const ctx of contexts.values()) {
        for (const c of ctx.clients) c.end();
        ctx.store.close();
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** すべての応答に付ける：中身の種類を推測させない、ほかのサイトの枠の中に表示させない（クリックジャッキング対策） */
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(dir: string, path: string, res: ServerResponse) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return json(res, 400, { status: 'error', errors: ['URL を読めない'] });
  }
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let file = join(dir, safe);
  if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
  if (!existsSync(file)) return json(res, 404, { status: 'error', errors: ['画面がビルドされていない（npm run build -w web）'] });
  res.writeHead(200, { ...securityHeaders, 'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}
