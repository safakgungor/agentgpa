import { hash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { type PowChallenge, powInput } from '@agentgpa/core';

// Solves the server's proof-of-work challenge: a nonce whose SHA-256 of `prefix:nonce` starts
// with enough zero bits. The search is plain JavaScript that hashes the prefix once and then only
// the last block or two for each nonce, about twice as fast as a node:crypto call per nonce.
// Hard challenges split across worker threads, so a 22-bit one stays a few seconds on an old
// laptop. Every answer is checked with node:crypto before it is used.

function meets(digest: Uint8Array, bits: number): boolean {
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (digest[i] !== 0) return false;
  const rest = bits & 7;
  return rest === 0 || ((digest[full] as number) & ((0xff << (8 - rest)) & 0xff)) === 0;
}

/** Whether a nonce answers the challenge, checked with node:crypto. */
export const answers = (prefix: string, bits: number, nonce: number): boolean =>
  meets(hash('sha256', powInput(prefix, nonce), 'buffer'), bits);

/**
 * The first nonce from `start`, stepping by `step`, whose SHA-256 of `prefix:nonce` starts with
 * `bits` zero bits (at most 32), or -1 after `limit` tries. It uses no outside names, because
 * the workers run its source text.
 */
export function searchNonce(
  prefix: string,
  bits: number,
  start: number,
  step: number,
  limit: number,
): number {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ].map((k) => k | 0);
  const w = new Int32Array(64);
  // One SHA-256 compression of the 64 bytes at `src[off]` into the state `h`.
  function compress(h: Int32Array, src: Uint8Array, off: number): void {
    for (let i = 0; i < 16; i++) {
      const o = off + i * 4;
      w[i] =
        ((src[o] as number) << 24) |
        ((src[o + 1] as number) << 16) |
        ((src[o + 2] as number) << 8) |
        (src[o + 3] as number);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let k = h[7] as number;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + s1 + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0;
    h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0;
    h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0;
    h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0;
    h[7] = ((h[7] as number) + k) | 0;
  }

  // The prefix's whole blocks are hashed once; each nonce only adds the rest.
  const fixed = new TextEncoder().encode(`${prefix}:`);
  const whole = Math.floor(fixed.length / 64);
  const mid = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  for (let i = 0; i < whole; i++) compress(mid, fixed, i * 64);
  const tail = fixed.length - whole * 64;
  const block = new Uint8Array(192);
  block.set(fixed.subarray(whole * 64));
  const state = new Int32Array(8);
  const mask = bits >= 32 ? -1 : ~(-1 >>> bits);
  // The nonce's decimal digits, as character codes, stepped in place.
  const digits = Array.from(String(start), (ch) => ch.charCodeAt(0));
  let nonce = start;
  for (let n = 0; n < limit; n++) {
    let end = tail;
    for (const digit of digits) block[end++] = digit;
    block[end++] = 0x80;
    const blocks = end + 8 <= 64 ? 1 : end + 8 <= 128 ? 2 : 3;
    const last = blocks * 64;
    block.fill(0, end, last - 4);
    const length = (fixed.length + digits.length) * 8;
    block[last - 4] = length >>> 24;
    block[last - 3] = (length >>> 16) & 0xff;
    block[last - 2] = (length >>> 8) & 0xff;
    block[last - 1] = length & 0xff;
    state.set(mid);
    for (let i = 0; i < blocks; i++) compress(state, block, i * 64);
    if (((state[0] as number) & mask) === 0) return nonce;
    nonce += step;
    let carry = step;
    for (let i = digits.length - 1; carry > 0; i--) {
      if (i < 0) {
        digits.unshift(48);
        i = 0;
      }
      const sum = (digits[i] as number) - 48 + carry;
      digits[i] = 48 + (sum % 10);
      carry = Math.floor(sum / 10);
    }
  }
  return -1;
}

/** The first nonce from `start`, stepping by `step`, that answers the challenge. */
export function solveInline(prefix: string, bits: number, start = 0, step = 1): number {
  const nonce = searchNonce(prefix, bits, start, step, Number.POSITIVE_INFINITY);
  if (answers(prefix, bits, nonce)) return nonce;
  // Never expected: fall back to node:crypto for every nonce.
  for (let n = start; ; n += step) if (answers(prefix, bits, n)) return n;
}

// The same search, as a worker: each worker takes every n-th nonce.
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const searchNonce = (${searchNonce.toString()});
const { prefix, bits, start, step } = workerData;
parentPort.postMessage(searchNonce(prefix, bits, start, step, Number.POSITIVE_INFINITY));
`;

/** Easy challenges stay on the main thread. */
const INLINE_BITS = 18;

export async function solvePow(challenge: PowChallenge, workers?: number): Promise<number> {
  const { prefix, difficulty } = challenge;
  // The CLI waits for the answer and does nothing else, so every core can help.
  const count = workers ?? Math.max(1, Math.min(8, availableParallelism()));
  if (difficulty <= INLINE_BITS || count <= 1) return solveInline(prefix, difficulty);
  const nonce = await new Promise<number>((resolve, reject) => {
    let done = false;
    const pool = Array.from(
      { length: count },
      (_, k) =>
        new Worker(WORKER, {
          eval: true,
          workerData: { prefix, bits: difficulty, start: k, step: count },
        }),
    );
    const finish = (result: () => void) => {
      if (done) return;
      done = true;
      for (const w of pool) void w.terminate();
      result();
    };
    for (const w of pool) {
      w.on('message', (found: number) => finish(() => resolve(found)));
      w.on('error', (error) => finish(() => reject(error)));
    }
  });
  return answers(prefix, difficulty, nonce) ? nonce : solveInline(prefix, difficulty);
}
