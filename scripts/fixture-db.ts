// Builds Cursor's SQLite database for a fixture home from `cursor-db.json`, so the fixture
// stays reviewable text in git while discovery and the reader still see a real database.
//
//   node scripts/fixture-db.ts fixtures/home
//
// The database lands in `<home>/.config/Cursor/User/globalStorage/state.vscdb` (ignored by git).

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

interface CursorFixture {
  cursorDiskKV: { key: string; value: string }[];
  composerHeaders: Record<string, unknown>[];
}

const HEADER_COLUMNS = [
  'composerId',
  'workspaceId',
  'createdAt',
  'lastUpdatedAt',
  'isArchived',
  'isSubagent',
  'recency',
  'checkpointAt',
  'value',
  'subagentTypeName',
] as const;

/** Writes the database and returns its path, or undefined when the home has no Cursor fixture. */
export async function buildCursorDb(home: string): Promise<string | undefined> {
  const source = join(home, 'cursor-db.json');
  if (!existsSync(source)) return undefined;
  const fixture = JSON.parse(readFileSync(source, 'utf8')) as CursorFixture;
  const dir = join(home, '.config', 'Cursor', 'User', 'globalStorage');
  const path = join(dir, 'state.vscdb');
  mkdirSync(dir, { recursive: true });
  rmSync(path, { force: true });
  const emitWarning = process.emitWarning;
  process.emitWarning = (() => undefined) as typeof process.emitWarning;
  const { DatabaseSync } = await import('node:sqlite');
  process.emitWarning = emitWarning;
  const db = new DatabaseSync(path);
  db.exec('create table ItemTable (key text unique on conflict replace, value blob)');
  db.exec('create table cursorDiskKV (key text unique on conflict replace, value blob)');
  db.exec(
    'create table composerHeaders (composerId text primary key, workspaceId text, createdAt integer, lastUpdatedAt integer, isArchived integer, isSubagent integer, recency integer, checkpointAt integer, value text, subagentTypeName text)',
  );
  const kv = db.prepare('insert into cursorDiskKV (key, value) values (?, ?)');
  for (const row of fixture.cursorDiskKV) kv.run(row.key, Buffer.from(row.value, 'utf8'));
  const header = db.prepare(
    `insert into composerHeaders (${HEADER_COLUMNS.join(', ')}) values (${HEADER_COLUMNS.map(() => '?').join(', ')})`,
  );
  for (const row of fixture.composerHeaders) {
    const values = HEADER_COLUMNS.map((c) => {
      const v = row[c];
      if (c === 'value') return v === null || v === undefined ? null : JSON.stringify(v);
      return typeof v === 'number' || typeof v === 'string'
        ? v
        : v === true
          ? 1
          : v === false
            ? 0
            : null;
    });
    header.run(...values);
  }
  db.close();
  return path;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const home = process.argv[2];
  if (!home) {
    console.error('usage: fixture-db.ts <fixture home>');
    process.exitCode = 2;
  } else {
    const path = await buildCursorDb(home);
    console.log(path ? 'Built the Cursor fixture database.' : 'No cursor-db.json in that folder.');
  }
}
