import { safeLabel } from '../clean.ts';
import type { Event, ParserOptions, ParseStats, Session, Tool } from '../types.ts';

/** Collects one session's events and facts while its lines stream in. */
export class SessionBuilder {
  readonly tool: Tool;
  readonly id: string;
  events: Event[] = [];
  models = new Set<string>();
  messageIds: string[] = [];
  permissionModes = counter();
  commands = counter();
  agents = new Set<string>();
  usedPlanMode = false;
  compactions = 0;
  cwd: string | undefined;
  version: string | undefined;
  entrypoint: string | undefined;
  formatVersion: number | undefined;
  firstTs = Number.POSITIVE_INFINITY;
  lastTs = Number.NEGATIVE_INFINITY;

  constructor(tool: Tool, id: string) {
    this.tool = tool;
    this.id = id;
  }

  /** Widens the session's time span; every line with a valid time counts. */
  seen(ts: number): void {
    if (ts < this.firstTs) this.firstTs = ts;
    if (ts > this.lastTs) this.lastTs = ts;
  }

  add<E extends Event>(event: E): E {
    this.events.push(event);
    this.seen(event.ts);
    return event;
  }

  model(name: unknown): string | undefined {
    const label = safeLabel(name);
    if (label) this.models.add(label);
    return label;
  }

  mode(name: unknown): void {
    const label = safeLabel(name);
    if (label) bump(this.permissionModes, label);
  }

  build(options: ParserOptions): Session | undefined {
    if (!Number.isFinite(this.firstTs)) return undefined;
    const events = this.events.slice().sort((a, b) => a.ts - b.ts);
    const session: Session = {
      tool: this.tool,
      id: this.id,
      projectKey: options.hash(this.cwd ?? ''),
      startedAt: this.firstTs,
      endedAt: this.lastTs,
      models: [...this.models].sort(),
      usedPlanMode: this.usedPlanMode,
      permissionModes: this.permissionModes,
      compactions: this.compactions,
      commands: this.commands,
      subagents: this.agents.size,
      messageIds: this.messageIds,
      events,
    };
    const name = this.cwd?.split(/[/\\]/).filter(Boolean).at(-1);
    if (name) session.projectName = name;
    if (this.version) session.version = this.version;
    if (this.entrypoint) session.entrypoint = this.entrypoint;
    if (this.formatVersion !== undefined) session.formatVersion = this.formatVersion;
    return session;
  }
}

/** A count map with no prototype, so keys taken from transcripts cannot reach `Object`. */
export function counter(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

export function bump(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (Object.hasOwn(map, key) ? (map[key] as number) : 0) + n;
}

export function emptyStats(): ParseStats {
  return {
    lines: 0,
    malformed: 0,
    oversized: 0,
    duplicates: 0,
    kinds: counter(),
    notPrompts: counter(),
  };
}

/** A time in epoch ms from an ISO string or a number, or undefined. */
export function toTime(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? undefined : ts;
}

/** A kind name safe to print, or `other`. */
export function kindName(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_/-]{0,40}$/i.test(value) ? value : 'other';
}
