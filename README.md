# Adobe Target MCP Client

A small full-stack web application that connects to **Adobe Target** through
Adobe's **Model Context Protocol (MCP)** server
(`https://targetmcp.adobe.io/mcp`). It acts as an MCP host/client: it handles
the Adobe IMS OAuth 2.0 authorization flow, discovers the tools the Target MCP
server exposes, and lets you work with them two ways:

- **Assistant** — ask in plain language ("which homepage A/B tests are
  winning?") and an AI agent calls the right Target MCP tools, reads the real
  data, and summarizes the answer.
- **Tools** — browse every tool the server exposes and run any of them manually
  with a form generated from its schema.

Use it to audit A/B tests, review performance and revenue reports, pull A4T
(Analytics for Target) data, inspect audiences and offers, and generate QA
preview URLs — all without writing raw Admin API calls.

## Example assistant prompts

| Goal                    | Example prompt                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Experiment status audit | "What A/B tests are currently active on the homepage? Show status, traffic allocation, and how long each has run."     |
| Performance review      | "Show me all active tests that have reached statistical significance — which experiences are winning?"                 |
| Revenue analysis        | "Get the orders and revenue report for activity AT4821 and summarize which experience drives the most revenue/visitor."|
| A4T reporting           | "Pull the A4T report for my checkout optimization test and summarize the Analytics-side conversion data."              |
| Activity insights       | "Get insights for my 'Summer Sale Banner' test — what does performance look like and are there anomalies?"            |
| Audience management     | "List all audiences targeting mobile users and show which activities they're associated with."                        |
| QA and preview          | "Generate QA preview URLs for activity 12345 so I can review all variants before activating."                          |

These prompts also appear as one-click chips in the Assistant tab.

> The Adobe Target MCP server is an Adobe public-beta feature. This is an
> unofficial client and is provided "as is". MCP-initiated actions respect your
> Adobe Target role (Observer = read, Editor = read + write, Approver =
> activate/deactivate).

## How it works

```
Browser UI  ──HTTP──▶  Node/Express server  ──MCP (streamable HTTP + OAuth)──▶  Adobe Target MCP server
                              │                                                       │
                              └── Adobe IMS OAuth 2.0 (authorization code + PKCE) ─────┘
```

- The **backend** (`src/server`) uses the official
  [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
  with a `StreamableHTTPClientTransport` to talk to the Target MCP server. A
  custom `OAuthClientProvider` (`oauthProvider.ts`) drives Adobe IMS OAuth 2.0
  (dynamic client registration + authorization-code flow with PKCE) and persists
  tokens to a git-ignored `.data/` folder.
- The **AI assistant** (`src/server/agent.ts`) runs an agentic tool-calling
  loop: it sends the conversation plus the discovered MCP tools to an LLM
  (Anthropic Claude or OpenAI / OpenAI-compatible), executes any tool calls the
  model requests against the Target MCP server, feeds the results back, and
  repeats until the model produces a final, data-grounded answer. The system
  prompt instructs it to never fabricate data, resolve names to IDs, and report
  significance/anomalies.
- The **frontend** (`public/`) is a dependency-free single-page UI with an
  Assistant chat view (with a visible tool-call trace) and a Tools browser that
  lists the discovered tools by category, renders a form from each tool's JSON
  Schema (with a raw-JSON fallback), runs the tool, and pretty-prints the result.

Because the OAuth flow needs a redirect endpoint and CORS-free server-to-server
calls, authentication and MCP traffic are handled by the backend; the browser
only talks to this app's own API.

## Prerequisites

- **Node.js 18+** (developed against Node 22).
- An active **Adobe Target license** (Adobe Experience Cloud subscription) with
  an Adobe Experience Platform organization.
- An Adobe user with a Target role assigned in the Adobe Admin Console.

## Setup

```bash
npm install
cp .env.example .env   # adjust if needed
```

Configuration (all optional — sensible defaults are used):

| Variable          | Default                          | Description                                            |
| ----------------- | -------------------------------- | ------------------------------------------------------ |
| `PORT`            | `4321`                           | Port the app listens on.                               |
| `PUBLIC_BASE_URL` | `http://localhost:4321`          | Base URL the browser uses; the OAuth redirect is `${PUBLIC_BASE_URL}/oauth/callback`. |
| `TARGET_MCP_URL`  | `https://targetmcp.adobe.io/mcp` | Adobe Target MCP server endpoint.                      |
| `DATA_DIR`        | `.data`                          | Where OAuth tokens & client registration are stored.   |

### Enabling the AI assistant (optional)

The **Tools** tab works without any AI configuration. To enable the **Assistant**
tab, set an LLM API key in `.env`. The provider is auto-detected from whichever
key you set:

```bash
# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-...

# …or OpenAI / OpenAI-compatible
OPENAI_API_KEY=sk-...
```

Optional overrides: `LLM_PROVIDER` (`anthropic` | `openai`), `LLM_MODEL`
(Anthropic default `claude-sonnet-4-6`; also `claude-opus-4-8`,
`claude-haiku-4-5`. OpenAI default `gpt-4o`), `LLM_BASE_URL` (for
OpenAI-compatible/proxy endpoints), `LLM_MAX_STEPS`, `LLM_MAX_TOKENS`. See
`.env.example`. Your prompts and the Target data the tools
return are sent to the configured LLM provider, so use a key/model you're
comfortable sharing that data with.

## Running

Development (auto-reload):

```bash
npm run dev
```

Production build + run:

```bash
npm run build
npm start
```

Then open <http://localhost:4321> and:

1. Click **Connect**.
2. A new tab opens for the **Adobe IMS** login. Sign in and select your
   organization. You are redirected back to the app at `/oauth/callback`.
3. Once connected:
   - **Assistant tab** (if an LLM key is configured): ask a question or click an
     example prompt; the agent calls the right tools and summarizes the answer.
     Expand the tool-call trace under any reply to see exactly what it ran.
   - **Tools tab**: browse the tools the server exposes (activities, reporting,
     audiences, offers, previews, and more), fill in parameters, and **Run tool**.

## API (backend)

The frontend talks to these endpoints; they are also usable directly:

| Method & path          | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `GET  /api/status`       | Connection + credential status.                                    |
| `POST /api/connect`      | Connect; returns `{ authorizationUrl }` when OAuth is required.    |
| `GET  /oauth/callback`   | OAuth 2.0 redirect target; exchanges the code and connects.        |
| `GET  /api/tools`        | Discovered tools grouped by category.                              |
| `POST /api/tools/call`   | Run a tool: `{ "name": "...", "arguments": { ... } }`.             |
| `GET  /api/agent/status` | Whether the AI assistant is configured (provider/model).          |
| `POST /api/chat`         | Run the assistant: `{ "messages": [{ "role": "user", "content": "…" }] }` → `{ reply, steps }`. |
| `POST /api/disconnect`   | Close the MCP session (keeps credentials).                         |
| `POST /api/logout`       | Close the session and clear stored credentials.                    |

## Project layout

```
src/server/
  config.ts         Environment-driven configuration
  logger.ts         Minimal structured logger
  tokenStore.ts     JSON-file persistence for OAuth artifacts
  oauthProvider.ts  Adobe IMS OAuthClientProvider implementation
  mcpClient.ts      MCP connection lifecycle + tool discovery/calls
  agent.ts          AI assistant: agentic tool-calling loop (Anthropic/OpenAI)
  toolCatalog.ts    Categorizes tools for display
  index.ts          Express server, REST API, OAuth callback, static hosting
public/
  index.html, styles.css, app.js   The web UI (Assistant + Tools views)
scripts/
  agent-itest.mjs   Integration test for the agent loop (fake LLM + tools)
```

## Tests

```bash
npm test
```

Runs an integration test of the agentic loop against a fake LLM endpoint (for
both the Anthropic and OpenAI request/response formats), verifying the model's
tool call is executed and the final answer is grounded in the tool's data.

## Security notes

- OAuth tokens and the dynamically-registered client are written to
  `DATA_DIR` (`.data/auth.json`, file mode `600`) and are **git-ignored**. Treat
  that folder as a secret.
- Adobe IMS validates tokens on every request; the MCP server does not store
  them persistently. All access is constrained to what your Adobe account is
  permitted to view or modify.
- This is intended for local / trusted use. If you deploy it, put it behind
  authentication and serve it over HTTPS.
