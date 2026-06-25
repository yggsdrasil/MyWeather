import type { RawTool, ToolCatalogGroup } from "./toolCatalog.js";

export type ServerKind = "mcp" | "reactor";

export interface ConnectResult {
  connected: boolean;
  /** When set, the browser must visit this URL to authorize with Adobe IMS. */
  authorizationUrl?: string;
}

export interface ConnectionStatus {
  id: string;
  label: string;
  kind: ServerKind;
  connected: boolean;
  hasCredentials: boolean;
  serverUrl: string;
  /** Human-readable auth mode, e.g. "OAuth (browser)" or "Server-to-server API". */
  authMode?: string;
  serverInfo?: { name?: string; version?: string };
  toolCount?: number;
  /** Optional status note shown in the UI (e.g. configuration hints). */
  note?: string;
}

/** Thrown for expected "you must connect first" conditions (HTTP 409). */
export class ConnectionRequiredError extends Error {
  constructor(message = "Not connected to this Adobe server") {
    super(message);
    this.name = "ConnectionRequiredError";
  }
}

/**
 * Common contract implemented by every backend connection, whether it speaks
 * MCP over streamable HTTP (Target, Analytics) or a product REST API such as
 * the Adobe Launch / Reactor API.
 */
export interface ServerManager {
  readonly id: string;
  readonly label: string;
  readonly isConnected: boolean;
  connect(): Promise<ConnectResult>;
  finishAuth(authorizationCode: string): Promise<ConnectResult>;
  getRawTools(): Promise<RawTool[]>;
  listTools(): Promise<ToolCatalogGroup[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<void>;
  logout(): Promise<void>;
  status(): ConnectionStatus;
}

export type { RawTool, ToolCatalogGroup };
