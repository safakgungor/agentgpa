import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configDir, loadConfig } from '../src/config.ts';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'agentgpa-config-')), '.agentgpa');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('the config file', () => {
  it('is created with a random install id, readable only by its owner', () => {
    const dir = fresh();
    const config = loadConfig(dir);
    expect(config.version).toBe(1);
    expect(config.installId).toMatch(UUID);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual(config);
  });

  it('keeps the same install id across runs', () => {
    const dir = fresh();
    expect(loadConfig(dir).installId).toBe(loadConfig(dir).installId);
  });

  it('replaces a broken or foreign file instead of failing', () => {
    for (const content of ['{ not json', '{"version": 2, "installId": "x"}', '[]']) {
      const dir = fresh();
      loadConfig(dir);
      writeFileSync(join(dir, 'config.json'), content);
      expect(loadConfig(dir).installId).toMatch(UUID);
    }
  });

  it('lives in AGENTGPA_CONFIG_DIR when it is set', () => {
    expect(configDir({ AGENTGPA_CONFIG_DIR: '/tmp/somewhere' })).toBe('/tmp/somewhere');
    expect(configDir({})).toMatch(/\.agentgpa$/);
  });
});
