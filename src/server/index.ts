import path from "node:path";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { config, PROJECT_ROOT } from "./config.js";
import { logger } from "./logger.js";
import {
  ConnectionRequiredError,
  allStatuses,
  connectedManagers,
  getManager,
} from "./mcpClient.js";
import { runAgent, type ChatMessage } from "./agent.js";

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

/** Resolves the manager for a `:id` route param or sends a 404. */
function resolveManager(req: Request, res: Response) {
  const manager = getManager(req.params.id);
  if (!manager) {
    res.status(404).json({ error: `Unknown MCP server: ${req.params.id}` });
    return undefined;
  }
  return manager;
}

// ---------------------------------------------------------------------------
// Config / status
// ---------------------------------------------------------------------------

app.get("/api/config", (_req, res) => {
  res.json({
    servers: config.servers.map((s) => ({
      id: s.id,
      label: s.label,
      url: s.url,
    })),
  });
});

app.get("/api/servers", (_req, res) => {
  res.json({ servers: allStatuses() });
});

app.get("/api/agent/status", (_req, res) => {
  res.json({
    available: config.llm.enabled,
    provider: config.llm.provider,
    model: config.llm.enabled ? config.llm.model : null,
  });
});

// ---------------------------------------------------------------------------
// Per-server connection lifecycle
// ---------------------------------------------------------------------------

app.post(
  "/api/servers/:id/connect",
  asyncHandler(async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    const result = await manager.connect();
    res.json({ ...result, status: manager.status() });
  }),
);

app.post(
  "/api/servers/:id/disconnect",
  asyncHandler(async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    await manager.disconnect();
    res.json({ ok: true, status: manager.status() });
  }),
);

app.post(
  "/api/servers/:id/logout",
  asyncHandler(async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    await manager.logout();
    res.json({ ok: true, status: manager.status() });
  }),
);

app.get(
  "/api/servers/:id/tools",
  asyncHandler(async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    const groups = await manager.listTools();
    res.json({ groups });
  }),
);

app.post(
  "/api/servers/:id/tools/call",
  asyncHandler(async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    const { name, arguments: args } = req.body ?? {};
    if (typeof name !== "string" || !name) {
      res.status(400).json({ error: "A tool 'name' is required" });
      return;
    }
    const result = await manager.callTool(
      name,
      (args as Record<string, unknown>) ?? {},
    );
    res.json({ result });
  }),
);

/**
 * OAuth 2.0 redirect endpoint, scoped per server. Adobe IMS redirects the
 * browser here with an authorization `code`; we exchange it for tokens and
 * establish the authenticated MCP session, then return the user to the app.
 */
app.get(
  "/oauth/callback/:id",
  asyncHandler(async (req, res) => {
    const manager = getManager(req.params.id);
    const code = req.query.code;
    const oauthError = req.query.error;

    if (!manager) {
      res.redirect(
        `/?auth=error&message=${encodeURIComponent(`Unknown server: ${req.params.id}`)}`,
      );
      return;
    }

    if (typeof oauthError === "string") {
      const description =
        typeof req.query.error_description === "string"
          ? req.query.error_description
          : "";
      res.redirect(
        `/?auth=error&server=${manager.id}&message=${encodeURIComponent(`${oauthError}: ${description}`)}`,
      );
      return;
    }

    if (typeof code !== "string" || !code) {
      res.redirect(
        `/?auth=error&server=${manager.id}&message=${encodeURIComponent("Missing authorization code")}`,
      );
      return;
    }

    try {
      await manager.finishAuth(code);
      res.redirect(`/?auth=success&server=${manager.id}`);
    } catch (err) {
      logger.error(`[${manager.id}] OAuth callback failed`, err);
      res.redirect(
        `/?auth=error&server=${manager.id}&message=${encodeURIComponent(errorMessage(err))}`,
      );
    }
  }),
);

// ---------------------------------------------------------------------------
// AI assistant
// ---------------------------------------------------------------------------

/**
 * Natural-language assistant endpoint. Runs the agentic tool-calling loop
 * against every connected Adobe MCP server (Target, Analytics, …).
 */
app.post(
  "/api/chat",
  asyncHandler(async (req, res) => {
    if (!config.llm.enabled) {
      res.status(400).json({
        error:
          "AI assistant is not configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart the server.",
      });
      return;
    }
    if (connectedManagers().length === 0) {
      res.status(409).json({
        error:
          "Connect to at least one Adobe MCP server (Target or Analytics) before using the assistant.",
      });
      return;
    }

    const rawMessages = req.body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      res.status(400).json({ error: "A non-empty 'messages' array is required." });
      return;
    }

    const history: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof (m as ChatMessage).content === "string" &&
          ((m as ChatMessage).role === "user" ||
            (m as ChatMessage).role === "assistant"),
      )
      .map((m) => ({ role: m.role, content: m.content }));

    const result = await runAgent(history);
    res.json(result);
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
  logger.info(`Adobe MCP client running at ${config.publicBaseUrl}`);
  for (const s of config.servers) {
    logger.info(`  • ${s.label} → ${s.url} (callback ${s.redirectUrl})`);
  }
});
