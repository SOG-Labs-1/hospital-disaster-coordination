import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
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
// 複数の病院設定を同時に扱える。記録は病院ごと・実運用／訓練ごとに別ファイルに保存する。

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
}

export interface App {
  server: Server;
  close: () => Promise<void>;
  /** 訓練の進行役（テスト用） */
  training: (hospitalId: string) => TrainingManager | undefined;
}

const MAX_BODY = 1_000_000;

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
        newId: () => ulid(),
        now,
        onChange: () => broadcastSim(config.id),
        board: {
          events: () => ctx.events,
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

  function handleCommand(ctx: ModeContext, body: unknown) {
    // 検証から追記までを同期処理で行うので、同時に届いたコマンドが割り込むことはない
    const result = decide(ctx.state, ctx.config, body as never, {
      mode: ctx.mode,
      now: now().toISOString(),
      newId: () => ulid(),
    });
    if (result.status === 'accepted') {
      ctx.store.append(result.events);
      ctx.events.push(...result.events);
      ctx.state = reduce(ctx.events);
      broadcast(ctx, result.events);
      // 訓練では、参加者の記録をすぐにシミュレーターに見せる（部署役への依頼などが届く）
      if (ctx.mode === 'training') managers.get(ctx.config.id)?.tick();
      return { code: 200, body: { ...result, lastEventId: ctx.state.lastEventId } };
    }
    const code = { conflict: 409, warnings: 422, rejected: 400 }[result.status];
    return { code, body: result };
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

    if (path === '/api/health') return json(res, 200, { ok: true, serverTime: now().toISOString() });
    if (path === '/api/hospitals' && req.method === 'GET')
      return json(res, 200, { hospitals: hospitals.map((h) => ({ id: h.id, name: h.name })), defaultHospitalId: defaultHospitalId(), canCreate: !!options.hospitalCreation });
    if (path === '/api/hospital-template' && req.method === 'GET') {
      if (!options.hospitalCreation) return json(res, 404, { status: 'error', errors: ['病院を作る機能は使えない'] });
      return json(res, 200, options.hospitalCreation.template);
    }
    if (path === '/api/hospitals' && req.method === 'POST') {
      const creation = options.hospitalCreation;
      if (!creation) return json(res, 404, { status: 'error', errors: ['病院を作る機能は使えない'] });
      let body: { draft?: unknown };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { status: 'rejected', errors: ['JSON として読めない'] });
      }
      // id は英数字で自動で付ける（病院名は日本語でもよい）
      const id = `h-${ulid().toLowerCase().slice(-10)}`;
      const r = buildHospitalConfig(body.draft as never, creation.template, id);
      if (!r.ok) return json(res, 400, { status: 'rejected', errors: r.errors });
      if (hospitals.some((h) => h.name === r.config.name)) return json(res, 400, { status: 'rejected', errors: [`同じ名前の病院「${r.config.name}」がすでにある`] });
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
        body = JSON.parse(await readBody(req));
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

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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
  const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  let file = join(dir, safe);
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
  if (!existsSync(file)) return json(res, 404, { status: 'error', errors: ['画面がビルドされていない（npm run build -w web）'] });
  res.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}
