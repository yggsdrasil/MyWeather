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
  /** Optional USD-per-1M-token price overrides for cost estimates. */
  priceInput?: number;
  priceOutput?: number;
}

export type ServerKind = "mcp" | "reactor";

/** Credentials/config for the Adobe Launch (Reactor) REST API connection. */
export interface ReactorConfig {
  /** Reactor API base URL. */
  baseUrl: string;
  /** Adobe IMS base URL used to mint server-to-server tokens. */
  imsBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional static access token (used as-is until it expires). */
  accessToken: string;
  /** IMS org id (e.g. ...@AdobeOrg). Derived from the token when omitted. */
  orgId: string;
  /** OAuth scopes requested when minting tokens from client credentials. */
  scopes: string;
  /** Optional Reactor company id to scope property listings. */
  companyId: string;
  /** Optional tenant name, for display. */
  tenant: string;
}

export interface McpServerConfig {
  /** Stable identifier used in URLs, storage filenames, and the UI. */
  id: string;
  /** Human-friendly name shown in the UI. */
  label: string;
  /** Short product tag used to namespace tools for the assistant. */
  shortTag: string;
  /** Connection kind: a remote MCP server, or the Adobe Launch Reactor API. */
  kind: ServerKind;
  /** The MCP server endpoint (kind === "mcp"). */
  url: string;
  /** OAuth redirect URI for this server (must be unique per server). */
  redirectUrl: string;
  /** Reactor REST API config (kind === "reactor"). */
  reactor?: ReactorConfig;
}

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  /** All configured Adobe MCP servers (Target, Analytics, …). */
  servers: McpServerConfig[];
  /** Directory used to persist OAuth tokens + client registration. */
  dataDir: string;
  /** AI assistant (LLM) configuration. */
  llm: LlmConfig;
}

/** Builds the Adobe Launch server definition, choosing Reactor API vs MCP. */
function resolveLaunchServer():
  | (Omit<McpServerConfig, "redirectUrl"> & { url: string })
  | null {
  const accessToken = process.env.LAUNCH_ACCESS_TOKEN ?? "";
  const clientId = process.env.LAUNCH_CLIENT_ID ?? "";
  const clientSecret = process.env.LAUNCH_CLIENT_SECRET ?? "";
  const useReactor = Boolean(accessToken || (clientId && clientSecret));

  if (useReactor) {
    const reactor: ReactorConfig = {
      baseUrl: (process.env.LAUNCH_REACTOR_URL ?? "https://reactor.adobe.io").replace(
        /\/+$/,
        "",
      ),
      imsBaseUrl: (
        process.env.ADOBE_IMS_BASE_URL ?? "https://ims-na1.adobelogin.com"
      ).replace(/\/+$/, ""),
      clientId,
      clientSecret,
      accessToken,
      orgId: process.env.LAUNCH_ORG_ID ?? "",
      scopes:
        process.env.LAUNCH_SCOPES ??
        "openid, AdobeID, read_organizations, additional_info.projectedProductContext, additional_info.roles",
      companyId: process.env.LAUNCH_COMPANY_ID ?? "",
      tenant: process.env.LAUNCH_TENANT ?? "",
    };
    return {
      id: "launch",
      label: "Adobe Launch",
      shortTag: "launch",
      kind: "reactor",
      url: reactor.baseUrl,
      reactor,
    };
  }

  // Fall back to MCP mode (no public Launch MCP endpoint exists yet).
  const url = process.env.LAUNCH_MCP_URL ?? "https://launch-mcp.adobe.io/mcp";
  return { id: "launch", label: "Adobe Launch", shortTag: "launch", kind: "mcp", url };
}

function resolveServers(): McpServerConfig[] {
  const defs: Array<Omit<McpServerConfig, "redirectUrl"> & { url: string }> = [
    {
      id: "target",
      label: "Adobe Target",
      shortTag: "target",
      kind: "mcp",
      url: process.env.TARGET_MCP_URL ?? "https://targetmcp.adobe.io/mcp",
    },
    {
      id: "analytics",
      label: "Adobe Analytics",
      shortTag: "analytics",
      kind: "mcp",
      url: process.env.ANALYTICS_MCP_URL ?? "https://aa-mcp.adobe.io/mcp",
    },
  ];

  const launch = resolveLaunchServer();
  if (launch) defs.push(launch);

  return defs
    .filter((d) => d.url && d.url.toLowerCase() !== "off")
    .map((d) => ({
      ...d,
      redirectUrl: `${publicBaseUrl}/oauth/callback/${d.id}`,
    }));
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
    provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o";
  const defaultBaseUrl =
    provider === "anthropic"
      ? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1"
      : process.env.OPENAI_BASE_URL ??
        process.env.LLM_BASE_URL ??
        "https://api.openai.com/v1";

  const priceInput = process.env.LLM_PRICE_INPUT
    ? Number.parseFloat(process.env.LLM_PRICE_INPUT)
    : undefined;
  const priceOutput = process.env.LLM_PRICE_OUTPUT
    ? Number.parseFloat(process.env.LLM_PRICE_OUTPUT)
    : undefined;

  return {
    enabled: Boolean(apiKey),
    provider,
    model: process.env.LLM_MODEL ?? defaultModel,
    apiKey,
    baseUrl: (process.env.LLM_BASE_URL ?? defaultBaseUrl).replace(/\/+$/, ""),
    maxSteps: Number.parseInt(process.env.LLM_MAX_STEPS ?? "10", 10),
    maxTokens: Number.parseInt(process.env.LLM_MAX_TOKENS ?? "2048", 10),
    priceInput: Number.isFinite(priceInput) ? priceInput : undefined,
    priceOutput: Number.isFinite(priceOutput) ? priceOutput : undefined,
  };
}

export const config: AppConfig = {
  port,
  publicBaseUrl,
  servers: resolveServers(),
  dataDir: resolveFromRoot(process.env.DATA_DIR ?? ".data"),
  llm: resolveLlmConfig(),
};
