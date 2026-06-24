import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { AdobeTargetOAuthProvider } from "./oauthProvider.js";
import { categorizeTool, CATEGORIES, type ToolCategory } from "./toolCatalog.js";

export interface ConnectResult {
  connected: boolean;
  /** When set, the browser must visit this URL to authorize with Adobe IMS. */
  authorizationUrl?: string;
}

export interface ConnectionStatus {
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

const CLIENT_INFO = {
  name: "adobe-target-mcp-client",
  version: "1.0.0",
};

/** Thrown for expected "you must connect first" conditions (HTTP 409). */
export class ConnectionRequiredError extends Error {
  constructor(message = "Not connected to the Adobe Target MCP server") {
    super(message);
    this.name = "ConnectionRequiredError";
  }
}

/**
 * Manages a single long-lived connection to the Adobe Target MCP server,
 * including the OAuth authorization lifecycle.
 */
class McpClientManager {
  private readonly authProvider = new AdobeTargetOAuthProvider();
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private connected = false;
  private serverInfo: { name?: string; version?: string } | undefined;
  private cachedToolCount: number | undefined;

  private buildTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(config.targetMcpUrl), {
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
      logger.info("Connected to Adobe Target MCP server", this.serverInfo);
      await this.refreshToolCount();
      return { connected: true };
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        const authUrl = this.authProvider.pendingAuthorizationUrl;
        if (authUrl) {
          logger.info("OAuth authorization required to continue");
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
    logger.info("OAuth token exchange completed");

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
      logger.warn("Unable to pre-fetch tool count", err);
    }
  }

  private requireClient(): Client {
    if (!this.client || !this.connected) {
      throw new ConnectionRequiredError();
    }
    return this.client;
  }

  /** Returns the raw, flat tool list (name/description/inputSchema) for the agent. */
  async getRawTools(): Promise<
    Array<{ name: string; description: string; inputSchema: unknown }>
  > {
    const { tools } = await this.requireClient().listTools();
    this.cachedToolCount = tools.length;
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
  }

  async listTools(): Promise<ToolCatalogGroup[]> {
    const { tools } = await this.requireClient().listTools();
    this.cachedToolCount = tools.length;

    const grouped = new Map<string, CatalogTool[]>();
    for (const tool of tools) {
      const category = categorizeTool(tool.name);
      const entry: CatalogTool = {
        name: tool.name,
        description: tool.description ?? "",
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
    const result = await this.requireClient().callTool({
      name,
      arguments: args,
    });
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (err) {
        logger.warn("Error while closing transport", err);
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
      connected: this.connected,
      hasCredentials: this.authProvider.hasTokens(),
      serverUrl: config.targetMcpUrl,
      serverInfo: this.serverInfo,
      toolCount: this.cachedToolCount,
    };
  }
}

export const mcpClient = new McpClientManager();
