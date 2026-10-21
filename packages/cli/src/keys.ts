// Single key presses for the interactive screens: raw mode on a terminal, a fixed list in
// tests. Nothing here reads anything but the keys the user presses.

export interface KeyReader {
  /** The next key, or undefined when input has ended. */
  next(): Promise<string | undefined>;
  close(): void;
}

/** Keys from a terminal in raw mode; `undefined` when stdin is not a terminal. */
export function terminalKeys(stdin: NodeJS.ReadStream = process.stdin): KeyReader | undefined {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return undefined;
  const queue: string[] = [];
  const waiting: ((key: string | undefined) => void)[] = [];
  let ended = false;
  const onData = (chunk: string) => {
    // A paste or an escape sequence arrives as one chunk: keep its first character only.
    const key = chunk.startsWith('\u001b[') ? '\u001b' : chunk.slice(0, 1);
    const resolve = waiting.shift();
    if (resolve) resolve(key);
    else queue.push(key);
  };
  const onEnd = () => {
    ended = true;
    for (const resolve of waiting.splice(0)) resolve(undefined);
  };
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.resume();
  return {
    next: () => {
      const key = queue.shift();
      if (key !== undefined) return Promise.resolve(key);
      if (ended) return Promise.resolve(undefined);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.setRawMode(false);
      stdin.pause();
    },
  };
}

/** Keys from a list, for tests. */
export function scriptedKeys(keys: readonly string[]): KeyReader {
  const queue = [...keys];
  return { next: () => Promise.resolve(queue.shift()), close: () => {} };
}

export const CTRL_C = '\u0003';
export const ESCAPE = '\u001b';
export const ENTER = ['\r', '\n'];
