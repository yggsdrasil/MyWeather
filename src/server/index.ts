import path from "node:path";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { config, PROJECT_ROOT } from "./config.js";
import { logger } from "./logger.js";
import { mcpClient, ConnectionRequiredError } from "./mcpClient.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

/** Wraps async route handlers so rejected promises hit the error middleware. */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.get("/api/config", (_req, res) => {
  res.json({
    serverUrl: config.targetMcpUrl,
    redirectUrl: config.redirectUrl,
  });
});

app.get("/api/status", (_req, res) => {
  res.json(mcpClient.status());
});

/**
 * Initiates a connection to the MCP server. If authorization is needed, the
 * response includes `authorizationUrl` for the browser to open.
 */
app.post(
  "/api/connect",
  asyncHandler(async (_req, res) => {
    const result = await mcpClient.connect();
    res.json({ ...result, status: mcpClient.status() });
  }),
);

app.post(
  "/api/disconnect",
  asyncHandler(async (_req, res) => {
    await mcpClient.disconnect();
    res.json({ ok: true, status: mcpClient.status() });
  }),
);

app.post(
  "/api/logout",
  asyncHandler(async (_req, res) => {
    await mcpClient.logout();
    res.json({ ok: true, status: mcpClient.status() });
  }),
);

app.get(
  "/api/tools",
  asyncHandler(async (_req, res) => {
    const groups = await mcpClient.listTools();
    res.json({ groups });
  }),
);

app.post(
  "/api/tools/call",
  asyncHandler(async (req, res) => {
    const { name, arguments: args } = req.body ?? {};
    if (typeof name !== "string" || !name) {
      res.status(400).json({ error: "A tool 'name' is required" });
      return;
    }
    const result = await mcpClient.callTool(
      name,
      (args as Record<string, unknown>) ?? {},
    );
    res.json({ result });
  }),
);

/**
 * OAuth 2.0 redirect endpoint. Adobe IMS redirects the browser here with an
 * authorization `code` after the user grants access. We exchange the code for
 * tokens and establish the authenticated MCP session, then return the user to
 * the app.
 */
app.get(
  "/oauth/callback",
  asyncHandler(async (req, res) => {
    const code = req.query.code;
    const oauthError = req.query.error;

    if (typeof oauthError === "string") {
      const description =
        typeof req.query.error_description === "string"
          ? req.query.error_description
          : "";
      res.redirect(
        `/?auth=error&message=${encodeURIComponent(`${oauthError}: ${description}`)}`,
      );
      return;
    }

    if (typeof code !== "string" || !code) {
      res.redirect(`/?auth=error&message=${encodeURIComponent("Missing authorization code")}`);
      return;
    }

    try {
      await mcpClient.finishAuth(code);
      res.redirect("/?auth=success");
    } catch (err) {
      logger.error("OAuth callback failed", err);
      res.redirect(
        `/?auth=error&message=${encodeURIComponent(errorMessage(err))}`,
      );
    }
  }),
);

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

app.use(express.static(PUBLIC_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ConnectionRequiredError) {
    res.status(409).json({ error: err.message });
    return;
  }
  logger.error("Request failed", err);
  res.status(500).json({ error: errorMessage(err) });
});

app.listen(config.port, () => {
  logger.info(`Adobe Target MCP client running at ${config.publicBaseUrl}`);
  logger.info(`Proxying MCP server: ${config.targetMcpUrl}`);
  logger.info(`OAuth redirect URL: ${config.redirectUrl}`);
});
