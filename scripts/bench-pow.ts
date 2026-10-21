// Times the CLI's proof-of-work solver on a hard 22-bit challenge: 2.8 times the average work.
// The budget is 5 seconds on a five-year-old laptop, taken as 4 threads; a machine with fewer
// threads gets proportionally longer. CI runs this on its own, after the tests.
//
//   node scripts/bench-pow.ts
import { availableParallelism } from 'node:os';
import { answers, solvePow } from '../packages/cli/src/pow.ts';

const threads = availableParallelism();
const BUDGET_MS = Math.round(5000 * Math.max(1, 4 / threads));
const prefix = 'agentgpa-benchmark-prefix-0004';
const started = performance.now();
const nonce = await solvePow({
  algorithm: 'sha256',
  prefix,
  difficulty: 22,
  expiresAt: new Date().toISOString(),
  challenge: 'signed-challenge-0003',
});
const ms = Math.round(performance.now() - started);
const ok = answers(prefix, 22, nonce);
console.log(`bench-pow: 22 bits in ${ms} ms with ${threads} threads (budget ${BUDGET_MS} ms)`);
if (!ok || ms > BUDGET_MS) {
  console.error(ok ? `bench-pow: over the ${BUDGET_MS} ms budget` : 'bench-pow: wrong answer');
  process.exitCode = 1;
}
