# Releases

The CLI reads the most sensitive files on a developer's machine, so a release has to be something you can check, not something you have to trust.

## How a release is made

- Only the `release` workflow (`.github/workflows/release.yml`) publishes, and only from a signed, annotated tag `vX.Y.Z` that matches `packages/cli/package.json` and points at the commit being built. The maintainer approves each run in the `release` environment before anything is published.
- The npm package is published through npm trusted publishing: the workflow proves who it is with a short-lived OIDC token, so no npm token exists anywhere, and npm attaches provenance that names the workflow run and the commit.
- The package is one bundled file, its licenses and its README: no dependencies and no install scripts (`scripts/check-pack.ts`), so `npx agentgpa` downloads nothing but this package.
- Two separate machines build the npm package, and each standalone build is built twice on its machine; the release stops unless the copies are byte for byte the same. No cache from an earlier run is used.
- The standalone builds (macOS arm64 and x64, Linux x64, Windows x64) and the npm tarball are listed with their SHA-256 in `SHA256SUMS` on the GitHub release, and all of them carry a GitHub build attestation (SLSA provenance).
- npm attaches provenance, and GitHub makes build attestations, only for a public repository. The releases made while this repository was private (0.1.0 to 0.1.2) have neither, since the workflow reads the repository's visibility and leaves both out; their `SHA256SUMS` and the reproducible build below still let you check them.

## How to check one

Before you run a standalone build:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify agentgpa-linux-x64 --repo safakgungor/agentgpa
```

For the npm package, `npm audit signatures` in a project that installed it checks the registry signature and the provenance. On npm, the package page shows the provenance and links the exact workflow run.

To rebuild a release yourself, check out its tag and run `pnpm install --frozen-lockfile`, then `pnpm --filter agentgpa build` and `npm pack` in `packages/cli` (Node 24 on Linux) and compare the tarball's SHA-256 with `SHA256SUMS`. `pnpm --filter agentgpa standalone` rebuilds the standalone build for your machine and prints its SHA-256.

## When a release is bad

A version with a bug that matters is revoked: when online, the CLI asks the server about its version, and a revoked version says it can no longer send and refuses to upload. On npm it is deprecated and `latest` moves back to the last good version, and a security issue gets a GitHub security advisory. See [SECURITY.md](../SECURITY.md) to report one.
