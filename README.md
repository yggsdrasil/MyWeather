# Adobe MCP Client

A small full-stack web application that connects to **Adobe Experience Cloud**
through Adobe's **Model Context Protocol (MCP)** servers:

- **Adobe Target** — `https://targetmcp.adobe.io/mcp`
- **Adobe Analytics** — `https://aa-mcp.adobe.io/mcp`
- **Adobe Launch** (Experience Platform Data Collection / Tags) — via the
  **Reactor REST API** using server-to-server credentials (see note below)

It acts as an MCP host/client: each server is connected independently via the
Adobe IMS OAuth 2.0 authorization flow, the app discovers the tools each server
exposes, and lets you work with them two ways:

- **Assistant** — ask in plain language ("which homepage A/B tests are
  winning?") and an AI agent calls the right MCP tools, reads the real data, and
  summarizes the answer. Each reply shows token usage and an estimated cost, with
  a running session total in the header.
- **Tools** — browse every tool each connected server exposes and run any of
  them manually with a form generated from its schema (switch between servers
  with the tabs at the top of the tool list).

Connect any combination of servers. The assistant uses the tools from **all**
connected servers, so it can answer Target questions, Analytics questions,
Launch (tag implementation) questions, or correlate them (e.g. tie an experiment
to downstream analytics, or check that a Launch rule fires the right calls). Use
it to audit A/B tests, review performance and revenue reports, pull A4T
(Analytics for Target) data, inspect audiences and offers, generate QA preview
URLs, query Analytics report suites/dimensions/metrics/segments, and inspect
Launch properties, rules, data elements, extensions, and libraries — all without
writing raw API calls.

> **Adobe Launch:** Adobe has no public hosted Launch (Data Collection / Tags)
> MCP server, so this app connects Launch to the **Reactor REST API**
> (`https://reactor.adobe.io`) directly, using Adobe IMS **server-to-server
> credentials**. It still appears as a server in the UI and the assistant uses
> its tools alongside Target/Analytics — only the transport differs (a product
> REST API instead of MCP + browser OAuth).
>
> Configure it in `.env` with either a static access token or a client id +
> secret (the app mints and refreshes IMS tokens itself):
>
> ```bash
> LAUNCH_CLIENT_ID=...
> LAUNCH_CLIENT_SECRET=...
> # and/or a static token:
> LAUNCH_ACCESS_TOKEN=eyJ...
> # optional: LAUNCH_ORG_ID (derived from the token), LAUNCH_COMPANY_ID, LAUNCH_TENANT
> ```
>
> Launch then exposes read-only tools: list companies, properties, rules, rule
> components, data elements, extensions, environments, and libraries/builds. If
> no Reactor credentials are set, the Launch server falls back to MCP mode using
> `LAUNCH_MCP_URL` (for a future official endpoint or your own Launch MCP
> server); set that to `off` to hide Launch entirely.

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
                                          ┌─▶ Adobe Target MCP server
Browser UI ─HTTP─▶ Node/Express server ─MCP┼─▶ Adobe Analytics MCP server
                         │                 └─▶ Adobe Launch MCP server (when configured)
                         ├── Adobe IMS OAuth 2.0 (auth code + PKCE), one session per server
                         └── LLM (Anthropic / OpenAI) for the assistant
```

Adding more Adobe MCP servers (CJA, Real-Time CDP, AEM, …) is a one-line change
in `config.ts` — the connection lifecycle, OAuth, tool browser, and assistant
are all server-agnostic.

- The **backend** (`src/server`) uses the official
  [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
  with a `StreamableHTTPClientTransport` per server. Servers are configured as a
  list (`config.ts`), and `mcpClient.ts` keeps one connection manager per server
  plus helpers that aggregate/route tool calls across all connected servers. A
  custom `OAuthClientProvider` (`oauthProvider.ts`) drives Adobe IMS OAuth 2.0
  (dynamic client registration + authorization-code flow with PKCE) per server
  and persists tokens to a git-ignored `.data/` folder (one file per server).
- The **AI assistant** (`src/server/agent.ts`) runs an agentic tool-calling
  loop: it sends the conversation plus the discovered MCP tools (from every
  connected server) to an LLM (Anthropic Claude or OpenAI / OpenAI-compatible),
  executes any tool calls the model requests against the owning MCP server,
  feeds the results back, and repeats until the model produces a final,
  data-grounded answer. The system prompt instructs it to never fabricate data,
  resolve names to IDs, and report significance/anomalies.
- The **frontend** (`public/`) is a dependency-free single-page UI with an
  Assistant chat view (with a visible tool-call trace) and a Tools browser that
  lists the discovered tools by category, renders a form from each tool's JSON
  Schema (with a raw-JSON fallback), runs the tool, and pretty-prints the result.

Because the OAuth flow needs a redirect endpoint and CORS-free server-to-server
calls, authentication and MCP traffic are handled by the backend; the browser
only talks to this app's own API.

## Prerequisites

- **Node.js 18+** (developed against Node 22).
- An active **Adobe Experience Cloud** subscription with an Adobe Experience
  Platform organization, and a license for whichever product(s) you connect
  (Adobe Target and/or Adobe Analytics).
- An Adobe user with the appropriate product roles in the Adobe Admin Console
  (e.g. a Target role and/or Analytics report-suite access).

## Setup

```bash
npm install
cp .env.example .env   # adjust if needed
```

Configuration (all optional — sensible defaults are used):

| Variable            | Default                          | Description                                            |
| ------------------- | -------------------------------- | ------------------------------------------------------ |
| `PORT`              | `4321`                           | Port the app listens on.                               |
| `PUBLIC_BASE_URL`   | `http://localhost:4321`          | Base URL the browser uses; each server's OAuth redirect is `${PUBLIC_BASE_URL}/oauth/callback/<id>`. |
| `TARGET_MCP_URL`    | `https://targetmcp.adobe.io/mcp` | Adobe Target MCP server endpoint (set to `off` to hide it). |
| `ANALYTICS_MCP_URL` | `https://aa-mcp.adobe.io/mcp`    | Adobe Analytics MCP server endpoint (set to `off` to hide it). |
| `LAUNCH_CLIENT_ID` / `LAUNCH_CLIENT_SECRET` | _(unset)_ | Adobe IMS server-to-server credentials for the Launch Reactor API. When set, Launch uses the Reactor API. |
| `LAUNCH_ACCESS_TOKEN` | _(unset)_                      | Optional static IMS access token for Launch (used until expiry; refreshed via client creds if available). |
| `LAUNCH_ORG_ID` / `LAUNCH_COMPANY_ID` / `LAUNCH_TENANT` | _(unset)_ | Optional Launch identifiers; org id is derived from the token when omitted. |
| `LAUNCH_MCP_URL`    | `https://launch-mcp.adobe.io/mcp` | Launch MCP endpoint, used only when no Reactor credentials are set. `off` hides Launch. |
| `DATA_DIR`          | `.data`                          | Where OAuth tokens & client registration are stored (one file per server). |

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
`.env.example`. Your prompts and the Target/Analytics data the tools
return are sent to the configured LLM provider, so use a key/model you're
comfortable sharing that data with.

**Usage & cost.** Every assistant reply reports the tokens used and an estimated
USD cost (input + output, summed across the agent's tool-calling round-trips),
and the header keeps a running session total. Costs are computed from a built-in
price table for known Anthropic/OpenAI models and are **estimates** (list price,
excluding caching/batch discounts) — not your actual bill. If your model isn't
recognized or your rates differ, set `LLM_PRICE_INPUT` / `LLM_PRICE_OUTPUT` (USD
per 1,000,000 tokens) in `.env`.

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

1. Connect a server: click **Connect** next to **Adobe Target**, **Adobe
   Analytics**, and/or **Adobe Launch** (also available any time via the
   **Connections** button in the top bar). Target/Analytics open an Adobe IMS
   sign-in; Launch connects immediately using the configured Reactor
   credentials (no browser step).
2. A new tab opens for the **Adobe IMS** login. Sign in and select your
   organization. You are redirected back at `/oauth/callback/<server>`. Repeat
   for the second server if you want both.
3. Once at least one server is connected:
   - **Assistant tab** (if an LLM key is configured): ask a question or click an
     example prompt; the agent calls the right tools across all connected servers
     and summarizes the answer. Expand the tool-call trace under any reply to see
     exactly what it ran.
   - **Tools tab**: browse the tools each server exposes (use the server tabs at
     the top of the list when both are connected), fill in parameters, and
     **Run tool**.

## API (backend)

The frontend talks to these endpoints; they are also usable directly:

Server ids are `target` and `analytics`.

| Method & path                       | Purpose                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `GET  /api/servers`                 | Status of all configured servers (connected, credentials, tool count). |
| `GET  /api/config`                  | Configured servers (id, label, url).                                 |
| `POST /api/servers/:id/connect`     | Connect a server; returns `{ authorizationUrl }` when OAuth is required. |
| `GET  /oauth/callback/:id`          | OAuth 2.0 redirect target for a server; exchanges the code and connects. |
| `GET  /api/servers/:id/tools`       | A server's discovered tools grouped by category.                     |
| `POST /api/servers/:id/tools/call`  | Run a tool on a server: `{ "name": "...", "arguments": { ... } }`.   |
| `POST /api/servers/:id/disconnect`  | Close a server's MCP session (keeps credentials).                    |
| `POST /api/servers/:id/logout`      | Close a server's session and clear its stored credentials.           |
| `GET  /api/agent/status`            | Whether the AI assistant is configured (provider/model).             |
| `POST /api/chat`                    | Run the assistant across all connected servers: `{ "messages": [...] }` → `{ reply, steps, usage, cost, model }`. |

## Project layout

```
src/server/
  config.ts         Environment-driven configuration
  logger.ts         Minimal structured logger
  tokenStore.ts     Per-server JSON-file persistence for OAuth artifacts
  oauthProvider.ts  Adobe IMS OAuthClientProvider (one instance per MCP server)
  serverManager.ts  Shared ServerManager interface + connection types
  mcpClient.ts      MCP connection managers + registry + cross-server tool aggregation
  reactorClient.ts  Adobe Launch (Reactor REST API) connection manager + tools
  agent.ts          AI assistant: agentic tool-calling loop (Anthropic/OpenAI)
  pricing.ts        Per-model price table + token cost estimation
  toolCatalog.ts    Categorizes Target/Analytics/Launch tools for display
  index.ts          Express server, REST API, per-server OAuth callback, static hosting
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

- OAuth tokens and the dynamically-registered client are written per server to
  `DATA_DIR` (`.data/auth-target.json`, `.data/auth-analytics.json`, file mode
  `600`) and are **git-ignored**. Treat that folder as a secret.
- Adobe IMS validates tokens on every request; the MCP server does not store
  them persistently. All access is constrained to what your Adobe account is
  permitted to view or modify.
- This is intended for local / trusted use. If you deploy it, put it behind
  authentication and serve it over HTTPS.
