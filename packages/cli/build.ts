// Builds the published CLI: one bundled file with no runtime dependencies, plus the licenses
// of everything bundled into it. `--cjs` also writes the CommonJS bundle the standalone build
// embeds. The output is the same on every run for the same sources.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Metafile } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  entryPoints: [join(here, 'src/index.ts')],
  bundle: true,
  platform: 'node' as const,
  target: 'node22',
  legalComments: 'none' as const,
  metafile: true,
  logLevel: 'warning' as const,
};

// Bundled CommonJS code calls require(); an ES module gets one from node:module.
const esm = await build({
  ...common,
  format: 'esm',
  outfile: join(dist, 'agentgpa.mjs'),
  banner: {
    // esbuild keeps the entry's own #! line above this.
    js: "import { createRequire as __agentgpaRequire } from 'node:module';\nconst require = __agentgpaRequire(import.meta.url);",
  },
});
if (process.argv.includes('--cjs')) {
  await build({ ...common, format: 'cjs', outfile: join(dist, 'agentgpa.cjs') });
}

/** The packages a bundle holds, by name and folder. */
function bundled(meta: Metafile): Map<string, string> {
  const out = new Map<string, string>();
  for (const input of Object.keys(meta.inputs)) {
    const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
    if (m && !m[2]?.startsWith('@agentgpa/'))
      out.set(m[2] as string, join(process.cwd(), m[1] as string));
  }
  return out;
}

const notices: string[] = [];
for (const [name, dir] of [...bundled(esm.metafile)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const file = readdirSync(dir).find((f) => /^(?:licen[cs]e|copying)(?:\.|$)/i.test(f));
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version as string;
  notices.push(
    `${name}@${version}\n\n${file ? readFileSync(join(dir, file), 'utf8').trim() : 'MIT'}\n`,
  );
}
writeFileSync(join(dist, 'THIRD_PARTY_LICENSES.txt'), `${notices.join(`\n${'-'.repeat(72)}\n\n`)}`);
const license = join(here, '../../LICENSE');
if (existsSync(license)) copyFileSync(license, join(dist, 'LICENSE'));
console.log(`built dist/agentgpa.mjs with ${notices.length} bundled packages`);
