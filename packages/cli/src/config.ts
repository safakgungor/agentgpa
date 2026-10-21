import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// ~/.agentgpa/config.json: the install id, a random id for this machine. The folder is 0700 and
// the file 0600, and nothing else is ever written here.

const Config = z.looseObject({
  version: z.literal(1),
  installId: z.uuid(),
});
export type Config = z.infer<typeof Config>;

export function configDir(env: Record<string, string | undefined> = process.env): string {
  return env.AGENTGPA_CONFIG_DIR ?? join(homedir(), '.agentgpa');
}

/** Reads the config, creating it with a new install id when it is missing or unreadable. */
export function loadConfig(dir: string): Config {
  const path = join(dir, 'config.json');
  if (existsSync(path)) {
    try {
      const parsed = Config.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      // A broken file is replaced below.
    }
  }
  const config: Config = { version: 1, installId: randomUUID() };
  saveConfig(dir, config);
  return config;
}

/** Writes the config, 0600 in its 0700 folder. */
export function saveConfig(dir: string, config: Config): void {
  const path = join(dir, 'config.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
