import type { McpServerConfig, ReactorConfig } from "./config.js";
import { logger } from "./logger.js";
import { groupToolsByCategory, type RawTool, type ToolCatalogGroup } from "./toolCatalog.js";
import {
  ConnectionRequiredError,
  type ConnectResult,
  type ConnectionStatus,
  type ServerManager,
} from "./serverManager.js";

/** Decodes a JWT payload (best-effort; returns {} for opaque tokens). */
function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const json = Buffer.from(part, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const PAGE_SIZE = 100;

/**
 * Read-only tool catalog exposed for Adobe Launch (Reactor API). Names are
 * distinct from Target/Analytics tools so they never collide when aggregated.
 */
const LAUNCH_TOOLS: RawTool[] = [
  {
    name: "list_launch_companies",
    description:
      "List the Adobe Launch companies accessible to the configured account.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_launch_properties",
    description:
      "List Launch properties (tag containers) for a company. If companyId is omitted, the configured/first company is used. Optionally filter by name.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Reactor company id (optional)" },
        name: { type: "string", description: "Filter: property name contains" },
      },
    },
  },
  {
    name: "get_launch_property",
    description: "Get a single Launch property by id (platform, domains, settings).",
    inputSchema: {
      type: "object",
      properties: { propertyId: { type: "string" } },
      required: ["propertyId"],
    },
  },
  {
    name: "list_launch_rules",
    description: "List rules for a Launch property. Optionally filter by name.",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: { type: "string" },
        name: { type: "string", description: "Filter: rule name contains" },
      },
      required: ["propertyId"],
    },
  },
  {
    name: "get_launch_rule",
    description: "Get a single rule by id.",
    inputSchema: {
      type: "object",
      properties: { ruleId: { type: "string" } },
      required: ["ruleId"],
    },
  },
  {
    name: "list_launch_rule_components",
    description:
      "List the components (events, conditions, actions) of a rule, including which extension and delegate each uses.",
    inputSchema: {
      type: "object",
      properties: { ruleId: { type: "string" } },
      required: ["ruleId"],
    },
  },
  {
    name: "list_launch_data_elements",
    description: "List data elements for a Launch property. Optionally filter by name.",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: { type: "string" },
        name: { type: "string", description: "Filter: data element name contains" },
      },
      required: ["propertyId"],
    },
  },
  {
    name: "list_launch_extensions",
    description:
      "List installed extensions for a Launch property (name, version, enabled).",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: { type: "string" },
        name: { type: "string", description: "Filter: extension name contains" },
      },
      required: ["propertyId"],
    },
  },
  {
    name: "list_launch_environments",
    description:
      "List environments (development, staging, production) for a Launch property.",
    inputSchema: {
      type: "object",
      properties: { propertyId: { type: "string" } },
      required: ["propertyId"],
    },
  },
  {
    name: "list_launch_libraries",
    description:
      "List libraries (builds) for a Launch property. Optionally filter by state (development, submitted, approved, published, rejected).",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: { type: "string" },
        state: { type: "string", description: "Library state filter" },
      },
      required: ["propertyId"],
    },
  },
  {
    name: "get_launch_library",
    description: "Get a single library (build) by id, including its state and builds.",
    inputSchema: {
      type: "object",
      properties: { libraryId: { type: "string" } },
      required: ["libraryId"],
    },
  },
];

interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  meta?: unknown;
}

/** A connection to Adobe Launch via the Reactor REST API (server-to-server). */
export class ReactorClientManager implements ServerManager {
  readonly id: string;
  readonly label: string;
  private readonly reactor: ReactorConfig;
  private connected = false;
  private fetchedToken: { value: string; expiresAt: number } | undefined;
  private resolvedOrgId: string;
  private cachedCompanyId: string | undefined;
  private companyCount: number | undefined;

  constructor(server: McpServerConfig) {
    if (!server.reactor) {
      throw new Error(`Reactor config missing for server ${server.id}`);
    }
    this.id = server.id;
    this.label = server.label;
    this.reactor = server.reactor;
    this.cachedCompanyId = this.reactor.companyId || undefined;

    const claims = decodeJwt(this.reactor.accessToken);
    this.resolvedOrgId =
      this.reactor.orgId || (typeof claims.org === "string" ? claims.org : "");
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private hasCredentials(): boolean {
    return Boolean(
      this.reactor.accessToken ||
        (this.reactor.clientId && this.reactor.clientSecret),
    );
  }

  // -------------------------------------------------------------------------
  // Token handling
  // -------------------------------------------------------------------------
  private staticTokenValid(): boolean {
    if (!this.reactor.accessToken) return false;
    const claims = decodeJwt(this.reactor.accessToken);
    const created = Number(claims.created_at);
    const expiresIn = Number(claims.expires_in); // milliseconds in Adobe tokens
    if (Number.isFinite(created) && Number.isFinite(expiresIn)) {
      return Date.now() < created + expiresIn - 60_000;
    }
    // Unknown expiry — assume usable and let the API reject if not.
    return true;
  }

  private async mintToken(): Promise<string> {
    if (!this.reactor.clientId || !this.reactor.clientSecret) {
      throw new Error("No valid Launch token and no client credentials to mint one.");
    }
    if (this.fetchedToken && Date.now() < this.fetchedToken.expiresAt - 60_000) {
      return this.fetchedToken.value;
    }
    // Reuse the static token's granted scopes when available.
    const claims = decodeJwt(this.reactor.accessToken);
    const scope =
      (typeof claims.scope === "string" && claims.scope) || this.reactor.scopes;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.reactor.clientId,
      client_secret: this.reactor.clientSecret,
      scope,
    });
    const res = await fetch(`${this.reactor.imsBaseUrl}/ims/token/v3`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(
        `Failed to mint Adobe IMS token (${res.status}): ${await res.text()}`,
      );
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    this.fetchedToken = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    logger.info(`[${this.id}] Minted a fresh Adobe IMS token via client credentials`);
    return this.fetchedToken.value;
  }

  private async getToken(): Promise<string> {
    if (this.fetchedToken && Date.now() < this.fetchedToken.expiresAt - 60_000) {
      return this.fetchedToken.value;
    }
    if (this.staticTokenValid()) return this.reactor.accessToken;
    return this.mintToken();
  }

  // -------------------------------------------------------------------------
  // Reactor REST helpers
  // -------------------------------------------------------------------------
  private async reactorFetch(
    path: string,
    query?: Record<string, string | undefined>,
  ): Promise<{ data: unknown; meta?: unknown }> {
    const token = await this.getToken();
    const url = new URL(`${this.reactor.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      Accept: "application/vnd.api+json;revision=1",
      "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${token}`,
      "X-Api-Key": this.reactor.clientId || "",
    };
    if (this.resolvedOrgId) headers["X-Gw-Ims-Org-Id"] = this.resolvedOrgId;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Reactor API ${res.status} for ${path}: ${text.slice(0, 600)}`);
    }
    return (await res.json()) as { data: unknown; meta?: unknown };
  }

  /** Trims a JSON:API resource for compact output (drops big `settings` in lists). */
  private compact(resource: JsonApiResource, full = false): unknown {
    const attrs = { ...(resource.attributes ?? {}) };
    if (!full && "settings" in attrs) {
      const s = attrs.settings;
      attrs.settings = typeof s === "string" ? `[omitted ${s.length} chars]` : "[omitted]";
    }
    return { id: resource.id, type: resource.type, attributes: attrs };
  }

  private async resolveCompanyId(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    if (this.cachedCompanyId) return this.cachedCompanyId;
    const { data } = await this.reactorFetch("/companies");
    const companies = Array.isArray(data) ? (data as JsonApiResource[]) : [];
    this.companyCount = companies.length;
    if (!companies.length || !companies[0].id) {
      throw new Error("No Adobe Launch companies accessible for this account.");
    }
    this.cachedCompanyId = companies[0].id;
    return this.cachedCompanyId;
  }

  // -------------------------------------------------------------------------
  // ServerManager contract
  // -------------------------------------------------------------------------
  async connect(): Promise<ConnectResult> {
    if (!this.hasCredentials()) {
      throw new Error(
        `${this.label} is not configured. Set LAUNCH_ACCESS_TOKEN or LAUNCH_CLIENT_ID + LAUNCH_CLIENT_SECRET.`,
      );
    }
    try {
      // Validate by listing companies.
      const { data } = await this.reactorFetch("/companies");
      const companies = Array.isArray(data) ? (data as JsonApiResource[]) : [];
      this.companyCount = companies.length;
      if (companies.length && !this.cachedCompanyId) {
        this.cachedCompanyId = companies[0].id;
      }
      this.connected = true;
      logger.info(
        `[${this.id}] Connected to ${this.label} (Reactor API), ${companies.length} compan${companies.length === 1 ? "y" : "ies"}`,
      );
      return { connected: true };
    } catch (err) {
      this.connected = false;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not connect to ${this.label} (Reactor API). ${msg}`);
    }
  }

  // No interactive OAuth for the Reactor API; connecting validates credentials.
  async finishAuth(): Promise<ConnectResult> {
    return this.connect();
  }

  private requireConnected(): void {
    if (!this.connected) {
      throw new ConnectionRequiredError(`Not connected to the ${this.label} API`);
    }
  }

  async getRawTools(): Promise<RawTool[]> {
    this.requireConnected();
    return LAUNCH_TOOLS;
  }

  async listTools(): Promise<ToolCatalogGroup[]> {
    this.requireConnected();
    return groupToolsByCategory(LAUNCH_TOOLS);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.requireConnected();
    try {
      const payload = await this.dispatch(name, args);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    const nameFilter = (v?: string) =>
      v ? { "filter[name]": `CONTAINS ${v}` } : {};

    switch (name) {
      case "list_launch_companies": {
        const { data, meta } = await this.reactorFetch("/companies");
        return this.list(data, meta);
      }
      case "list_launch_properties": {
        const companyId = await this.resolveCompanyId(str("companyId"));
        const { data, meta } = await this.reactorFetch(
          `/companies/${companyId}/properties`,
          { "page[size]": String(PAGE_SIZE), sort: "name", ...nameFilter(str("name")) },
        );
        return this.list(data, meta);
      }
      case "get_launch_property": {
        const { data } = await this.reactorFetch(`/properties/${reqId(args, "propertyId")}`);
        return this.compact(data as JsonApiResource, true);
      }
      case "list_launch_rules": {
        const { data, meta } = await this.reactorFetch(
          `/properties/${reqId(args, "propertyId")}/rules`,
          { "page[size]": String(PAGE_SIZE), sort: "name", ...nameFilter(str("name")) },
        );
        return this.list(data, meta);
      }
      case "get_launch_rule": {
        const { data } = await this.reactorFetch(`/rules/${reqId(args, "ruleId")}`);
        return this.compact(data as JsonApiResource, true);
      }
      case "list_launch_rule_components": {
        const { data, meta } = await this.reactorFetch(
          `/rules/${reqId(args, "ruleId")}/rule_components`,
          { "page[size]": String(PAGE_SIZE) },
        );
        return this.list(data, meta, true);
      }
      case "list_launch_data_elements": {
        const { data, meta } = await this.reactorFetch(
          `/properties/${reqId(args, "propertyId")}/data_elements`,
          { "page[size]": String(PAGE_SIZE), sort: "name", ...nameFilter(str("name")) },
        );
        return this.list(data, meta);
      }
      case "list_launch_extensions": {
        const { data, meta } = await this.reactorFetch(
          `/properties/${reqId(args, "propertyId")}/extensions`,
          { "page[size]": String(PAGE_SIZE), sort: "name", ...nameFilter(str("name")) },
        );
        return this.list(data, meta);
      }
      case "list_launch_environments": {
        const { data, meta } = await this.reactorFetch(
          `/properties/${reqId(args, "propertyId")}/environments`,
          { "page[size]": String(PAGE_SIZE) },
        );
        return this.list(data, meta);
      }
      case "list_launch_libraries": {
        const { data, meta } = await this.reactorFetch(
          `/properties/${reqId(args, "propertyId")}/libraries`,
          {
            "page[size]": String(PAGE_SIZE),
            ...(str("state") ? { "filter[state]": `EQ ${str("state")}` } : {}),
          },
        );
        return this.list(data, meta);
      }
      case "get_launch_library": {
        const { data } = await this.reactorFetch(`/libraries/${reqId(args, "libraryId")}`);
        return this.compact(data as JsonApiResource, true);
      }
      default:
        throw new Error(`Unknown Launch tool: ${name}`);
    }
  }

  private list(data: unknown, meta: unknown, full = false): unknown {
    const items = Array.isArray(data) ? (data as JsonApiResource[]) : [];
    return {
      count: items.length,
      pagination: meta,
      items: items.map((r) => this.compact(r, full)),
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async logout(): Promise<void> {
    this.connected = false;
    this.fetchedToken = undefined;
  }

  status(): ConnectionStatus {
    return {
      id: this.id,
      label: this.label,
      kind: "reactor",
      connected: this.connected,
      hasCredentials: this.hasCredentials(),
      serverUrl: this.reactor.baseUrl,
      authMode: "Server-to-server API",
      toolCount: this.connected ? LAUNCH_TOOLS.length : undefined,
      note: this.reactor.tenant ? `Tenant: ${this.reactor.tenant}` : undefined,
    };
  }
}

function reqId(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) {
    throw new Error(`Missing required argument "${key}"`);
  }
  return encodeURIComponent(v);
}
