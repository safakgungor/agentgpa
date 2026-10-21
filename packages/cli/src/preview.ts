import { COURSE_NAMES, COURSES, type Report, type Tool } from '@agentgpa/core';
import { canvas, INNER, type Kind, type Segment, type Style, shown, WIDTH } from './terminal.ts';

// The terminal report card: never wider than 80 columns, one accent (the archetype's
// highlighter in truecolor, bright yellow on 16-color terminals), and readable without color:
// highlights become [brackets] and the Detention tag a label. No prompt text ever appears here.

export { detectStyle, type Style, WIDTH } from './terminal.ts';

export interface PreviewOptions {
  style: Style;
  tools: { tool: Tool; found: boolean; readable: boolean }[];
  scanMs: number;
  days: number;
  /** Days Claude Code keeps; shown when it is below the period. */
  claudeCleanupDays: number;
  details?: boolean;
  /** The account a link code bound the run to; the card says YOU without one. */
  who?: { name?: string | undefined; handle?: string | undefined };
  /** The last line: an invitation to see what would be sent, the plain note, or nothing. */
  footer?: 'enter' | 'plain' | 'none';
}

const TOOL_NAMES: Record<Tool, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};
const num = (n: number) => n.toLocaleString('en-US');

export function renderPreview(report: Report, options: PreviewOptions): string {
  const { style } = options;
  const { line, row, rule } = canvas(style, report.archetype.highlighter);

  const m = report.metrics;
  const g = report.grades;
  const out: string[] = [];
  out.push(
    line(
      options.tools.flatMap((t, i): Segment[] => [
        [`${i ? '   ' : ''}${TOOL_NAMES[t.tool]} `, ''],
        t.found ? (t.readable ? ['✓', 'acc'] : ['not readable', 'dim']) : ['not found', 'dim'],
      ]),
    ),
  );
  out.push(
    line([
      [
        `Read ${num(m.sessions)} ${m.sessions === 1 ? 'session' : 'sessions'} and ${num(m.userPrompts)} ${m.userPrompts === 1 ? 'prompt' : 'prompts'} from the last ${options.days} days`,
        '',
      ],
      [`   ${(options.scanMs / 1000).toFixed(1)} s`, 'dim'],
    ]),
  );
  out.push('');
  if (m.userPrompts === 0) {
    const none = options.tools.every((t) => !t.found);
    out.push(
      line([
        [
          none
            ? 'No Claude Code, Codex or Cursor sessions on this machine, so nothing to grade.'
            : `No prompts in the last ${options.days} days, so there is nothing to grade yet.`,
          '',
        ],
      ]),
      line([['Nothing has left this machine.', '']]),
    );
    return out.join('\n');
  }
  out.push(rule('╭', '╮'));
  out.push(
    row(
      [
        ['AGENTGPA', 'accb'],
        [` · REPORT CARD · ${report.term}`, 'bold'],
      ],
      [[`LAST ${options.days} DAYS`, 'dim']],
    ),
  );
  out.push(rule('├', '┤'));
  out.push(row());
  const gpa: Segment[] =
    g.gpa === undefined
      ? [
          ['GPA ', 'dim'],
          [' I ', 'hi'],
          [' INCOMPLETE', 'dim'],
        ]
      : [
          ['GPA ', 'dim'],
          [` ${g.gpa.toFixed(2)} `, 'hi'],
          [' / 4.00', 'dim'],
        ];
  const name = options.who?.name ?? options.who?.handle;
  const handle = options.who?.handle && options.who.name ? `  @${options.who.handle}` : '';
  out.push(
    row(
      name
        ? [
            [name.toUpperCase(), 'bold'],
            [handle, 'dim'],
          ]
        : [['YOU', 'bold']],
      gpa,
    ),
  );
  out.push(
    row([
      [report.archetype.name, 'acc'],
      [` · ${report.archetype.superlative.toLowerCase()}`, ''],
    ]),
  );
  out.push(row());
  const cell = (id: (typeof COURSES)[number]): Segment[] => {
    const name = COURSE_NAMES[id];
    const letter = g.courses[id].letter;
    const kind: Kind = letter === 'D' || letter === 'F' ? 'hi' : 'bold';
    const w = shown(style, [letter, kind]);
    return [
      [`${name} ${'.'.repeat(Math.max(1, 17 - name.length))} `, 'dim'],
      [letter, kind],
      [' '.repeat(Math.max(1, 6 - w)), ''],
    ];
  };
  for (let i = 0; i < COURSES.length; i += 3) out.push(row(COURSES.slice(i, i + 3).flatMap(cell)));
  out.push(row());
  if (g.gpa === undefined) {
    out.push(row([['Incomplete: come back after more classes.', '']]));
    out.push(row());
  }
  for (const preview of report.previewLines)
    out.push(
      row([
        ['• ', 'acc'],
        [preview.text, ''],
      ]),
    );
  out.push(row());
  const secrets = report.device.secrets.pasted + report.device.secrets.exposedViaTools;
  if (g.detention) {
    out.push(
      row([
        [' DETENTION ', 'inv'],
        [`  ${num(secrets)} ${secrets === 1 ? 'secret' : 'secrets'} reached your agent. `, ''],
        ...(options.details
          ? []
          : ([
              ['--details', 'bold'],
              [' shows the fix.', ''],
            ] as Segment[])),
      ]),
    );
    out.push(row());
  }
  out.push(rule('├', '┤'));
  const shares = (Object.entries(m.perTool) as [Tool, { prompts: number }][])
    .filter(([, t]) => t.prompts > 0)
    .sort((a, b) => b[1].prompts - a[1].prompts)
    .map(([tool, t]) => {
      const percent = Math.round((t.prompts / Math.max(1, m.userPrompts)) * 100);
      return `${TOOL_NAMES[tool]} ${percent === 0 ? '<1' : percent}%`;
    });
  const kept =
    options.claudeCleanupDays < options.days && m.perTool['claude-code']
      ? [`Claude Code kept ${options.claudeCleanupDays} of the ${options.days} days`]
      : [];
  const footer = [...shares, ...kept].join(' · ');
  if (footer.length <= INNER) out.push(row([[footer, 'dim']]));
  else {
    out.push(row([[shares.join(' · '), 'dim']]));
    if (kept.length) out.push(row([[kept.join(''), 'dim']]));
  }
  out.push(rule('╰', '╯'));
  const last = options.footer ?? 'plain';
  if (last === 'enter') {
    out.push(
      line([
        ['Nothing has left this machine. ', ''],
        ['Enter', 'hi'],
        [' shows what would be sent.', ''],
      ]),
    );
  } else if (last === 'plain') out.push(line([['Nothing has left this machine.', '']]));
  if (options.details && g.detention) out.push('', ...detentionDetails(report));
  return out.join('\n');
}

const SECRET_NAMES: Record<string, string> = {
  aws: 'AWS key',
  github: 'GitHub token',
  openai: 'OpenAI key',
  anthropic: 'Anthropic key',
  stripe: 'Stripe key',
  gcp: 'Google Cloud key',
  slack: 'Slack token',
  private_key: 'private key',
  jwt: 'JSON web token',
  db_url: 'database password',
  other_provider: 'other provider key',
};

/** Words joined into lines of at most `width` columns, each starting with `indent`. */
function wrap(text: string, indent: string, width = WIDTH): string[] {
  const lines: string[] = [];
  let current = indent;
  for (const word of text.split(' ')) {
    if (current.length > indent.length && current.length + 1 + word.length > width) {
      lines.push(current);
      current = indent;
    }
    current += current.length > indent.length ? ` ${word}` : word;
  }
  lines.push(current);
  return lines;
}

/** Only the owner sees this: secret types by count and how to keep them out next time. */
export function detentionDetails(report: Report): string[] {
  const s = report.device.secrets;
  const types = Object.entries(s.types)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([type, n]) => `${n} ${SECRET_NAMES[type] ?? type}${n === 1 ? '' : 's'}`);
  return [
    'Detention details (only you see these, and they never leave this machine):',
    ...wrap(`${types.join(', ')}.`, '  '),
    ...wrap(
      `${num(s.pasted)} pasted into prompts, ${num(s.exposedViaTools)} read by your agent from files or tools.`,
      '  ',
    ),
    "  Rotate them, and keep secrets out of your agent's reach:",
    '  in Claude Code, deny reads of .env and key files in your permissions;',
    '  in Codex and Cursor, keep them out of the workspace the agent can read.',
  ];
}
