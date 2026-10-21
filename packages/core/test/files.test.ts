import { describe, expect, it } from 'vitest';
import {
  isSensitiveFile,
  LANG_CATEGORIES,
  langCategoryOf,
  shellFlags,
  TOOL_FLAGS,
  testOutcome,
  touchesSensitiveFile,
} from '../src/index.ts';

const cat = (name: string) => LANG_CATEGORIES.indexOf(name as never);

describe('file facts from paths', () => {
  it('sorts edited files into language categories by extension only', () => {
    expect(langCategoryOf('src/app.ts')).toBe(cat('typescript'));
    expect(langCategoryOf('C:\\work\\Main.PY')).toBe(cat('python'));
    expect(langCategoryOf('infra/Dockerfile')).toBe(cat('infra'));
    expect(langCategoryOf('README.md')).toBe(cat('docs'));
    expect(langCategoryOf('Makefile')).toBe(-1);
    expect(langCategoryOf('.env')).toBe(-1);
  });

  it('knows env, key and credential files, and leaves templates alone', () => {
    for (const path of [
      '.env',
      'app/.env.local',
      '~/.ssh/id_rsa',
      'certs/server.pem',
      '~/.aws/credentials',
      '.npmrc',
      'gcp/service-account-prod.json',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
    for (const path of [
      '.env.example',
      '~/.ssh/id_rsa.pub',
      'notes.txt',
      'environment.ts',
      'src/keys.ts',
    ]) {
      expect(isSensitiveFile(path), path).toBe(false);
    }
  });

  it('spots them in shell commands', () => {
    expect(touchesSensitiveFile('cat .env')).toBe(true);
    expect(touchesSensitiveFile('source ~/.aws/credentials && aws s3 ls')).toBe(true);
    expect(touchesSensitiveFile('echo env | grep KEY')).toBe(false);
    expect(touchesSensitiveFile('ls -la')).toBe(false);
  });
});

describe('shell flags and test results', () => {
  it('spots installs and lint runs', () => {
    for (const command of [
      'pnpm add zod',
      'pip install -r requirements.txt',
      'brew install jq',
      'cargo add serde',
      'npm ci',
    ]) {
      expect(shellFlags(command) & TOOL_FLAGS.install, command).toBe(TOOL_FLAGS.install);
    }
    for (const command of [
      'npx eslint .',
      'biome check --write',
      'ruff check src',
      'cargo clippy',
      'pnpm run format',
    ]) {
      expect(shellFlags(command) & TOOL_FLAGS.lint, command).toBe(TOOL_FLAGS.lint);
    }
    expect(shellFlags('npm run dev')).toBe(0);
    expect(shellFlags('echo install the linter')).toBe(0);
  });

  it('reads the result of a test run from its summary', () => {
    expect(testOutcome(' Tests  3 failed | 9 passed (12)')).toBe('fail');
    expect(testOutcome('Tests:       10 passed, 10 total')).toBe('pass');
    expect(testOutcome('===== 2 failed, 5 passed in 1.20s =====')).toBe('fail');
    expect(testOutcome('ok  \texample.com/date\t0.31s')).toBe('pass');
    expect(testOutcome('test result: ok. 4 passed; 0 failed')).toBe('pass');
    expect(testOutcome('Ran 3 tests in 0.002s\n\nOK')).toBe('pass');
    expect(testOutcome('FAILED (failures=1)')).toBe('fail');
    expect(testOutcome('Tests: 0 failed, 3 passed')).toBe('pass');
    expect(testOutcome('compiling...')).toBeUndefined();
  });
});
