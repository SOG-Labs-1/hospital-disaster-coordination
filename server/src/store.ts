import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainEventSchema, type DomainEvent, type Mode } from '@hdc/shared';

// イベントの追記保存。実運用と訓練は別ファイル。UPDATE と DELETE はトリガーで禁止する。

export function storePath(dataDir: string, mode: Mode): string {
  return join(dataDir, `${mode}.sqlite`);
}

export class EventStore {
  private db: DatabaseSync;

  constructor(
    readonly path: string,
    readonly mode: Mode,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_subject ON events (subject_kind, subject_id);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, '記録は追記のみ（更新は禁止）'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, '記録は追記のみ（削除は禁止）'); END;
    `);
  }

  static open(dataDir: string, mode: Mode): EventStore {
    mkdirSync(dataDir, { recursive: true });
    return new EventStore(storePath(dataDir, mode), mode);
  }

  append(events: DomainEvent[]): void {
    const insert = this.db.prepare(
      'INSERT INTO events (id, type, subject_kind, subject_id, mode, recorded_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const e of events) {
        if (e.mode !== this.mode) throw new Error(`${e.mode} の記録を ${this.mode} の保存先に書こうとした`);
        insert.run(e.id, e.type, e.subject.kind, e.subject.id, e.mode, e.recordedAt, JSON.stringify(e));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  all(): DomainEvent[] {
    const rows = this.db.prepare('SELECT body FROM events ORDER BY seq').all() as { body: string }[];
    return rows.map((r) => DomainEventSchema.parse(JSON.parse(r.body)));
  }

  close(): void {
    this.db.close();
  }
}
