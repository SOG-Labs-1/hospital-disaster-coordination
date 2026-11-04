import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SimEvent } from '@hdc/shared';

// シミュレーターの記録（訓練の回ごと）。参加者のボードとは別のファイルで、追記のみ。
export class SimStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sim_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sim_events_run ON sim_events (run_id);
      CREATE TRIGGER IF NOT EXISTS sim_no_update BEFORE UPDATE ON sim_events
        BEGIN SELECT RAISE(ABORT, '記録は追記のみ（更新は禁止）'); END;
      CREATE TRIGGER IF NOT EXISTS sim_no_delete BEFORE DELETE ON sim_events
        BEGIN SELECT RAISE(ABORT, '記録は追記のみ（削除は禁止）'); END;
    `);
  }

  append(runId: string, events: SimEvent[]): void {
    const insert = this.db.prepare('INSERT INTO sim_events (run_id, id, type, at, body) VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const e of events) insert.run(runId, e.id, e.type, e.at, JSON.stringify(e));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** いちばん新しい回の番号 */
  latestRunId(): string | null {
    const row = this.db.prepare("SELECT run_id FROM sim_events WHERE type = 'RunStarted' ORDER BY seq DESC LIMIT 1").get() as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }

  runEvents(runId: string): SimEvent[] {
    const rows = this.db.prepare('SELECT body FROM sim_events WHERE run_id = ? ORDER BY seq').all(runId) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as SimEvent);
  }

  close(): void {
    this.db.close();
  }
}
