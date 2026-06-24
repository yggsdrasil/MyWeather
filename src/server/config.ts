import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the project root (two levels up from dist/server or src/server). */
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

const port = Number.parseInt(process.env.PORT ?? "4321", 10);
const publicBaseUrl = (
  process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`
).replace(/\/+$/, "");

export type LlmProviderId = "anthropic" | "openai";

export interface LlmConfig {
  /** Whether an API key is configured and the assistant can be used. */
  enabled: boolean;
  provider: LlmProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** Max agent reasoning/tool-call iterations per user message. */
  maxSteps: number;
  maxTokens: number;
}

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  /** OAuth redirect URI registered with Adobe IMS via the MCP auth flow. */
  redirectUrl: string;
  /** Adobe Target MCP server endpoint. */
  targetMcpUrl: string;
  /** Directory used to persist OAuth tokens + client registration. */
  dataDir: string;
  /** AI assistant (LLM) configuration. */
  llm: LlmConfig;
}

function resolveLlmConfig(): LlmConfig {
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  const openaiKey = process.env.OPENAI_API_KEY ?? "";
  const genericKey = process.env.LLM_API_KEY ?? "";

  // Pick a provider: explicit override, else infer from whichever key exists.
  let provider = (process.env.LLM_PROVIDER ?? "").toLowerCase() as LlmProviderId;
  if (provider !== "anthropic" && provider !== "openai") {
    provider = anthropicKey ? "anthropic" : openaiKey ? "openai" : "anthropic";
  }

  const apiKey =
    genericKey || (provider === "anthropic" ? anthropicKey : openaiKey);

  const defaultModel =
    provider === "anthropic" ? "claude-3-7-sonnet-latest" : "gpt-4o";
  const defaultBaseUrl =
    provider === "anthropic"
      ? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1"
      : process.env.OPENAI_BASE_URL ??
        process.env.LLM_BASE_URL ??
        "https://api.openai.com/v1";

  return {
    enabled: Boolean(apiKey),
    provider,
    model: process.env.LLM_MODEL ?? defaultModel,
    apiKey,
    baseUrl: (process.env.LLM_BASE_URL ?? defaultBaseUrl).replace(/\/+$/, ""),
    maxSteps: Number.parseInt(process.env.LLM_MAX_STEPS ?? "10", 10),
    maxTokens: Number.parseInt(process.env.LLM_MAX_TOKENS ?? "2048", 10),
  };
}

export const config: AppConfig = {
  port,
  publicBaseUrl,
  redirectUrl: `${publicBaseUrl}/oauth/callback`,
  targetMcpUrl: process.env.TARGET_MCP_URL ?? "https://targetmcp.adobe.io/mcp",
  dataDir: resolveFromRoot(process.env.DATA_DIR ?? ".data"),
  llm: resolveLlmConfig(),
};
