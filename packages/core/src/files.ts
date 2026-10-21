// Facts about a file the agent touched, decided on the device from its path. Only these facts
// leave: a language category index and a sensitive-file bit. The path itself never does.

/**
 * Language categories of edited files, by extension. The skeleton stores an index into this
 * list, so entries are only ever appended.
 */
export const LANG_CATEGORIES = [
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
  'dart',
  'scala',
  'elixir',
  'haskell',
  'lua',
  'r',
  'web',
  'shell',
  'sql',
  'data',
  'docs',
  'notebook',
  'infra',
] as const;

export type LangCategory = (typeof LANG_CATEGORIES)[number];

const EXTENSIONS: Record<LangCategory, string[]> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  python: ['py', 'pyi', 'pyw'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  c: ['c', 'h', 'm'],
  cpp: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'mm'],
  csharp: ['cs', 'csx'],
  ruby: ['rb', 'rake', 'gemspec'],
  php: ['php'],
  dart: ['dart'],
  scala: ['scala', 'sc'],
  elixir: ['ex', 'exs'],
  haskell: ['hs'],
  lua: ['lua'],
  r: ['r'],
  web: ['html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro'],
  shell: ['sh', 'bash', 'zsh', 'fish', 'ps1'],
  sql: ['sql'],
  data: ['json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'csv', 'ini'],
  docs: ['md', 'mdx', 'rst', 'txt', 'adoc'],
  notebook: ['ipynb'],
  infra: ['tf', 'hcl', 'nix'],
};

const BY_EXTENSION = new Map<string, number>();
LANG_CATEGORIES.forEach((category, i) => {
  for (const ext of EXTENSIONS[category]) BY_EXTENSION.set(ext, i);
});

function basename(path: string): string {
  const parts = path.trim().split(/[/\\]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** The language category index of a file, from its extension, or -1. */
export function langCategoryOf(path: string): number {
  const name = basename(path);
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) {
    return LANG_CATEGORIES.indexOf('infra');
  }
  const dot = name.lastIndexOf('.');
  return dot < 0 ? -1 : (BY_EXTENSION.get(name.slice(dot + 1)) ?? -1);
}

const SENSITIVE_NAMES = new Set([
  'credentials',
  'credentials.json',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.git-credentials',
  '.dockercfg',
  '.htpasswd',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
]);
const SENSITIVE_PATTERNS = [
  /^\.env(?:\.(?!example$|sample$|template$|dist$|defaults?$)[\w.-]+)?$/,
  /\.(?:pem|key|p12|pfx|keystore|jks|ppk|asc|gpg)$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?!.*\.pub$)/,
  /^(?:client_secret|service[-_]account)[\w.-]*\.json$/,
];

/** An env, key or credential file: reading it can hand secrets to the agent. */
export function isSensitiveFile(path: string): boolean {
  const name = basename(path);
  return SENSITIVE_NAMES.has(name) || SENSITIVE_PATTERNS.some((rule) => rule.test(name));
}

/** True when a shell command names a sensitive file (`cat .env`, `source ~/.aws/credentials`). */
export function touchesSensitiveFile(command: string): boolean {
  return command
    .split(/[\s;&|<>()'"`]+/)
    .some((token) => token.length > 0 && !token.startsWith('-') && isSensitiveFile(token));
}
