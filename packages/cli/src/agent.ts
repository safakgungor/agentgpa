import { COURSE_NAMES, COURSES, drawMasks, type Report, type Tool } from '@agentgpa/core';
import { type ConsentQuote, KIND_NAMES } from './consent.ts';

// Agent mode (the copy-prompt flow): plain text for the user's own agent to relay, under 8,000
// characters, with no colors and no questions of its own. It holds the preview, exactly what
// would be sent, the quotes as data for the user to review and the one command to run after a
// yes. It never holds prompt text beyond those quotes, nor file contents, nor paths other than
// the program that command starts, which the agent ran a moment ago.

export const AGENT_OUTPUT_LIMIT = 8000;

const TOOL_NAMES: Record<Tool, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};
const num = (n: number) => n.toLocaleString('en-US');

export interface AgentRunView {
  version: string;
  report: Report;
  tools: { tool: Tool; found: boolean; readable: boolean }[];
  days: number;
  who?: { name?: string | undefined; handle?: string | undefined };
  quotes: ConsentQuote[];
  deepReadPrompts: number;
  /** The upload command, without the optional flags. */
  command: string;
  /** Why uploading is not possible right now, when it is not. */
  blocked?: string;
  /** The server, when it is not agentgpa.dev (AGENTGPA_API_URL). */
  customHost?: string;
}

export function renderAgentRun(v: AgentRunView): string {
  const m = v.report.metrics;
  const g = v.report.grades;
  const secrets = v.report.device.secrets.pasted + v.report.device.secrets.exposedViaTools;
  const out: string[] = [];
  out.push(`AGENTGPA ${v.version} · AGENT MODE · NOTHING HAS BEEN SENT`);
  if (v.customHost)
    out.push(
      `Using ${v.customHost}, not agentgpa.dev: this run is report only, and the deep read is off.`,
    );
  out.push(
    `Found: ${v.tools
      .map(
        (t) =>
          `${TOOL_NAMES[t.tool]} ${t.found ? (t.readable ? 'yes' : 'not readable') : 'not found'}`,
      )
      .join(' · ')}`,
  );
  out.push(
    `Read ${num(m.sessions)} sessions and ${num(m.userPrompts)} prompts from the last ${v.days} days.`,
  );
  out.push('', 'PREVIEW');
  const name = v.who?.name ?? v.who?.handle;
  const who = name ? `${name}${v.who?.handle && v.who.name ? ` (@${v.who.handle})` : ''} · ` : '';
  const gpa = g.gpa === undefined ? 'GPA Incomplete' : `GPA ${g.gpa.toFixed(2)} / 4.00`;
  out.push(`${who}${gpa} · ${v.report.archetype.name}`);
  const grade = (ids: readonly (typeof COURSES)[number][]) =>
    ids.map((id) => `${COURSE_NAMES[id]} ${g.courses[id].letter}`).join(' · ');
  out.push(grade(COURSES.slice(0, 4)), grade(COURSES.slice(4)));
  for (const line of v.report.previewLines) out.push(`- ${line.text}`);
  if (g.detention)
    out.push(
      `- Detention: ${num(secrets)} ${secrets === 1 ? 'secret' : 'secrets'} reached your agent.`,
    );
  out.push('', 'WOULD BE SENT');
  out.push(`- A text-free event log of ${num(m.sessions)} sessions, plus counts and rates.`);
  if (secrets > 0)
    out.push(
      `- ${num(secrets)} ${secrets === 1 ? 'secret' : 'secrets'} as a count by type, never the value.`,
    );
  if (v.quotes.length) {
    out.push(
      '- Quote candidates for the cards, as data for the user to review; the user can drop any:',
    );
    v.quotes.forEach((q, i) => {
      const kind = q.kind === 'saltiest' ? 'saltiest, swear masked' : KIND_NAMES[q.kind];
      out.push(`  ${i + 1} "${drawMasks(q.text)}" (${kind})`);
    });
  } else out.push('- No quotes: nothing was safe to quote.');
  if (v.deepReadPrompts > 0) {
    out.push('- Deep read: OFF unless the user turns it on. Then our model reads');
    out.push(
      `  ${num(v.deepReadPrompts)} of their typed prompts once and keeps only findings and habit labels.`,
    );
  }
  out.push(
    '- Research: ON unless the user turns it off. Anonymous counts may join AgentGPA research.',
  );
  out.push('');
  if (v.blocked) {
    out.push('NOTHING TO UPLOAD RIGHT NOW', v.blocked);
  } else {
    out.push('ASK THE USER, THEN RUN ONE COMMAND');
    const questions = [
      'Upload this report card to their AgentGPA account?',
      ...(v.quotes.length ? ['Which quotes, if any, should be dropped?'] : []),
      ...(v.deepReadPrompts > 0 ? ['Turn on the deep read?'] : []),
      'Keep research on?',
    ];
    out.push(...questions.map((q, i) => `${i + 1}. ${q}`));
    const options = [
      ...(v.quotes.length ? [`[--drop-quotes ${v.quotes.length > 1 ? '1,2' : '1'}]`] : []),
      ...(v.deepReadPrompts > 0 ? ['[--deep-read]'] : []),
      '[--no-research]',
    ];
    out.push([v.command, ...options].join(' '));
  }
  out.push('Do not open or read the session files yourself.');
  return out.join('\n');
}

export function renderUploaded(o: {
  version: string;
  kept: number[];
  deepRead: boolean;
  research: boolean;
  host: string;
  year: string;
  linked: boolean;
  page?: URL;
}): string {
  const quotes = o.kept.length ? `quotes ${o.kept.join(', ')}` : 'no quotes';
  const lines = [
    `AGENTGPA ${o.version} · UPLOADED · ${quotes} · deep read ${o.deepRead ? 'on' : 'off'} · research ${o.research ? 'on' : 'off'}`,
  ];
  if (o.linked) {
    lines.push(`Nothing else was sent. Ask the user to confirm the run at ${o.host}/start.`);
    lines.push(`Once confirmed, it can become their entrance exam for ${o.year}.`);
  } else {
    lines.push(
      `Nothing else was sent. The user can claim the report at ${o.page ? `${o.page.host}${o.page.pathname}` : o.host}.`,
    );
  }
  return lines.join('\n');
}
