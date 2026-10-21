import { open } from 'node:fs/promises';

/** Lines longer than this are skipped without being decoded or parsed. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

const CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;
const RETURN = 0x0d;

export interface ReadResult {
  bytes: number;
  oversized: number;
}

/**
 * Streams a file line by line, read-only. A line over `maxLineBytes` is dropped while it is
 * read, so a huge line never sits in memory as a string.
 */
export async function readLines(
  path: string,
  onLine: (line: string) => void,
  maxLineBytes = MAX_LINE_BYTES,
): Promise<ReadResult> {
  const file = await open(path, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK);
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let skipping = false;
  let oversized = 0;
  let bytes = 0;

  const decode = (source: Buffer, start: number, end: number): void => {
    const stop = end > start && source[end - 1] === RETURN ? end - 1 : end;
    if (stop > start) onLine(source.toString('utf8', start, stop));
  };

  try {
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      let start = 0;
      for (
        let i = buffer.indexOf(NEWLINE, 0);
        i !== -1 && i < bytesRead;
        i = buffer.indexOf(NEWLINE, i + 1)
      ) {
        if (skipping) skipping = false;
        else if (pendingBytes + (i - start) > maxLineBytes) oversized++;
        else if (pendingBytes === 0) decode(buffer, start, i);
        else {
          const line = Buffer.concat([...pending, buffer.subarray(start, i)]);
          decode(line, 0, line.length);
        }
        pending = [];
        pendingBytes = 0;
        start = i + 1;
      }
      if (start < bytesRead && !skipping) {
        if (pendingBytes + (bytesRead - start) > maxLineBytes) {
          oversized++;
          skipping = true;
          pending = [];
          pendingBytes = 0;
        } else {
          // The buffer is reused for the next chunk, so the tail is copied.
          pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
          pendingBytes += bytesRead - start;
        }
      }
    }
    if (pendingBytes > 0 && !skipping) {
      const line = Buffer.concat(pending);
      decode(line, 0, line.length);
    }
  } finally {
    await file.close();
  }
  return { bytes, oversized };
}
