// Turns real transcripts into fixtures: same structure, timing and lengths, all text replaced
// with synthetic words (scrub.ts). Nothing is written unless the leak check passes, and the
// script prints counts only, never transcript text.
//
//   node scripts/make-fixture.ts claude <session.jsonl>[@from:to] ... --out fixtures/home [--subagents 2] [--workflows 1] [--agent-lines 60]
//   node scripts/make-fixture.ts codex <rollout.jsonl> --out fixtures/home [--lines 1:400]
//   node scripts/make-fixture.ts cursor --db <state.vscdb> --composer <id> [--no-bubbles] [--transcript <file>] --out fixtures/home
//
// Every run uses a new random key, so ids and synthetic words differ between runs; run all
// the files of one fixture set in one invocation (several inputs are allowed) to keep their
// links. Times move forward by --shift-days (default 364: whole weeks keep weekdays and hours).
// This machine's user and host names are replaced whole wherever they appear in free text;
// --names <file> adds more, one per line (a GitHub handle, a real name), so they never sit
// in a shell history either.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Scrubber } from './scrub.ts';

interface Output {
  path: string;
  text: string;
}

function lines(file: string, window?: [number, number]): string[] {
  const all = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return window ? all.slice(window[0] - 1, window[1]) : all;
}

function scrubLines(
  scrubber: Scrubber,
  source: string[],
): { text: string; kept: number; skipped: number } {
  const out: string[] = [];
  let skipped = 0;
  for (const line of source) {
    try {
      out.push(JSON.stringify(scrubber.value(JSON.parse(line))));
    } catch {
      skipped++;
    }
  }
  return { text: out.length ? `${out.join('\n')}\n` : '', kept: out.length, skipped };
}

function window(value: string | undefined): [number, number] | undefined {
  const m = value ? /^(\d+):(\d+)$/.exec(value) : null;
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

function smallestFirst(dir: string, test: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(test)
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(a).size - statSync(b).size);
}

function claude(
  scrubber: Scrubber,
  input: string,
  out: string,
  args: Record<string, string | boolean | undefined>,
): Output[] {
  const outputs: Output[] = [];
  // `file.jsonl@100:200` keeps only that window of the main file.
  const [file, fileWindow] = input.split('@') as [string, string | undefined];
  const sessionId = basename(file, '.jsonl');
  const project = `-home-dev-${scrubber.path(dirname(file)).split('/').at(-1)}`;
  const newSession = scrubber.id(sessionId);
  const base = join(out, '.claude', 'projects', project);
  const main = scrubLines(
    scrubber,
    lines(file, window(fileWindow ?? (args.lines as string | undefined))),
  );
  outputs.push({ path: join(base, `${newSession}.jsonl`), text: main.text });
  const agentLines = Number(args['agent-lines'] ?? 60);
  const sessionDir = join(dirname(file), sessionId);
  for (const agent of smallestFirst(
    join(sessionDir, 'subagents'),
    (n) => n.startsWith('agent-') && n.endsWith('.jsonl'),
  ).slice(0, Number(args.subagents ?? 0))) {
    const id = scrubber.id(`agent-${basename(agent, '.jsonl').slice('agent-'.length)}`);
    const text = scrubLines(scrubber, lines(agent, [1, agentLines])).text;
    outputs.push({ path: join(base, newSession, 'subagents', `${id}.jsonl`), text });
    const meta = agent.replace(/\.jsonl$/, '.meta.json');
    if (existsSync(meta)) {
      outputs.push({
        path: join(base, newSession, 'subagents', `${id}.meta.json`),
        text: `${JSON.stringify(scrubber.value(JSON.parse(readFileSync(meta, 'utf8'))))}\n`,
      });
    }
  }
  const workflows = join(sessionDir, 'subagents', 'workflows');
  const wfDirs = existsSync(workflows)
    ? readdirSync(workflows)
        .filter((d) => d.startsWith('wf_'))
        .sort()
    : [];
  for (const wf of wfDirs.slice(0, Number(args.workflows ?? 0))) {
    const newWf = `wf_${scrubber.id(wf.slice(3)).slice(0, wf.length - 3)}`;
    for (const agent of smallestFirst(
      join(workflows, wf),
      (n) => n.startsWith('agent-') && n.endsWith('.jsonl'),
    ).slice(0, 1)) {
      const id = scrubber.id(`agent-${basename(agent, '.jsonl').slice('agent-'.length)}`);
      outputs.push({
        path: join(base, newSession, 'subagents', 'workflows', newWf, `${id}.jsonl`),
        text: scrubLines(scrubber, lines(agent, [1, agentLines])).text,
      });
    }
    // The workflow journal sits next to its agents; one is kept so discovery learns to skip it.
    for (const journal of smallestFirst(
      join(workflows, wf),
      (n) => !n.startsWith('agent-') && n.endsWith('.jsonl'),
    ).slice(0, 1)) {
      outputs.push({
        path: join(base, newSession, 'subagents', 'workflows', newWf, 'journal.jsonl'),
        text: scrubLines(scrubber, lines(journal, [1, 4])).text,
      });
    }
  }
  return outputs;
}

function codex(
  scrubber: Scrubber,
  file: string,
  out: string,
  args: Record<string, string | boolean | undefined>,
): Output[] {
  const scrubbed = scrubLines(scrubber, lines(file, window(args.lines as string | undefined)));
  const first = scrubbed.text.split('\n')[0];
  const ts = first
    ? ((JSON.parse(first) as { timestamp?: string }).timestamp ?? '2027-01-01T00:00:00.000Z')
    : '2027-01-01T00:00:00.000Z';
  const uuid =
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] ??
    basename(file);
  const [date, time] = ts.split('T') as [string, string];
  const [y, m, d] = date.split('-');
  const name = `rollout-${date}T${time.slice(0, 8).replace(/:/g, '-')}-${scrubber.id(uuid)}.jsonl`;
  return [
    {
      path: join(out, '.codex', 'sessions', y ?? '2027', m ?? '01', d ?? '01', name),
      text: scrubbed.text,
    },
  ];
}

interface CursorFixture {
  cursorDiskKV: { key: string; value: string }[];
  composerHeaders: Record<string, unknown>[];
}

async function cursor(
  scrubber: Scrubber,
  out: string,
  args: Record<string, string | boolean | undefined>,
): Promise<Output[]> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(String(args.db), { readOnly: true });
  const composer = String(args.composer);
  const newComposer = scrubber.id(composer);
  const fixturePath = join(out, 'cursor-db.json');
  const fixture: CursorFixture = existsSync(fixturePath)
    ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as CursorFixture)
    : { cursorDiskKV: [], composerHeaders: [] };
  const text = (v: unknown): string =>
    typeof v === 'string' ? v : v ? Buffer.from(v as Uint8Array).toString('utf8') : '';
  const scrubJson = (v: string): string => (v ? JSON.stringify(scrubber.value(JSON.parse(v))) : '');
  const data = db
    .prepare('select value from cursorDiskKV where key = ?')
    .get(`composerData:${composer}`) as { value: unknown } | undefined;
  if (data)
    fixture.cursorDiskKV.push({
      key: `composerData:${newComposer}`,
      value: scrubJson(text(data.value)),
    });
  const tables = (
    db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  if (tables.includes('composerHeaders')) {
    const row = db.prepare('select * from composerHeaders where composerId = ?').get(composer) as
      | Record<string, unknown>
      | undefined;
    if (row)
      fixture.composerHeaders.push(
        scrubber.value({
          ...row,
          value: row.value ? JSON.parse(String(row.value)) : null,
        }) as Record<string, unknown>,
      );
  }
  if (!args['no-bubbles']) {
    const rows = db
      .prepare('select key, value from cursorDiskKV where key >= ? and key < ?')
      .all(`bubbleId:${composer}:`, `bubbleId:${composer};`) as { key: string; value: unknown }[];
    for (const row of rows) {
      const bubble = row.key.split(':')[2] ?? '';
      fixture.cursorDiskKV.push({
        key: `bubbleId:${newComposer}:${scrubber.id(bubble)}`,
        value: scrubJson(text(row.value)),
      });
    }
  }
  db.close();
  const outputs: Output[] = [{ path: fixturePath, text: `${JSON.stringify(fixture, null, 1)}\n` }];
  if (typeof args.transcript === 'string') {
    const project =
      scrubber
        .path(dirname(dirname(dirname(args.transcript))))
        .split('/')
        .at(-1) ?? 'project';
    outputs.push({
      path: join(
        out,
        '.cursor',
        'projects',
        project,
        'agent-transcripts',
        newComposer,
        `${newComposer}.jsonl`,
      ),
      text: scrubLines(scrubber, lines(args.transcript)).text,
    });
  }
  return outputs;
}

/**
 * Where leaked tokens sit, without printing them: the key path and the token's shape
 * (length and character classes), so the scrubber rule can be fixed.
 */
function explain(tokens: Set<string>, outputs: Output[]): void {
  const shape = (t: string): string =>
    `${t.length} chars, ${/[0-9]/.test(t) ? 'digits ' : ''}${/[a-z]/.test(t) ? 'letters ' : ''}${/[^a-z0-9]/.test(t) ? 'other' : ''}`.trim();
  const walk = (value: unknown, path: string, file: string): void => {
    if (typeof value === 'string') {
      for (const token of tokens)
        if (value.toLowerCase().includes(token))
          console.error(`  ${file} ${path}: ${shape(token)}`);
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, `${path}[]`, file);
    } else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) {
        for (const token of tokens)
          if (k.toLowerCase().includes(token))
            console.error(`  ${file} ${path} key: ${shape(token)}`);
        walk(v, `${path}.${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : '<key>'}`, file);
      }
  };
  for (const o of outputs) {
    const kind = o.path.includes('/subagents/')
      ? 'subagent'
      : o.path.endsWith('.json')
        ? 'json'
        : 'main';
    for (const line of o.text.split('\n').filter(Boolean)) {
      try {
        walk(JSON.parse(line), '$', kind);
      } catch {
        walk(o.text, '$', kind);
        break;
      }
    }
  }
}

/** Anything about this machine or person that must never reach a fixture. */
function personalLeaks(text: string): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  const user = userInfo().username.toLowerCase();
  const host = hostname()
    .toLowerCase()
    .replace(/\.local$/, '');
  if (lower.includes(homedir().toLowerCase())) found.push('home folder');
  if (user.length >= 4 && lower.includes(user)) found.push('user name');
  if (host.length >= 4 && host !== 'localhost' && lower.includes(host)) found.push('host name');
  if (
    /[A-Za-z0-9._%+-]+@(?!example\.com\b|users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(
      text,
    )
  )
    found.push('an email address');
  if (lower.includes('claude.ai/')) found.push('a claude.ai link');
  if (/\/Users\/|\/home\/(?!dev\/)/.test(text)) found.push('a home path');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone.includes('/') && text.includes(zone)) found.push('the time zone');
  return found;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      lines: { type: 'string' },
      subagents: { type: 'string' },
      workflows: { type: 'string' },
      'agent-lines': { type: 'string' },
      db: { type: 'string' },
      composer: { type: 'string' },
      transcript: { type: 'string' },
      'no-bubbles': { type: 'boolean' },
      'shift-days': { type: 'string' },
      inputs: { type: 'string' },
      names: { type: 'string' },
      'explain-leaks': { type: 'boolean' },
    },
  });
  // --inputs names a file with one input per line, so input paths never sit in a shell history.
  const [tool, ...listed] = positionals;
  const files = values.inputs
    ? [...listed, ...readFileSync(values.inputs, 'utf8').split('\n').filter(Boolean)]
    : listed;
  if (!values.out || !tool || (tool !== 'cursor' && files.length === 0)) {
    console.error(
      'usage: make-fixture.ts claude|codex <file...> --out <dir>, or make-fixture.ts cursor --db <file> --composer <id> --out <dir>',
    );
    return 2;
  }
  const names = [
    userInfo().username,
    hostname().replace(/\.local$/, ''),
    ...(values.names ? readFileSync(values.names, 'utf8').split('\n') : []),
  ];
  const scrubber = new Scrubber({
    shiftDays: Number(values['shift-days'] ?? 364),
    maxText: 240,
    names,
  });
  const outputs: Output[] = [];
  if (tool === 'claude')
    for (const f of files) outputs.push(...claude(scrubber, f, values.out, values));
  else if (tool === 'codex')
    for (const f of files) outputs.push(...codex(scrubber, f, values.out, values));
  else if (tool === 'cursor') outputs.push(...(await cursor(scrubber, values.out, values)));
  else {
    console.error(`unknown tool: ${tool}`);
    return 2;
  }

  const all = outputs.map((o) => o.text).join('\n');
  const leaked = scrubber.leaks(all);
  const personal = personalLeaks(all);
  if (leaked > 0 || personal.length > 0) {
    console.error(
      `Leak check failed: ${leaked} source tokens survived${personal.length ? `; found ${personal.join(', ')}` : ''}. Nothing was written.`,
    );
    if (values['explain-leaks']) explain(scrubber.leakedTokens(all), outputs);
    return 1;
  }
  for (const o of outputs) {
    mkdirSync(dirname(o.path), { recursive: true });
    writeFileSync(o.path, o.text);
  }
  const lineCount = outputs.reduce((n, o) => n + o.text.split('\n').filter(Boolean).length, 0);
  console.log(
    `Wrote ${outputs.length} files, ${lineCount} lines. Leak check passed. Review every file before committing it.`,
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  // Never print paths or text from the inputs: the error class and code are enough.
  const code = (error as { code?: unknown }).code;
  console.error(
    `make-fixture failed: ${(error as Error).name}${typeof code === 'string' ? ` ${code}` : ''}. Nothing was written.`,
  );
  process.exitCode = 1;
}
