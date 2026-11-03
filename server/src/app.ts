import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { monotonicFactory } from 'ulid';
import { decide, modes, reduce, type AppState, type DomainEvent, type HospitalConfig, type Mode } from '@hdc/shared';
import { EventStore } from './store';

// HTTP API と Server-Sent Events の配信。
// 状態を変える入口は POST /api/:mode/commands だけで、必ず shared の decide() で検証してから追記する。

interface ModeContext {
  store: EventStore;
  events: DomainEvent[];
  state: AppState;
  clients: Set<ServerResponse>;
}

export interface AppOptions {
  config: HospitalConfig;
  dataDir: string;
  /** ビルド済みの画面（web/dist）。あれば配信する */
  staticDir?: string;
  now?: () => Date;
  heartbeatMs?: number;
}

export interface App {
  server: Server;
  close: () => Promise<void>;
}

const MAX_BODY = 1_000_000;

export function createApp(options: AppOptions): App {
  const { config, dataDir, staticDir } = options;
  const now = options.now ?? (() => new Date());
  const ulid = monotonicFactory();

  const contexts = {} as Record<Mode, ModeContext>;
  for (const mode of modes) {
    const store = EventStore.open(dataDir, mode);
    const events = store.all();
    contexts[mode] = { store, events, state: reduce(events), clients: new Set() };
  }

  const heartbeat = setInterval(() => {
    for (const mode of modes) for (const c of contexts[mode].clients) c.write(': ping\n\n');
  }, options.heartbeatMs ?? 15_000);

  function broadcast(ctx: ModeContext, events: DomainEvent[]) {
    for (const e of events) {
      const chunk = `id: ${e.id}\nevent: domain-event\ndata: ${JSON.stringify(e)}\n\n`;
      for (const c of ctx.clients) c.write(chunk);
    }
  }

  function handleCommand(mode: Mode, body: unknown) {
    const ctx = contexts[mode];
    // 検証から追記までを同期処理で行うので、同時に届いたコマンドが割り込むことはない
    const result = decide(ctx.state, config, body as never, {
      mode,
      now: now().toISOString(),
      newId: () => ulid(),
    });
    if (result.status === 'accepted') {
      ctx.store.append(result.events);
      ctx.events.push(...result.events);
      ctx.state = reduce(ctx.events);
      broadcast(ctx, result.events);
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
    if (path === '/api/config' && req.method === 'GET') return json(res, 200, config);

    const m = path.match(/^\/api\/(live|training)\/(events|state|commands|stream)$/);
    if (m) {
      const mode = m[1] as Mode;
      const ctx = contexts[mode];
      switch (`${req.method} ${m[2]}`) {
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
          const r = handleCommand(mode, body);
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
    close: async () => {
      clearInterval(heartbeat);
      for (const mode of modes) {
        for (const c of contexts[mode].clients) c.end();
        contexts[mode].store.close();
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
