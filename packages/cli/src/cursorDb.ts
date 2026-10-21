import type { createCursorParser } from '@agentgpa/core';

// Cursor's database is opened read-only through Node's built-in SQLite and never copied.

type CursorParser = ReturnType<typeof createCursorParser>;

interface Row {
  key: string;
  value: Uint8Array | string | null;
}

type DatabaseSyncType = typeof import('node:sqlite').DatabaseSync;

let DatabaseSync: DatabaseSyncType | undefined;

/** Loads node:sqlite once, without letting its experimental warning reach the terminal. */
async function sqlite(): Promise<DatabaseSyncType | undefined> {
  if (DatabaseSync) return DatabaseSync;
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite/i.test(text)) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    DatabaseSync = (await import('node:sqlite')).DatabaseSync;
  } catch {
    DatabaseSync = undefined;
  } finally {
    process.emitWarning = emitWarning;
  }
  return DatabaseSync;
}

function text(value: Uint8Array | string | null): string {
  if (value === null) return '';
  return typeof value === 'string'
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
}

export type CursorDbResult =
  | { readable: true }
  | { readable: false; reason: 'sqlite unavailable' | 'cannot open' | 'no chat tables' };

/** Feeds the chat records of one `state.vscdb` to the parser. */
export async function readCursorDatabase(
  path: string,
  parser: CursorParser,
): Promise<CursorDbResult> {
  const Database = await sqlite();
  if (!Database) return { readable: false, reason: 'sqlite unavailable' };
  let db: InstanceType<DatabaseSyncType>;
  try {
    db = new Database(path, { readOnly: true });
  } catch {
    return { readable: false, reason: 'cannot open' };
  }
  try {
    const tables = new Set(
      (
        db.prepare("select name from sqlite_master where type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    if (!tables.has('cursorDiskKV')) return { readable: false, reason: 'no chat tables' };
    // Key ranges use the table's key index; ';' is the character after ':'.
    const range = db.prepare('select key, value from cursorDiskKV where key >= ? and key < ?');
    for (const row of range.iterate('composerData:', 'composerData;') as Iterable<Row>) {
      const id = row.key.slice('composerData:'.length);
      parser.composer(id, text(row.value));
    }
    if (tables.has('composerHeaders')) {
      const headers = db.prepare(
        'select composerId, createdAt, lastUpdatedAt, value from composerHeaders',
      );
      for (const row of headers.iterate() as Iterable<{
        composerId: string;
        createdAt: number | null;
        lastUpdatedAt: number | null;
        value: string | null;
      }>) {
        let value: Record<string, unknown> = {};
        try {
          value = JSON.parse(row.value ?? '{}') as Record<string, unknown>;
        } catch {
          // A broken header still gives the chat its times.
        }
        parser.composer(
          row.composerId,
          JSON.stringify({
            ...value,
            createdAt: row.createdAt ?? undefined,
            lastUpdatedAt: row.lastUpdatedAt ?? undefined,
          }),
        );
      }
    }
    for (const row of range.iterate('bubbleId:', 'bubbleId;') as Iterable<Row>) {
      const [, composerId, bubbleId] = row.key.split(':');
      if (composerId && bubbleId) parser.bubble(composerId, bubbleId, text(row.value));
    }
    return { readable: true };
  } finally {
    db.close();
  }
}
