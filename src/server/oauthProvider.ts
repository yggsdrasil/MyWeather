import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { authStore } from "./tokenStore.js";

/**
 * OAuth scopes requested from Adobe IMS. These mirror the scopes documented for
 * the Adobe Target MCP server. They are advertised as a hint; the effective
 * scopes are ultimately governed by the authorization server.
 */
export const ADOBE_TARGET_SCOPES = [
  "AdobeID",
  "openid",
  "additional_info.projectedProductContext",
  "read_organizations",
  "additional_info.roles",
].join(" ");

/**
 * Implements the MCP SDK {@link OAuthClientProvider} interface backed by a
 * JSON file store. Because this app is a server-side web app (not a native
 * agent), `redirectToAuthorization` does not navigate the user agent itself.
 * Instead it captures the authorization URL so the HTTP layer can hand it to
 * the browser, which performs the redirect and returns to `/oauth/callback`.
 */
export class AdobeTargetOAuthProvider implements OAuthClientProvider {
  private _pendingAuthorizationUrl: URL | undefined;

  get redirectUrl(): string {
    return config.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Adobe Target MCP Client",
      redirect_uris: [config.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: ADOBE_TARGET_SCOPES,
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
    return authStore.get("clientInformation") as
      | OAuthClientInformationFull
      | undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    logger.debug("Saving dynamically-registered client information");
    authStore.set("clientInformation", clientInformation);
  }

  tokens(): OAuthTokens | undefined {
    return authStore.get("tokens") as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    logger.debug("Persisting OAuth tokens");
    authStore.set("tokens", tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    logger.info("Authorization required; captured Adobe IMS authorization URL");
    this._pendingAuthorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    authStore.set("codeVerifier", codeVerifier);
  }

  codeVerifier(): string {
    const verifier = authStore.get("codeVerifier");
    if (!verifier) {
      throw new Error("No PKCE code verifier saved for the current session");
    }
    return verifier;
  }

  state(): string {
    const value =
      globalThis.crypto?.randomUUID?.() ??
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    authStore.set("state", value);
    return value;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    logger.warn(`Invalidating credentials: ${scope}`);
    switch (scope) {
      case "all":
        authStore.clear();
        break;
      case "client":
        authStore.delete("clientInformation");
        break;
      case "tokens":
        authStore.delete("tokens");
        break;
      case "verifier":
        authStore.delete("codeVerifier");
        break;
      case "discovery":
        // discovery state is not persisted in this implementation
        break;
    }
  }

  /** Returns true when we already hold an access token. */
  hasTokens(): boolean {
    return Boolean(this.tokens()?.access_token);
  }

  /** Clears all stored OAuth state (used on explicit disconnect / logout). */
  reset(): void {
    authStore.clear();
    this._pendingAuthorizationUrl = undefined;
  }
}
