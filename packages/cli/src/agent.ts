import { type DeepReadEnd, fixLines, type RunDone } from './screens.ts';

// Agent mode (the copy-prompt flow): plain text for the user's own agent to relay, with no
// colors and no questions. The owner said yes on /start already, so the run sends at once and
// the agent learns only that it did and where the report is. It never sees a grade, a quote,
// a finding, a path or a file's contents: those are only on the website.

export const AGENT_OUTPUT_LIMIT = 8000;

const TOOL_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' } as const;
const NO_PEEKING = 'Do not open or read the session files yourself.';

export function renderAgentRun(v: Omit<RunDone, 'opened'> & { customHost?: string }): string {
  const host = v.page.host;
  return [
    `AGENTGPA ${v.version} · AGENT MODE${v.handle ? ` · LINKED TO @${v.handle}` : ''}`,
    ...(v.customHost
      ? [
          `Using ${v.customHost}, not agentgpa.dev: this run is report only, and the deep read is off.`,
        ]
      : []),
    `Found: ${v.tools
      .map(
        (t) =>
          `${TOOL_NAMES[t.tool]} ${t.found ? (t.readable ? 'yes' : 'not readable') : 'not found'}`,
      )
      .join(' · ')}`,
    ...fixLines(v.tools),
    `Read ${v.sessions.toLocaleString('en-US')} ${v.sessions === 1 ? 'session' : 'sessions'} from the last ${v.days} days.`,
    `Sent what the user said yes to on ${host}/start.`,
    ...(v.deepRead === 'next'
      ? ['The deep read the user chose goes next, at most a minute.']
      : v.deepRead === 'not sent'
        ? ['The deep read did not go through; the report stays.']
        : []),
    `Tell the user the report is ready at ${host}${v.page.pathname},`,
    'where they confirm the run. Grades, quotes and findings are only shown there.',
    NO_PEEKING,
  ].join('\n');
}

/** The deep read's end, after the report's address: a busy server never holds the run. */
export function renderAgentDeepRead(end: DeepReadEnd): string {
  return end === 'sent'
    ? 'The deep read the user chose was sent once and dropped.'
    : end === 'busy'
      ? 'Deep read skipped, the servers are busy. Your report is ready.'
      : 'The deep read did not go through; the report stays.';
}

/** A run that stopped before sending, and what the agent should tell the user. */
export function renderAgentStop(version: string, message: string): string {
  return [`AGENTGPA ${version} · AGENT MODE`, message, NO_PEEKING].join('\n');
}
