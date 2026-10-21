import type { Event, Session, Tool, ToolCategory } from '../src/index.ts';

// Builders for synthetic sessions in tests. Every text here is made up.

export const DAY = 86_400_000;
export const END = Date.UTC(2027, 2, 31, 12); // the period ends on 2027-03-31 12:00 UTC
export const at = (daysAgo: number, hour = 12, minute = 0): number =>
  Date.UTC(2027, 2, 31 - daysAgo, hour, minute);

export function prompt(
  ts: number,
  text: string,
  extra: Partial<Extract<Event, { kind: 'user_prompt' }>> = {},
): Event {
  return { kind: 'user_prompt', ts, text, images: 0, ...extra };
}

export function reply(ts: number, text: string, model = 'claude-opus-5-5'): Event[] {
  return [
    {
      kind: 'usage',
      ts,
      model,
      sidechain: false,
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
    },
    { kind: 'assistant_text', ts, text, model },
  ];
}

export function call(
  ts: number,
  name: string,
  category: ToolCategory,
  extra: Partial<Extract<Event, { kind: 'tool_call' }>> = {},
): Event {
  return { kind: 'tool_call', ts, name, category, sidechain: false, ...extra };
}

export function interrupt(ts: number): Event {
  return { kind: 'interrupt', ts };
}

let id = 0;
export function session(tool: Tool, events: Event[], extra: Partial<Session> = {}): Session {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  return {
    tool,
    id: `s${++id}`,
    projectKey: 'hash',
    startedAt: sorted[0]?.ts ?? END,
    endedAt: sorted.at(-1)?.ts ?? END,
    models: [],
    usedPlanMode: false,
    permissionModes: {},
    compactions: 0,
    commands: {},
    subagents: 0,
    messageIds: [],
    events: sorted,
    ...extra,
  };
}

/** One prompt a day at `hour` UTC for `days` days, each with a reply. */
export function daily(
  tool: Tool,
  days: number,
  hour: number,
  text = 'please refactor the parser module and run the tests',
): Session[] {
  return Array.from({ length: days }, (_, d) =>
    session(tool, [prompt(at(d, hour), text), ...reply(at(d, hour, 2), 'Done.')]),
  );
}
