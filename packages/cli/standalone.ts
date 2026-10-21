// Builds the standalone CLI for this machine's system and processor: Node itself with the
// bundled CLI inside (Node's single executable applications), for computers without Node. It
// writes the file's SHA-256 next to it; building again from the same sources gives the same
// file, so anyone can check a release.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postject from 'postject';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
execFileSync(process.execPath, [join(here, 'build.ts'), '--cjs'], { stdio: 'inherit' });

// Relative paths and no code cache keep the blob the same from one build to the next.
writeFileSync(
  join(dist, 'sea-config.json'),
  JSON.stringify({
    main: 'agentgpa.cjs',
    output: 'sea.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
  cwd: dist,
  stdio: 'inherit',
});

const system =
  { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform as string] ??
  process.platform;
const name = `agentgpa-${system}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const out = join(dist, name);
// The macOS installer's node holds both processors (a universal file): keep this machine's.
const archs =
  process.platform === 'darwin'
    ? execFileSync('lipo', ['-archs', process.execPath]).toString().trim().split(/\s+/)
    : [];
const slice = process.arch === 'x64' ? 'x86_64' : process.arch;
if (archs.length > 1) execFileSync('lipo', [process.execPath, '-thin', slice, '-output', out]);
else copyFileSync(process.execPath, out);
chmodSync(out, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', out]);
await postject.inject(out, 'NODE_SEA_BLOB', readFileSync(join(dist, 'sea.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});
// macOS runs only signed code; an ad-hoc signature holds no time, so it does not change the hash.
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', out]);
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  ${name}\n`);
console.log(`${name} ${sha}`);
