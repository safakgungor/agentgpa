# Security policy

AgentGPA reads some of the most sensitive data a developer has: agent sessions with code, secrets and company internals. Any way to move that data off a machine, to read another person's data or to tamper with a rank is a serious bug, and we want to hear about it.

## Reporting a vulnerability

Report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Please do not open a public issue.

Tell us what you found, how to reproduce it and what it affects. We aim to acknowledge a report within three business days and keep you updated until it is fixed.

## Disclosure

We follow a 90-day disclosure policy: we aim to ship a fix and publish an advisory within 90 days of your report, and we credit you unless you prefer otherwise.

## Scope

- The `agentgpa` CLI and its standalone builds
- The AgentGPA website and API
- This repository's workflows and release process

Out of scope: load or denial-of-service tests against production, social engineering, and findings in third-party services.

## Dependencies

The published CLI has no runtime dependencies: everything it runs is bundled at build time from the lockfile, so a bundled library is a dependency of every release. Dependabot proposes updates once a release has been out for 14 days, and pnpm installs nothing newer (`minimumReleaseAge`). CI fails on a known high or critical advisory (`pnpm audit`). A fix for a high or critical advisory in bundled code ships within 7 days, others within 30; when the fix is newer than 14 days, its package goes into `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` until it is old enough, and comes out again then.

## Supported versions

Only the latest release of the CLI is supported. A revoked release explains why and refuses to upload.
