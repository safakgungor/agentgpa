import { safeLabel } from '@agentgpa/core';
import type { ToolScan } from './scan.ts';

// The --debug report: counts, kinds and timings only. It never prints transcript text, paths
// or names; the only transcript-derived strings are model names that pass `safeLabel`.

const n = (value: number): string => value.toLocaleString('en-US');

function top(map: Record<string, number>, limit: number): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${k} ${n(v)}`)
    .join(', ');
}

export interface ReportOptions {
  now: number;
  sinceDays: number;
  claudeCleanupDays: number;
  claudeCleanupFromSettings: boolean;
  scanMs: number;
}

export function debugReport(scans: ToolScan[], options: ReportOptions): string {
  const from = options.now - options.sinceDays * 86_400_000;
  const lines: string[] = [];
  for (const s of scans) {
    const r = s.result;
    const st = r.stats;
    lines.push(
      `${s.tool}: ${s.found ? (s.readable ? 'found' : 'found, NOT readable') : 'not found'}`,
    );
    if (!s.found) continue;
    lines.push(
      `  files: ${top(s.files, 5)} (${n(Math.round(s.bytes / 1_048_576))} MB) in ${n(Math.round(s.ms))} ms${s.skipped ? `, ${n(s.skipped)} unreadable and skipped` : ''}`,
    );
    lines.push(
      `  records: ${n(st.lines)} read, ${n(st.malformed)} malformed and skipped, ${n(st.oversized)} over 8 MB skipped, ${n(st.duplicates)} duplicates dropped`,
    );
    const count = (inPeriod: boolean) => {
      const c = {
        sessions: 0,
        prompts: 0,
        queued: 0,
        approx: 0,
        replies: 0,
        usage: 0,
        sideUsage: 0,
        tools: 0,
        sideTools: 0,
        interrupts: 0,
        plan: 0,
        compactions: 0,
      };
      for (const session of r.sessions) {
        const events = inPeriod ? session.events.filter((e) => e.ts >= from) : session.events;
        if (!events.length) continue;
        c.sessions++;
        if (session.usedPlanMode) c.plan++;
        c.compactions += session.compactions;
        for (const e of events) {
          if (e.kind === 'user_prompt') {
            c.prompts++;
            if (e.queued) c.queued++;
            if (e.approx) c.approx++;
          } else if (e.kind === 'assistant_text') c.replies++;
          else if (e.kind === 'usage') e.sidechain ? c.sideUsage++ : c.usage++;
          else if (e.kind === 'tool_call') e.sidechain ? c.sideTools++ : c.tools++;
          else if (e.kind === 'interrupt') c.interrupts++;
        }
      }
      return c;
    };
    for (const [label, inPeriod] of [
      [`last ${options.sinceDays} days`, true],
      ['all on disk', false],
    ] as const) {
      const c = count(inPeriod);
      lines.push(
        `  ${label}: ${n(c.sessions)} sessions, ${n(c.prompts)} prompts (${n(c.queued)} queued, ${n(c.approx)} with approximate time), ${n(c.replies)} replies with text, ${n(c.usage + c.sideUsage)} model calls (${n(c.sideUsage)} by subagents), ${n(c.tools + c.sideTools)} tool calls (${n(c.sideTools)} by subagents), ${n(c.interrupts)} interrupts, ${n(c.compactions)} compactions, ${n(c.plan)} sessions with plan mode`,
      );
    }
    lines.push(`  record kinds: ${top(st.kinds, 12)}`);
    if (Object.keys(st.notPrompts).length) lines.push(`  not prompts: ${top(st.notPrompts, 12)}`);
    const models: Record<string, number> = {};
    for (const session of r.sessions)
      for (const m of session.models) if (safeLabel(m)) models[m] = (models[m] ?? 0) + 1;
    if (Object.keys(models).length) lines.push(`  models (sessions): ${top(models, 6)}`);
    if (s.tool === 'claude-code') {
      lines.push(
        `  retention: cleanupPeriodDays ${options.claudeCleanupDays}${options.claudeCleanupFromSettings ? '' : ' (default, not set)'}`,
      );
    }
  }
  lines.push(`scan: ${n(Math.round(options.scanMs))} ms`);
  return lines.join('\n');
}
