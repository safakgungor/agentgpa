# AgentGPA

Your agent graded you.

The AgentGPA CLI reads the agent sessions on your machine (Claude Code, Codex and Cursor), grades how you work with your coding agents in seven courses and gives you a GPA. This repository holds the CLI and `@agentgpa/core`, the code that reads, measures, grades and redacts, so you can check exactly what happens to your sessions. The website and the boards (world, country, campus and tool tribes, for fun and self-reported) are a separate service.

**Status:** in development. Nothing is published yet.

## Privacy

Raw transcripts never leave your machine. The CLI reads your sessions locally and shows a report card in the terminal. Only after you say yes does it upload a text-free event log, your counts and up to five redacted quotes you approve. The server then recomputes every grade from that event log with this same core. The opt-in deep read sends a redacted sample of your own prompts, which is read once and deleted. `--offline` makes no network calls at all.

## Develop

Requirements: Node 24 (22.18 or newer works) and pnpm 11.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter agentgpa dev -- --help
pnpm --filter agentgpa dev -- --dry-run   # your report card, read from this machine; sends nothing
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
