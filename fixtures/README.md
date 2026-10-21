# fixtures

`home/` is a home folder in miniature with test data for every adapter, in the places the tools use: `home/.claude/projects` (Claude Code sessions, subagents and a workflow), `home/.codex/sessions` (a Codex rollout), `home/.cursor/projects` (Cursor agent transcripts) and `home/cursor-db.json` (Cursor's chat records as text; `node scripts/fixture-db.ts fixtures/home` builds the SQLite database from it).

Every fixture is produced by `scripts/make-fixture.ts`, which keeps structure, timing and lengths, replaces all text with synthetic words (and emails, URLs, paths, time zones and names with fixed placeholders), rounds token counts and durations, and checks its output for leaks before it writes anything. Never add real transcript text here, and review every fixture before committing it (CLAUDE.md).

Run the CLI against them:

```bash
node scripts/fixture-db.ts fixtures/home
pnpm --filter agentgpa dev -- --dry-run --debug --root fixtures/home
```
