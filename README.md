# AgentGPA

Your agent graded you.

AgentGPA grades how you work with your coding agents (Claude Code, Codex and Cursor) in seven courses and gives you a GPA. This repository holds the CLI, which reads the agent sessions on your machine, and `@agentgpa/core`, the code that reads, measures, grades and redacts, so you can check exactly what happens to your sessions. Your report and the boards (world, country, campus and tool tribes, for fun and self-reported) are on the website, a separate service.

**Status:** in development. Nothing is published yet.

## Privacy

Raw transcripts never leave your machine. You start on agentgpa.dev/start: you see what a run sends, say yes to it there and get a one-time code. With that code the CLI reads your sessions locally and sends a text-free event log, your counts and up to five redacted quote candidates, which stay private until you pick them on the site. The server grades you from that event log with this same core, and the CLI prints no grades: your report is on the website. The opt-in deep read sends a redacted sample of your own prompts and the names of your project folders (the folder's own name, never a path), which are read once and deleted. Without a code the CLI reads nothing, and `--offline`, `--dry-run`, `--json` and `--show-packet` show exactly what would be sent without any network call. [docs/payload.md](docs/payload.md) lists every field.

## Develop

Requirements: Node 24 (22.18 or newer works) and pnpm 11.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter agentgpa dev -- --help
pnpm --filter agentgpa dev -- --dry-run   # the exact payload, read from this machine; sends nothing
pnpm --filter agentgpa build              # the published bundle in packages/cli/dist
pnpm --filter agentgpa standalone         # a standalone build for this machine, with its SHA-256
```

## Layout

- `packages/core`: the pure logic the CLI and the AgentGPA server share (no fs, no network, no Node-only APIs)
- `packages/cli`: the `agentgpa` command
- `fixtures/`: synthetic test transcripts
- `docs/grading.md`: how the courses, the GPA, the archetypes and the activities are computed
- `docs/payload.md`: every field that can leave your machine, and when
- `docs/formats.md`: what each tool writes and how the CLI reads it
- `docs/releases.md`: how a release is built and published, and how to check one
- `CLAUDE.md`: the rules for agents and people working in this repository

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The license covers the code; it does not grant use of the AgentGPA name or logo.
