// List prices in USD per million tokens, from the providers' pricing pages on the date below.
// Costs are always labelled "estimated at list API prices". A model that is not listed is
// left out of the cost and counted, so the estimate never invents a price.

export const PRICES_AS_OF = '2026-10-19';

export interface Price {
  input: number;
  /** Writing to the prompt cache (5-minute cache for Claude; 0 where the provider has none). */
  cacheWrite: number;
  /** Reading from the prompt cache. */
  cacheRead: number;
  output: number;
}

const p = (input: number, cacheWrite: number, cacheRead: number, output: number): Price => ({
  input,
  cacheWrite,
  cacheRead,
  output,
});

/** Claude models by id prefix (platform.claude.com/docs/en/about-claude/pricing). */
const CLAUDE: Record<string, Price> = {
  'claude-fable-5-1': p(10, 12.5, 0.25, 50),
  'claude-fable-5': p(10, 12.5, 1, 50),
  'claude-mythos-5-1': p(10, 12.5, 0.25, 50),
  'claude-mythos-5': p(10, 12.5, 1, 50),
  'claude-opus-5-5': p(4, 5, 0.2, 20),
  'claude-opus-5': p(5, 6.25, 0.5, 25),
  'claude-opus-4-8': p(5, 6.25, 0.5, 25),
  'claude-opus-4-7': p(5, 6.25, 0.5, 25),
  'claude-opus-4-6': p(5, 6.25, 0.5, 25),
  'claude-opus-4-5': p(5, 6.25, 0.5, 25),
  'claude-opus-4-1': p(15, 18.75, 1.5, 75),
  'claude-opus-4': p(15, 18.75, 1.5, 75),
  'claude-sonnet-5-5': p(2, 2.5, 0.1, 10),
  'claude-sonnet-5': p(2, 2.5, 0.2, 10),
  'claude-sonnet-4-6': p(3, 3.75, 0.3, 15),
  'claude-sonnet-4-5': p(3, 3.75, 0.3, 15),
  'claude-sonnet-4': p(3, 3.75, 0.3, 15),
  // Haiku 5.5 costs more for prompts over 100,000 tokens; the lower price keeps the estimate a floor.
  'claude-haiku-5-5': p(0.1, 0.125, 0.01, 0.5),
  'claude-haiku-4-5': p(1, 1.25, 0.1, 5),
  'claude-3-5-haiku': p(0.8, 1, 0.08, 4),
};

/** OpenAI models by exact id (developers.openai.com/api/docs/pricing, standard tier). */
const OPENAI: Record<string, Price> = {
  'gpt-5': p(1.25, 0, 0.125, 10),
  'gpt-5-mini': p(0.25, 0, 0.025, 2),
  'gpt-5-nano': p(0.05, 0, 0.005, 0.4),
  'gpt-5.1': p(1.25, 0, 0.125, 10),
  'gpt-5.2': p(1.75, 0, 0.175, 14),
  'gpt-5.3-codex': p(1.75, 0, 0.175, 14),
  'gpt-5.4': p(2.5, 0, 0.25, 15),
  'gpt-5.4-mini': p(0.75, 0, 0.075, 4.5),
  'gpt-5.4-nano': p(0.2, 0, 0.02, 1.25),
  'gpt-5.5': p(5, 0, 0.5, 30),
  'gpt-5.6-luna': p(0.2, 0, 0.02, 1.2),
  'gpt-5.6-sol': p(4, 0, 0.4, 20),
  'gpt-5.6-terra': p(2, 0, 0.2, 12),
};

const CLAUDE_PREFIXES = Object.keys(CLAUDE).sort((a, b) => b.length - a.length);

/** The list price of a model, or undefined when it is not listed. */
export function priceOf(model: string | undefined): Price | undefined {
  if (!model) return undefined;
  if (Object.hasOwn(OPENAI, model)) return OPENAI[model];
  const prefix = CLAUDE_PREFIXES.find((key) => model === key || model.startsWith(`${key}-`));
  return prefix ? CLAUDE[prefix] : undefined;
}

/** USD for one model call, or undefined for a model without a list price. */
export function costOf(
  model: string | undefined,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number | undefined {
  const price = priceOf(model);
  if (!price) return undefined;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}
