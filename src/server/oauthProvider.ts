import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerConfig } from "./config.js";
import { logger } from "./logger.js";
import { createAuthStore, type AuthStoreShape } from "./tokenStore.js";

/**
 * OAuth scopes requested from Adobe IMS. These mirror the scopes documented for
 * Adobe's MCP servers. They are advertised as a hint; the effective scopes are
 * ultimately governed by the authorization server.
 */
export const ADOBE_OAUTH_SCOPES = [
  "AdobeID",
  "openid",
  "additional_info.projectedProductContext",
  "read_organizations",
  "additional_info.roles",
].join(" ");

/**
 * Implements the MCP SDK {@link OAuthClientProvider} interface backed by a
 * per-server JSON file store. Because this app is a server-side web app (not a
 * native agent), `redirectToAuthorization` does not navigate the user agent
 * itself. Instead it captures the authorization URL so the HTTP layer can hand
 * it to the browser, which performs the redirect and returns to the server's
 * `/oauth/callback/:id` endpoint.
 */
export class AdobeImsOAuthProvider implements OAuthClientProvider {
  private _pendingAuthorizationUrl: URL | undefined;
  private readonly store: ReturnType<typeof createAuthStore>;

  constructor(private readonly server: McpServerConfig) {
    this.store = createAuthStore(server.id);
  }

  get redirectUrl(): string {
    return this.server.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `Adobe MCP Client (${this.server.label})`,
      redirect_uris: [this.server.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: ADOBE_OAUTH_SCOPES,
    };
  }

  /** The authorization URL captured during the most recent auth attempt. */
  get pendingAuthorizationUrl(): URL | undefined {
    return this._pendingAuthorizationUrl;
  }

  clearPendingAuthorization(): void {
    this._pendingAuthorizationUrl = undefined;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.get("clientInformation") as
      | OAuthClientInformationFull
      | undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    logger.debug(`[${this.server.id}] Saving registered client information`);
    this.store.set("clientInformation", clientInformation);
  }

  tokens(): OAuthTokens | undefined {
    return this.store.get("tokens") as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    logger.debug(`[${this.server.id}] Persisting OAuth tokens`);
    this.store.set("tokens", tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    logger.info(
      `[${this.server.id}] Authorization required; captured Adobe IMS authorization URL`,
    );
    this._pendingAuthorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.set("codeVerifier", codeVerifier);
  }

  codeVerifier(): string {
    const verifier = this.store.get("codeVerifier");
    if (!verifier) {
      throw new Error("No PKCE code verifier saved for the current session");
    }
    return verifier;
  }

  state(): string {
    const value =
      globalThis.crypto?.randomUUID?.() ??
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.store.set("state", value);
    return value;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    logger.warn(`[${this.server.id}] Invalidating credentials: ${scope}`);
    switch (scope) {
      case "all":
        this.store.clear();
        break;
      case "client":
        this.store.delete("clientInformation");
        break;
      case "tokens":
        this.store.delete("tokens");
        break;
      case "verifier":
        this.store.delete("codeVerifier");
        break;
      case "discovery":
        break;
    }
  }

  /** Returns true when we already hold an access token. */
  hasTokens(): boolean {
    return Boolean(this.tokens()?.access_token);
  }

  /** Clears all stored OAuth state (used on explicit disconnect / logout). */
  reset(): void {
    this.store.clear();
    this._pendingAuthorizationUrl = undefined;
  }
}

export type { AuthStoreShape };
