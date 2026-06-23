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

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  /** OAuth redirect URI registered with Adobe IMS via the MCP auth flow. */
  redirectUrl: string;
  /** Adobe Target MCP server endpoint. */
  targetMcpUrl: string;
  /** Directory used to persist OAuth tokens + client registration. */
  dataDir: string;
}

export const config: AppConfig = {
  port,
  publicBaseUrl,
  redirectUrl: `${publicBaseUrl}/oauth/callback`,
  targetMcpUrl: process.env.TARGET_MCP_URL ?? "https://targetmcp.adobe.io/mcp",
  dataDir: resolveFromRoot(process.env.DATA_DIR ?? ".data"),
};
