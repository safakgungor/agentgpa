import { spawn } from 'node:child_process';
import { OPENABLE_PATH } from '@agentgpa/core';
import type { Origin } from './net.ts';

// The CLI's only subprocess: the system's own opener, given a report page on the API origin
// whose path matches a fixed pattern. Over SSH, or when no opener starts, the URL is printed.

/** The URL as the CLI may open it, or undefined when it is not a report page on the origin. */
export function reportUrl(raw: string, origin: Origin): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw, origin.url);
  } catch {
    return undefined;
  }
  if (url.origin !== origin.url.origin || url.search || url.hash || url.username || url.password)
    return undefined;
  return OPENABLE_PATH.test(url.pathname) ? url : undefined;
}

/** Opens the page in the default browser; false when it cannot. */
export function openInBrowser(
  url: URL,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.CI) return false;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url.href]]
      : platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url.href]]
        : ['xdg-open', [url.href]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
