import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { config, type McpServerConfig } from "./config.js";
import { logger } from "./logger.js";
import { AdobeImsOAuthProvider } from "./oauthProvider.js";
import { categorizeTool, CATEGORIES, type ToolCategory } from "./toolCatalog.js";

export interface ConnectResult {
  connected: boolean;
  /** When set, the browser must visit this URL to authorize with Adobe IMS. */
  authorizationUrl?: string;
}

export interface ConnectionStatus {
  id: string;
  label: string;
  connected: boolean;
  hasCredentials: boolean;
  serverUrl: string;
  serverInfo?: { name?: string; version?: string };
  toolCount?: number;
}

export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: unknown;
  category: ToolCategory;
}

export interface ToolCatalogGroup {
  category: ToolCategory;
  tools: CatalogTool[];
}

export interface RawTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

const CLIENT_INFO = {
  name: "adobe-mcp-client",
  version: "1.0.0",
};

/** Thrown for expected "you must connect first" conditions (HTTP 409). */
export class ConnectionRequiredError extends Error {
  constructor(message = "Not connected to this Adobe MCP server") {
    super(message);
    this.name = "ConnectionRequiredError";
  }
}

/**
 * Manages a single long-lived connection to one Adobe MCP server (Target,
 * Analytics, …), including the OAuth authorization lifecycle.
 */
export class McpClientManager {
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
      throw err;
    }
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

    const grouped = new Map<string, CatalogTool[]>();
    for (const tool of tools) {
      const category = categorizeTool(tool.name);
      const entry: CatalogTool = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        category,
      };
      const list = grouped.get(category.id) ?? [];
      list.push(entry);
      grouped.set(category.id, list);
    }

    return Array.from(grouped.entries())
      .map(([id, catTools]) => ({
        category: CATEGORIES[id] ?? CATEGORIES.other,
        tools: catTools.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.category.order - b.category.order);
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
      connected: this.connected,
      hasCredentials: this.authProvider.hasTokens(),
      serverUrl: this.server.url,
      serverInfo: this.serverInfo,
      toolCount: this.cachedToolCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry of all configured servers
// ---------------------------------------------------------------------------

const managers = new Map<string, McpClientManager>();
for (const server of config.servers) {
  managers.set(server.id, new McpClientManager(server));
}

export function getManager(id: string): McpClientManager | undefined {
  return managers.get(id);
}

export function allManagers(): McpClientManager[] {
  return Array.from(managers.values());
}

export function connectedManagers(): McpClientManager[] {
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
