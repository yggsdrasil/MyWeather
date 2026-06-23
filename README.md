# Adobe Target MCP Client

A small full-stack web application that connects to **Adobe Target** through
Adobe's **Model Context Protocol (MCP)** server
(`https://targetmcp.adobe.io/mcp`). It acts as an MCP host/client: it handles
the Adobe IMS OAuth 2.0 authorization flow, discovers the tools the Target MCP
server exposes, and lets you browse and run them from a clean web UI — auditing
A/B tests, reviewing performance reports, inspecting audiences and offers, and
previewing activities, all without writing raw Admin API calls.

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
- The **frontend** (`public/`) is a dependency-free single-page UI that lists
  the discovered tools by category, renders a form from each tool's JSON Schema
  (with a raw-JSON fallback), runs the tool, and pretty-prints the result.

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
3. Once connected, the sidebar fills with the tools the server exposes
   (activities, reporting, audiences, offers, previews, and more). Pick a tool,
   fill in the parameters, and click **Run tool**.

## API (backend)

The frontend talks to these endpoints; they are also usable directly:

| Method & path          | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `GET  /api/status`     | Connection + credential status.                                      |
| `POST /api/connect`    | Connect; returns `{ authorizationUrl }` when OAuth is required.      |
| `GET  /oauth/callback` | OAuth 2.0 redirect target; exchanges the code and connects.          |
| `GET  /api/tools`      | Discovered tools grouped by category.                                |
| `POST /api/tools/call` | Run a tool: `{ "name": "...", "arguments": { ... } }`.               |
| `POST /api/disconnect` | Close the MCP session (keeps credentials).                           |
| `POST /api/logout`     | Close the session and clear stored credentials.                      |

## Project layout

```
src/server/
  config.ts         Environment-driven configuration
  logger.ts         Minimal structured logger
  tokenStore.ts     JSON-file persistence for OAuth artifacts
  oauthProvider.ts  Adobe IMS OAuthClientProvider implementation
  mcpClient.ts      MCP connection lifecycle + tool discovery/calls
  toolCatalog.ts    Categorizes tools for display
  index.ts          Express server, REST API, OAuth callback, static hosting
public/
  index.html, styles.css, app.js   The web UI
```

## Security notes

- OAuth tokens and the dynamically-registered client are written to
  `DATA_DIR` (`.data/auth.json`, file mode `600`) and are **git-ignored**. Treat
  that folder as a secret.
- Adobe IMS validates tokens on every request; the MCP server does not store
  them persistently. All access is constrained to what your Adobe account is
  permitted to view or modify.
- This is intended for local / trusted use. If you deploy it, put it behind
  authentication and serve it over HTTPS.
