# CLAUDE.md

Rules for agents and people working on the AgentGPA CLI and `@agentgpa/core`. The CLI reads every local agent session on a developer's machine, with code, secrets and company internals, so the privacy and security rules come before everything else.

## Privacy rules (non-negotiable)

- Raw transcript text is only processed in memory. Never write it to disk, logs, test snapshots, fixtures, commits or chat output. The only prompt text on disk is the redacted quote candidates inside the payload file that `--dry-run` writes.
- The opt-in deep read sends a redacted sample of the user's own prompts, and the names of their project folders (the folder's own name only, never a path, a file or a remote), to the AgentGPA server once. The CLI never stores, logs or caches that packet.
- When you inspect real transcripts, look at structure only (keys, types, line kinds, counts). Never print prompt or response text.
- Fixtures are produced only with `scripts/make-fixture.ts`, which replaces all text with synthetic words. Review every fixture before committing it.
- Nothing is uploaded without the user's yes on agentgpa.dev/start, which the link code carries: without a code the CLI reads nothing and sends nothing. `--offline`, `--dry-run`, `--json` and `--show-packet` mean zero network calls.
- Nothing streams in the background: the CLI runs once per report. The event skeleton never contains prompt text, paths, file names or MCP server names.
- A run prints no grades, quotes or findings, in the terminal or in agent mode: the results are only on the website. In agent mode (the copy prompt) the agent only runs the CLI, and its output never contains prompt text.
- The CLI never calls an LLM and holds no API keys.
- Secret detection reports counts by type only. Never send, store, log or commit secret values, fragments or hashes. Any in-memory dedupe hash is discarded after the scan.

## Security rules (non-negotiable)

- The published CLI has no runtime dependencies and no install scripts: everything is bundled at build time. A new runtime dependency needs the maintainer's OK.
- All network traffic goes through `net.ts`: HTTPS to the configured API origin only, no cross-origin redirects, and the deep read only to the default origin.
- Clean every transcript-derived string of control, ANSI, bidi and zero-width characters before it is printed or sent. In agent mode, drop quote candidates that hold URLs, paths, shell constructs or instructions aimed at agents.
- Never log payloads, quotes, prompts, or request and response bodies.
- GitHub Actions are pinned by commit SHA with least-privilege permissions; releases go only through the maintainer-approved release workflow.
- Install or propose only package versions published at least 14 days ago.

## Code conventions

- TypeScript 7 strict, ESM, pnpm 11 workspaces, Biome for lint and format. Node >= 22.12 for the CLI runtime (plus a standalone build for machines without Node), Node 24 for development. Use only erasable TypeScript syntax (no enums or namespaces), so Node can run the sources directly.
- `@agentgpa/core` is pure: no `fs`, no network, no Node-only APIs (`packages/core/test/purity.test.ts` checks it). File discovery and I/O live in `packages/cli`.
- What the CLI and the AgentGPA server must agree on (the payload, the event skeleton, metrics, signals, grading) lives in core, and the server runs this same code.
- Validate every boundary with `zod`.
- Metrics, signals, grading, archetypes, activities and redaction have unit tests, and every metric and signal has an exact expectation (a coverage test fails otherwise). Grading tests include the worked examples in `docs/grading.md`.
- Parsers are pure: they get one line or record at a time and build sessions at the end. A broken line is counted and skipped, never fatal; zod checks the fields each parser reads, and maps keyed by transcript data have no prototype.
- Thresholds, anchors and lexicons are data in config files, never scattered literals.
- Case checks and lexicons are locale aware; test Turkish dotted and dotless I.
- Keep CLI dependencies minimal; `npx` cold start time matters.

## Copy

- User-facing copy is English by default. Tone: playful, school report card humor, never cruel. Swears are always censored.
- No em dashes in user-facing copy.
- AgentGPA is for every developer: never call users students.

## Keep this repository public-safe

- Everything here is public, including the history. Commit with a noreply address, and never add personal data, home paths, real transcripts, secrets or files copied from other repositories.

## Ask the maintainer first

- Publishing to npm or cutting a release.
- Adding a runtime dependency.
- Changing the grading formula, the anchors or what the payload and the deep read packet can carry.

## Commands

- `pnpm install`
- `pnpm typecheck`, `pnpm lint`, `pnpm test`
- `pnpm --filter agentgpa dev -- --help` (run the CLI from source)
- `pnpm --filter agentgpa build`, then `node scripts/check-pack.ts` (the published bundle: one file and its licenses)
- `pnpm --filter agentgpa standalone` (the standalone build for this machine, with its SHA-256)
- `node scripts/bench-pow.ts` (times the proof-of-work solver on a hard 22-bit challenge; the budget is 5 seconds on 4 threads)
- `node scripts/fixture-db.ts fixtures/home`, then `pnpm --filter agentgpa dev -- --dry-run --debug --root fixtures/home` (run it against the fixtures)
- `node scripts/make-fixture.ts claude|codex|cursor ...` (make a fixture from a real session; see the usage at the top of the script)

## Formats

`docs/formats.md` records what each tool writes, the traps the parsers handle and the scan time. If a tool's format changes, follow the files, update `docs/formats.md` and add a fixture.
