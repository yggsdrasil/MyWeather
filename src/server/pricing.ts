import { config } from "./config.js";

/** USD price per 1,000,000 tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * Standard (non-cached, non-batch) API rates per million tokens, USD.
 * Source: Anthropic & OpenAI published pricing (verified mid-2026). These are
 * estimates for display; override per deployment via LLM_PRICE_INPUT /
 * LLM_PRICE_OUTPUT if your contract differs.
 */
const PRICE_TABLE: Record<string, ModelPrice> = {
  // Anthropic
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5": { input: 10, output: 50 },
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
};

/** Looks up the per-million-token price for a model id (with fuzzy matching). */
export function priceForModel(model: string): ModelPrice | undefined {
  // Explicit env override always wins.
  if (config.llm.priceInput !== undefined && config.llm.priceOutput !== undefined) {
    return { input: config.llm.priceInput, output: config.llm.priceOutput };
  }
  if (PRICE_TABLE[model]) return PRICE_TABLE[model];

  // Strip a trailing date snapshot (e.g. claude-haiku-4-5-20251001) or alias.
  const normalized = model
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "")
    .replace(/-fast$/, "");
  if (PRICE_TABLE[normalized]) return PRICE_TABLE[normalized];

  // Prefix match (longest first) as a last resort.
  const keys = Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length);
  const hit = keys.find((k) => normalized.startsWith(k));
  return hit ? PRICE_TABLE[hit] : undefined;
}

export interface CostEstimate {
  inputUSD: number;
  outputUSD: number;
  totalUSD: number;
  /** Per-million rates used, for transparency. */
  rates: ModelPrice;
  /** Always true — these are list-price estimates, not billed amounts. */
  estimated: true;
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate | null {
  const price = priceForModel(model);
  if (!price) return null;
  const inputUSD = (inputTokens / 1_000_000) * price.input;
  const outputUSD = (outputTokens / 1_000_000) * price.output;
  return {
    inputUSD,
    outputUSD,
    totalUSD: inputUSD + outputUSD,
    rates: price,
    estimated: true,
  };
}
