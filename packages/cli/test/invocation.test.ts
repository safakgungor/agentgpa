import { describe, expect, it } from 'vitest';
import { invocation, shellWord } from '../src/invocation.ts';

// Every path below is synthetic.

const node = { execPath: '/usr/local/bin/node', sea: false };

describe('the command that starts the CLI again', () => {
  it('is npx at the running version when npx started it', () => {
    const script = '/home/dev/.npm/_npx/0f1e2d3c/node_modules/agentgpa/dist/agentgpa.mjs';
    expect(invocation({ ...node, script }, '1.4.2', 'linux')).toBe('npx -y agentgpa@1.4.2');
    const windows =
      'C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\0f1e\\node_modules\\agentgpa\\dist\\agentgpa.mjs';
    expect(invocation({ ...node, script: windows }, '1.4.2', 'win32')).toBe(
      'npx -y agentgpa@1.4.2',
    );
  });

  it('is the standalone build itself, quoted for the shell when needed', () => {
    const sea = (execPath: string) => ({ script: execPath, execPath, sea: true });
    expect(invocation(sea('/home/dev/Downloads/agentgpa-linux-x64'), '1.4.2', 'linux')).toBe(
      '/home/dev/Downloads/agentgpa-linux-x64',
    );
    expect(invocation(sea('/home/dev/My Files/agentgpa-macos-arm64'), '1.4.2', 'darwin')).toBe(
      `'/home/dev/My Files/agentgpa-macos-arm64'`,
    );
    expect(
      invocation(sea('C:\\Users\\dev\\Downloads\\agentgpa-windows-x64.exe'), '1.4.2', 'win32'),
    ).toBe('C:/Users/dev/Downloads/agentgpa-windows-x64.exe');
    expect(
      invocation(sea('C:\\Users\\Dev User\\Downloads\\agentgpa-windows-x64.exe'), '1.4.2', 'win32'),
    ).toBe('"C:/Users/Dev User/Downloads/agentgpa-windows-x64.exe"');
  });

  it('is node with the script for a local copy', () => {
    expect(
      invocation({ ...node, script: '/home/dev/agentgpa/dist/agentgpa.mjs' }, '0.0.0', 'darwin'),
    ).toBe('node /home/dev/agentgpa/dist/agentgpa.mjs');
  });

  it('quotes any path a shell would split or expand', () => {
    expect(shellWord(`/home/dev/it's here/a.mjs`, 'linux')).toBe(`'/home/dev/it'\\''s here/a.mjs'`);
    expect(shellWord('/home/dev/$HOME/a.mjs', 'darwin')).toBe(`'/home/dev/$HOME/a.mjs'`);
    expect(shellWord('/home/dev/Müzik/a.mjs', 'darwin')).toBe(`'/home/dev/Müzik/a.mjs'`);
    expect(shellWord('C:\\Users\\dev\\a&b\\a.mjs', 'win32')).toBe('"C:/Users/dev/a&b/a.mjs"');
  });
});
