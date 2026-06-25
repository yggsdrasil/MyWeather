import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { config, type McpServerConfig } from "./config.js";
import { logger } from "./logger.js";
import { AdobeImsOAuthProvider } from "./oauthProvider.js";
import { groupToolsByCategory, type RawTool, type ToolCatalogGroup } from "./toolCatalog.js";
import { ReactorClientManager } from "./reactorClient.js";
import {
  ConnectionRequiredError,
  type ConnectResult,
  type ConnectionStatus,
  type ServerManager,
} from "./serverManager.js";

export { ConnectionRequiredError };
export type { ConnectResult, ConnectionStatus, ServerManager };
export type { RawTool, ToolCatalogGroup } from "./toolCatalog.js";

const CLIENT_INFO = {
  name: "adobe-mcp-client",
  version: "1.0.0",
};

/**
 * Manages a single long-lived connection to one Adobe MCP server (Target,
 * Analytics, …), including the OAuth authorization lifecycle.
 */
export class McpClientManager implements ServerManager {
  readonly id: string;
  readonly label: string;
  private readonly authProvider: AdobeImsOAuthProvider;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private connected = false;
  private serverInfo: { name?: string; version?: string } | undefined;
  private cachedToolCount: number | undefined;

  constructor(private readonly server: McpServerConfig) {
    this.id = server.id;
    this.label = server.label;
    this.authProvider = new AdobeImsOAuthProvider(server);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private buildTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(this.server.url), {
      authProvider: this.authProvider,
    });
  }

  /**
   * Attempts to (re)connect to the MCP server. If authorization is required,
   * returns an authorization URL instead of throwing.
   */
  async connect(): Promise<ConnectResult> {
    if (this.connected && this.client) {
      return { connected: true };
    }

    this.authProvider.clearPendingAuthorization();
    this.client = new Client(CLIENT_INFO, { capabilities: {} });
    this.transport = this.buildTransport();

    try {
      await this.client.connect(this.transport);
      this.connected = true;
      this.serverInfo = this.client.getServerVersion();
      logger.info(`[${this.id}] Connected to ${this.label} MCP server`, this.serverInfo);
      await this.refreshToolCount();
      return { connected: true };
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        const authUrl = this.authProvider.pendingAuthorizationUrl;
        if (authUrl) {
          logger.info(`[${this.id}] OAuth authorization required to continue`);
          return { connected: false, authorizationUrl: authUrl.toString() };
        }
      }
      this.connected = false;
      throw this.friendlyConnectError(err);
    }
  }

  /** Wraps low-level network errors with a clearer, server-scoped message. */
  private friendlyConnectError(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause
        ? String((err.cause as { code?: string }).code ?? err.cause)
        : "";
    const unreachable =
      /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|certificate/i.test(
        `${msg} ${cause}`,
      );
    if (unreachable) {
      return new Error(
        `Could not reach the ${this.label} MCP server at ${this.server.url}. ` +
          `The endpoint may not be available yet — set its URL via an env var ` +
          `(e.g. LAUNCH_MCP_URL) to the correct address, or set it to "off" to hide it. ` +
          `(${cause || msg})`,
      );
    }
    return err instanceof Error ? err : new Error(msg);
  }

  /**
   * Completes the OAuth authorization code exchange after the browser returns
   * to the redirect URL, then establishes the authenticated connection.
   */
  async finishAuth(authorizationCode: string): Promise<ConnectResult> {
    if (!this.transport) {
      // A restart may have lost the in-memory transport; rebuild it. The PKCE
      // verifier and client registration are persisted, so this still works.
      this.transport = this.buildTransport();
    }
    await this.transport.finishAuth(authorizationCode);
    logger.info(`[${this.id}] OAuth token exchange completed`);

    // Establish a fresh authenticated session now that tokens are stored.
    this.connected = false;
    this.client = undefined;
    this.transport = undefined;
    return this.connect();
  }

  private async refreshToolCount(): Promise<void> {
    try {
      const { tools } = await this.requireClient().listTools();
      this.cachedToolCount = tools.length;
    } catch (err) {
      logger.warn(`[${this.id}] Unable to pre-fetch tool count`, err);
    }
  }

  private requireClient(): Client {
    if (!this.client || !this.connected) {
      throw new ConnectionRequiredError(
        `Not connected to the ${this.label} MCP server`,
      );
    }
    return this.client;
  }

  /** Returns the raw, flat tool list (name/description/inputSchema). */
  async getRawTools(): Promise<RawTool[]> {
    const { tools } = await this.requireClient().listTools();
    this.cachedToolCount = tools.length;
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
  }

  async listTools(): Promise<ToolCatalogGroup[]> {
    const tools = await this.getRawTools();
    return groupToolsByCategory(tools);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.requireClient().callTool({ name, arguments: args });
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (err) {
        logger.warn(`[${this.id}] Error while closing transport`, err);
      }
    }
    this.client = undefined;
    this.transport = undefined;
    this.connected = false;
    this.serverInfo = undefined;
    this.cachedToolCount = undefined;
  }

  /** Disconnects and clears all stored OAuth credentials. */
  async logout(): Promise<void> {
    await this.disconnect();
    this.authProvider.reset();
  }

  status(): ConnectionStatus {
    return {
      id: this.id,
      label: this.label,
      kind: "mcp",
      connected: this.connected,
      hasCredentials: this.authProvider.hasTokens(),
      serverUrl: this.server.url,
      authMode: "OAuth (browser sign-in)",
      serverInfo: this.serverInfo,
      toolCount: this.cachedToolCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry of all configured servers
// ---------------------------------------------------------------------------

const managers = new Map<string, ServerManager>();
for (const server of config.servers) {
  managers.set(
    server.id,
    server.kind === "reactor"
      ? new ReactorClientManager(server)
      : new McpClientManager(server),
  );
}

export function getManager(id: string): ServerManager | undefined {
  return managers.get(id);
}

export function allManagers(): ServerManager[] {
  return Array.from(managers.values());
}

export function connectedManagers(): ServerManager[] {
  return allManagers().filter((m) => m.isConnected);
}

export function allStatuses(): ConnectionStatus[] {
  return allManagers().map((m) => m.status());
}

// ---------------------------------------------------------------------------
// Cross-server tool aggregation (used by the AI assistant)
// ---------------------------------------------------------------------------

interface ToolRoute {
  managerId: string;
  originalName: string;
}

/** Maps the (possibly namespaced) tool name exposed to the LLM back to a server. */
let toolRouting = new Map<string, ToolRoute>();

/**
 * Aggregates tools from every connected server. Tool names are normally kept
 * as-is; on a name collision across servers, later ones are namespaced with
 * their server tag (e.g. `analytics__get_report`).
 */
export async function aggregatedTools(): Promise<RawTool[]> {
  const routing = new Map<string, ToolRoute>();
  const seen = new Set<string>();
  const out: RawTool[] = [];

  for (const manager of connectedManagers()) {
    let tools: RawTool[];
    try {
      tools = await manager.getRawTools();
    } catch (err) {
      logger.warn(`[${manager.id}] Failed to list tools for assistant`, err);
      continue;
    }
    for (const tool of tools) {
      const exposedName = seen.has(tool.name)
        ? `${manager.id}__${tool.name}`
        : tool.name;
      seen.add(exposedName);
      routing.set(exposedName, { managerId: manager.id, originalName: tool.name });
      out.push({
        name: exposedName,
        description: `[${manager.label}] ${tool.description}`.trim(),
        inputSchema: tool.inputSchema,
      });
    }
  }

  toolRouting = routing;
  return out;
}

/** Calls an aggregated (possibly namespaced) tool on its owning server. */
export async function callAggregatedTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const route = toolRouting.get(name);
  if (route) {
    const manager = getManager(route.managerId);
    if (!manager) throw new Error(`Unknown MCP server: ${route.managerId}`);
    return manager.callTool(route.originalName, args);
  }

  // Fallbacks: strip a "<serverId>__" prefix, or search connected servers.
  for (const manager of connectedManagers()) {
    const prefix = `${manager.id}__`;
    if (name.startsWith(prefix)) {
      return manager.callTool(name.slice(prefix.length), args);
    }
  }
  for (const manager of connectedManagers()) {
    try {
      return await manager.callTool(name, args);
    } catch (err) {
      if (err instanceof ConnectionRequiredError) continue;
      throw err;
    }
  }
  throw new Error(`No connected server exposes a tool named "${name}"`);
}
