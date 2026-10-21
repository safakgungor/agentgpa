import { TOOL_FLAGS } from './types.ts';

// Shell commands the agent ran, sorted into a few flags, and the result of test runs read
// from their output. Only the flags and the result leave this module; the command and the
// output never leave the device.

const START = String.raw`(?:^|[\s;&|(\x60$])`;

const RULES: [number, RegExp][] = [
  [
    TOOL_FLAGS.gitCommit,
    new RegExp(`${START}git\\s+(?:-[Cc]\\s+\\S+\\s+|--?[a-z-]+(?:=\\S+)?\\s+)*commit\\b`),
  ],
  [TOOL_FLAGS.prCreate, new RegExp(`${START}gh\\s+pr\\s+create\\b`)],
  [
    TOOL_FLAGS.test,
    new RegExp(
      `${START}(?:(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test\\b|(?:npx|pnpm\\s+exec|bunx)\\s+(?:vitest|jest|playwright|mocha)\\b|vitest\\b|jest\\b|pytest\\b|mocha\\b|rspec\\b|phpunit\\b|go\\s+test\\b|cargo\\s+test\\b|swift\\s+test\\b|dotnet\\s+test\\b|make\\s+test\\b|gradlew?\\s+test\\b|mvn\\s+test\\b|playwright\\s+test\\b)`,
    ),
  ],
  [
    TOOL_FLAGS.build,
    new RegExp(
      `${START}(?:(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?build\\b|cargo\\s+build\\b|go\\s+build\\b|swift\\s+build\\b|dotnet\\s+build\\b|next\\s+build\\b|vite\\s+build\\b|tsc\\b(?!\\s+--noEmit)|xcodebuild\\b|gradlew?\\s+(?:assemble|build)\\b|mvn\\s+(?:package|install)\\b)`,
    ),
  ],
  [
    TOOL_FLAGS.deploy,
    new RegExp(
      `${START}(?:vercel\\s+(?:deploy\\b|--prod\\b|.*\\s--prod\\b)|netlify\\s+deploy\\b|fly\\s+deploy\\b|flyctl\\s+deploy\\b|wrangler\\s+(?:deploy|publish)\\b|firebase\\s+deploy\\b|gcloud\\s+.*\\bdeploy\\b|kubectl\\s+apply\\b|terraform\\s+apply\\b|(?:npm|pnpm|yarn)\\s+publish\\b|eas\\s+(?:submit|update)\\b|fastlane\\s+\\S*(?:release|deploy|beta)\\b)`,
    ),
  ],
  [
    TOOL_FLAGS.install,
    new RegExp(
      `${START}(?:(?:npm|pnpm|yarn|bun)\\s+(?:install|i|add|ci)\\b|(?:pip3?|uv\\s+pip)\\s+install\\b|uv\\s+(?:add|sync)\\b|poetry\\s+(?:add|install)\\b|cargo\\s+(?:add|install)\\b|go\\s+(?:get|install)\\b|gem\\s+install\\b|bundle\\s+install\\b|brew\\s+install\\b|apt(?:-get)?\\s+install\\b|composer\\s+(?:require|install)\\b|pod\\s+install\\b|dotnet\\s+add\\s+(?:\\S+\\s+)?package\\b|swift\\s+package\\s+resolve\\b)`,
    ),
  ],
  [
    TOOL_FLAGS.lint,
    new RegExp(
      `${START}(?:(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:lint|format|fmt)\\b|eslint\\b|prettier\\b|biome\\s+(?:check|lint|format|ci)\\b|ruff\\b|flake8\\b|pylint\\b|black\\b|isort\\b|rubocop\\b|golangci-lint\\b|gofmt\\b|go\\s+vet\\b|cargo\\s+(?:clippy|fmt)\\b|swiftlint\\b|swiftformat\\b|ktlint\\b|stylelint\\b)`,
    ),
  ],
];

/** The flag bits of one shell command. */
export function shellFlags(command: string): number {
  let flags = 0;
  for (const [bit, rule] of RULES) if (rule.test(command)) flags |= bit;
  return flags;
}

const FAILED = [
  /\b[1-9]\d* (?:failed|failing|failures?|errors?)\b/i,
  /^\s*FAIL\b/m,
  /\btest result: FAILED\b/,
  /^--- FAIL:/m,
  /^FAILED\b/m,
  /\bFAILED \((?:failures|errors)=/,
];
const PASSED = [
  /\b[1-9]\d* (?:passed|passing)\b/i,
  /^\s*PASS\b/m,
  /\btest result: ok\b/,
  /^ok\s+\S/m,
  /^OK(?: \(|$)/m,
  /\bAll tests passed\b/i,
];

/** A test run's result from its output, when the output says so. Only the result leaves. */
export function testOutcome(output: string): 'pass' | 'fail' | undefined {
  // Summaries come last, so a long output is read from its end.
  const text = output.length > 65_536 ? output.slice(-65_536) : output;
  if (FAILED.some((rule) => rule.test(text))) return 'fail';
  if (PASSED.some((rule) => rule.test(text))) return 'pass';
  return undefined;
}
