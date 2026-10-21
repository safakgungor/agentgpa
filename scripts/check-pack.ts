// The published package is one bundled file and its licenses: no runtime dependencies, no
// install scripts and nothing else. CI runs this after the build; it fails on any difference.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'packages', 'cli');
const allowed = [
  'dist/LICENSE',
  'dist/THIRD_PARTY_LICENSES.txt',
  'dist/agentgpa.mjs',
  'package.json',
];
const lifecycle = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'postpack',
  'prepublish',
  'prepublishOnly',
];

const [pack] = JSON.parse(
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
  }).toString(),
) as [{ files: { path: string }[] }];
const files = pack.files.map((f) => f.path).sort();
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
const problems = [
  ...files.filter((f) => !allowed.includes(f)).map((f) => `unexpected file: ${f}`),
  ...allowed.filter((f) => !files.includes(f)).map((f) => `missing file: ${f}`),
  ...[
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ]
    .filter((k) => k in pkg)
    .map((k) => `package.json has ${k}`),
  ...lifecycle
    .filter((k) => k in ((pkg.scripts as Record<string, string>) ?? {}))
    .map((k) => `install script: ${k}`),
];
if (problems.length) {
  for (const p of problems) console.error(`check-pack: ${p}`);
  process.exit(1);
}
console.log(`check-pack: ${files.length} files, no dependencies, no install scripts`);
