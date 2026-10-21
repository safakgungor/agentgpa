import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCursorDb } from '../../../scripts/fixture-db.ts';

export const FIXTURE_HOME = fileURLToPath(new URL('../../../fixtures/home/', import.meta.url));

/** A throwaway copy of the fixture home with Cursor's database built, so tests never touch real data. */
export async function fixtureHome(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'agentgpa-home-'));
  cpSync(FIXTURE_HOME, home, {
    recursive: true,
    filter: (src) => !src.includes(`${join('home', '.config')}`),
  });
  await buildCursorDb(home);
  return home;
}
