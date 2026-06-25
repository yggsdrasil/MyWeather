import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Tiny JSON-file-backed key/value store used to persist OAuth artifacts
 * (dynamically-registered client info, tokens, and the in-flight PKCE code
 * verifier) across server restarts.
 *
 * NOTE: This file contains sensitive credentials. It lives under DATA_DIR,
 * which is git-ignored. Do not commit it or expose it publicly.
 */
class JsonFileStore<T extends Record<string, unknown>> {
  private readonly filePath: string;
  private cache: T;

  constructor(fileName: string) {
    this.filePath = path.join(config.dataDir, fileName);
    this.cache = this.load();
  }

  private load(): T {
    try {
      if (!fs.existsSync(this.filePath)) return {} as T;
      const raw = fs.readFileSync(this.filePath, "utf8");
      return raw.trim() ? (JSON.parse(raw) as T) : ({} as T);
    } catch (err) {
      logger.warn(`Failed to read store ${this.filePath}; starting empty`, err);
      return {} as T;
    }
  }

  private persist(): void {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), {
      mode: 0o600,
    });
  }

  get<K extends keyof T>(key: K): T[K] | undefined {
    return this.cache[key];
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    this.cache[key] = value;
    this.persist();
  }

  delete<K extends keyof T>(key: K): void {
    delete this.cache[key];
    this.persist();
  }

  clear(): void {
    this.cache = {} as T;
    this.persist();
  }
}

export interface AuthStoreShape {
  clientInformation?: unknown;
  tokens?: unknown;
  codeVerifier?: string;
  state?: string;
  [key: string]: unknown;
}

/** Creates an isolated auth store for a given MCP server id. */
export function createAuthStore(serverId: string): JsonFileStore<AuthStoreShape> {
  return new JsonFileStore<AuthStoreShape>(`auth-${serverId}.json`);
}
