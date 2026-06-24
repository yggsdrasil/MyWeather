// Adobe Target MCP client — frontend controller.

const els = {
  statusBadge: document.getElementById("status-badge"),
  connectBtn: document.getElementById("connect-btn"),
  logoutBtn: document.getElementById("logout-btn"),
  serverUrl: document.getElementById("server-url"),
  footerServer: document.getElementById("footer-server"),
  welcome: document.getElementById("welcome"),
  workspace: document.getElementById("workspace"),
  authAction: document.getElementById("auth-action"),
  authorizeLink: document.getElementById("authorize-link"),
  toolList: document.getElementById("tool-list"),
  toolCount: document.getElementById("tool-count"),
  toolSearch: document.getElementById("tool-search"),
  detailEmpty: document.getElementById("detail-empty"),
  detailContent: document.getElementById("detail-content"),
  detailCategory: document.getElementById("detail-category"),
  detailName: document.getElementById("detail-name"),
  detailDescription: document.getElementById("detail-description"),
  runBtn: document.getElementById("run-btn"),
  paramForm: document.getElementById("param-form"),
  paramJson: document.getElementById("param-json"),
  resultBody: document.getElementById("result-body"),
  resultStatus: document.getElementById("result-status"),
  toast: document.getElementById("toast"),
  tabs: document.querySelectorAll(".tab"),
  // Assistant / chat
  viewTabs: document.querySelectorAll(".view-tab"),
  assistantView: document.getElementById("assistant-view"),
  toolsView: document.getElementById("tools-view"),
  agentModel: document.getElementById("agent-model"),
  chatLog: document.getElementById("chat-log"),
  chatEmpty: document.getElementById("chat-empty"),
  promptGrid: document.getElementById("prompt-grid"),
  assistantDisabled: document.getElementById("assistant-disabled"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  chatSend: document.getElementById("chat-send"),
};

const state = {
  groups: [],
  selected: null, // currently selected tool object
  mode: "form", // "form" | "json"
  view: "assistant", // "assistant" | "tools"
  agent: { available: false, model: null },
  messages: [], // [{ role, content }]
  sending: false,
};

// --------------------------------------------------------------------------
// API helpers
// --------------------------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// --------------------------------------------------------------------------
// Toast
// --------------------------------------------------------------------------
let toastTimer;
function toast(message, type = "info", duration = 4000) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  if (duration > 0) {
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), duration);
  }
}

// --------------------------------------------------------------------------
// Status / connection
// --------------------------------------------------------------------------
function renderStatus(status) {
  if (status.serverUrl) {
    els.serverUrl.textContent = status.serverUrl;
    try {
      els.footerServer.textContent = new URL(status.serverUrl).host;
    } catch (_) {
      /* ignore */
    }
  }

  const badge = els.statusBadge;
  if (status.connected) {
    badge.textContent = status.toolCount
      ? `Connected · ${status.toolCount} tools`
      : "Connected";
    badge.className = "badge badge-connected";
    els.connectBtn.classList.add("hidden");
    els.logoutBtn.classList.remove("hidden");
    els.welcome.classList.add("hidden");
    els.workspace.classList.remove("hidden");
  } else if (status.hasCredentials) {
    badge.textContent = "Authenticated · not connected";
    badge.className = "badge badge-auth";
    els.connectBtn.classList.remove("hidden");
    els.connectBtn.textContent = "Connect";
    els.logoutBtn.classList.remove("hidden");
    els.welcome.classList.remove("hidden");
    els.workspace.classList.add("hidden");
  } else {
    badge.textContent = "Disconnected";
    badge.className = "badge badge-idle";
    els.connectBtn.classList.remove("hidden");
    els.connectBtn.textContent = "Connect";
    els.logoutBtn.classList.add("hidden");
    els.welcome.classList.remove("hidden");
    els.workspace.classList.add("hidden");
  }
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    renderStatus(status);
    if (status.connected) {
      await loadTools();
    }
    return status;
  } catch (err) {
    toast(err.message, "error");
  }
}

function setConnecting(on) {
  els.connectBtn.disabled = on;
  els.connectBtn.innerHTML = on
    ? '<span class="spinner"></span> Connecting…'
    : "Connect";
}

async function connect() {
  setConnecting(true);
  els.authAction.classList.add("hidden");
  try {
    const data = await api("/api/connect", { method: "POST" });
    if (data.authorizationUrl) {
      // Authorization required — surface the Adobe IMS login.
      els.authorizeLink.href = data.authorizationUrl;
      els.authAction.classList.remove("hidden");
      els.statusBadge.textContent = "Authorization required";
      els.statusBadge.className = "badge badge-auth";
      toast("Authorize with Adobe to continue.", "info", 6000);
      // Open the auth flow automatically in a new tab.
      window.open(data.authorizationUrl, "_blank", "noopener");
    } else if (data.connected) {
      toast("Connected to Adobe Target MCP server.", "success");
      renderStatus(data.status);
      await loadTools();
    }
  } catch (err) {
    toast(err.message, "error", 7000);
  } finally {
    setConnecting(false);
  }
}

async function logout() {
  try {
    const data = await api("/api/logout", { method: "POST" });
    state.groups = [];
    state.selected = null;
    state.messages = [];
    els.toolList.innerHTML = "";
    els.detailContent.classList.add("hidden");
    els.detailEmpty.classList.remove("hidden");
    // Clear chat history except the empty-state prompt grid.
    els.chatLog.querySelectorAll(".msg").forEach((m) => m.remove());
    els.chatEmpty.classList.remove("hidden");
    renderStatus(data.status);
    toast("Signed out and cleared credentials.", "info");
  } catch (err) {
    toast(err.message, "error");
  }
}

// --------------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------------
async function loadTools() {
  try {
    const data = await api("/api/tools");
    state.groups = data.groups || [];
    renderToolList();
  } catch (err) {
    toast(`Could not load tools: ${err.message}`, "error", 7000);
  }
}

function renderToolList() {
  const query = els.toolSearch.value.trim().toLowerCase();
  els.toolList.innerHTML = "";
  let visible = 0;

  for (const group of state.groups) {
    const matching = group.tools.filter(
      (t) =>
        !query ||
        t.name.toLowerCase().includes(query) ||
        (t.description || "").toLowerCase().includes(query),
    );
    if (!matching.length) continue;

    const groupEl = document.createElement("div");
    groupEl.className = "cat-group";
    const label = document.createElement("div");
    label.className = "cat-label";
    label.textContent = group.category.label;
    groupEl.appendChild(label);

    for (const tool of matching) {
      visible += 1;
      const btn = document.createElement("button");
      btn.className = "tool-item";
      btn.type = "button";
      if (state.selected && state.selected.name === tool.name) {
        btn.classList.add("active");
      }
      const tname = document.createElement("span");
      tname.className = "tname";
      tname.textContent = tool.name;
      btn.appendChild(tname);
      btn.addEventListener("click", () => selectTool(tool));
      groupEl.appendChild(btn);
    }
    els.toolList.appendChild(groupEl);
  }

  const total = state.groups.reduce((n, g) => n + g.tools.length, 0);
  els.toolCount.textContent = query
    ? `${visible} of ${total} tools`
    : `${total} tools`;

  if (!visible) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.style.padding = "12px";
    empty.textContent = "No tools match your search.";
    els.toolList.appendChild(empty);
  }
}

function selectTool(tool) {
  state.selected = tool;
  renderToolList();

  els.detailEmpty.classList.add("hidden");
  els.detailContent.classList.remove("hidden");
  els.detailCategory.textContent = tool.category.label;
  els.detailName.textContent = tool.name;
  els.detailDescription.textContent =
    tool.description || "No description provided by the server.";

  buildForm(tool.inputSchema);
  els.paramJson.value = "{}";
  setMode("form");
  clearResult();
}

// --------------------------------------------------------------------------
// Dynamic form generation from a JSON Schema
// --------------------------------------------------------------------------
function buildForm(schema) {
  els.paramForm.innerHTML = "";
  const props = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);
  const keys = Object.keys(props);

  if (!keys.length) {
    const p = document.createElement("p");
    p.className = "no-params";
    p.textContent = "This tool takes no parameters.";
    els.paramForm.appendChild(p);
    return;
  }

  for (const key of keys) {
    const def = props[key] || {};
    const field = document.createElement("div");
    field.className = "field";

    const label = document.createElement("label");
    label.setAttribute("for", `f_${key}`);
    label.textContent = key;
    if (required.has(key)) {
      const req = document.createElement("span");
      req.className = "req";
      req.textContent = "*";
      label.appendChild(req);
    }
    field.appendChild(label);

    const control = buildControl(key, def);
    field.appendChild(control);

    const hintText = def.description || typeHint(def);
    if (hintText) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = hintText;
      field.appendChild(hint);
    }

    els.paramForm.appendChild(field);
  }
}

function typeHint(def) {
  if (def.enum) return `One of: ${def.enum.join(", ")}`;
  if (def.type === "array") return "Enter JSON array, e.g. [\"a\", \"b\"]";
  if (def.type === "object") return "Enter JSON object";
  return def.type ? `type: ${def.type}` : "";
}

function buildControl(key, def) {
  const id = `f_${key}`;
  const type = Array.isArray(def.type) ? def.type[0] : def.type;

  if (def.enum && Array.isArray(def.enum)) {
    const select = document.createElement("select");
    select.id = id;
    select.dataset.key = key;
    select.dataset.kind = "enum";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— select —";
    select.appendChild(blank);
    for (const opt of def.enum) {
      const o = document.createElement("option");
      o.value = String(opt);
      o.textContent = String(opt);
      select.appendChild(o);
    }
    if (def.default !== undefined) select.value = String(def.default);
    return select;
  }

  if (type === "boolean") {
    const wrap = document.createElement("div");
    wrap.className = "checkbox-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.dataset.key = key;
    input.dataset.kind = "boolean";
    if (def.default === true) input.checked = true;
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = "true / false";
    wrap.appendChild(input);
    wrap.appendChild(span);
    return wrap;
  }

  if (type === "object" || type === "array") {
    const ta = document.createElement("textarea");
    ta.id = id;
    ta.dataset.key = key;
    ta.dataset.kind = "json";
    ta.placeholder = type === "array" ? "[]" : "{}";
    if (def.default !== undefined) {
      ta.value = JSON.stringify(def.default, null, 2);
    }
    return ta;
  }

  const input = document.createElement("input");
  input.id = id;
  input.dataset.key = key;
  if (type === "number" || type === "integer") {
    input.type = "number";
    input.dataset.kind = type;
    if (type === "integer") input.step = "1";
  } else {
    input.type = "text";
    input.dataset.kind = "string";
  }
  if (def.default !== undefined && typeof def.default !== "object") {
    input.value = String(def.default);
  }
  return input;
}

function collectFormArgs() {
  const args = {};
  const controls = els.paramForm.querySelectorAll("[data-key]");
  for (const ctrl of controls) {
    const key = ctrl.dataset.key;
    const kind = ctrl.dataset.kind;

    if (kind === "boolean") {
      if (ctrl.checked) args[key] = true;
      continue;
    }
    const raw = ctrl.value.trim();
    if (raw === "") continue;

    if (kind === "number" || kind === "integer") {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`"${key}" must be a number`);
      args[key] = n;
    } else if (kind === "json") {
      try {
        args[key] = JSON.parse(raw);
      } catch (_) {
        throw new Error(`"${key}" must be valid JSON`);
      }
    } else {
      args[key] = raw;
    }
  }
  return args;
}

function gatherArgs() {
  if (state.mode === "json") {
    const raw = els.paramJson.value.trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (_) {
      throw new Error("Raw JSON parameters are not valid JSON.");
    }
  }
  return collectFormArgs();
}

// --------------------------------------------------------------------------
// Tabs (form / json)
// --------------------------------------------------------------------------
function setMode(mode) {
  state.mode = mode;
  els.tabs.forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  if (mode === "json") {
    // Seed the JSON editor from the current form values when switching.
    try {
      els.paramJson.value = JSON.stringify(collectFormArgs(), null, 2);
    } catch (_) {
      /* keep existing */
    }
    els.paramForm.classList.add("hidden");
    els.paramJson.classList.remove("hidden");
  } else {
    els.paramForm.classList.remove("hidden");
    els.paramJson.classList.add("hidden");
  }
}

// --------------------------------------------------------------------------
// Running a tool & rendering results
// --------------------------------------------------------------------------
function clearResult() {
  els.resultStatus.textContent = "";
  els.resultStatus.className = "result-status";
  els.resultBody.innerHTML =
    '<p class="muted">Run the tool to see results here.</p>';
}

async function runTool() {
  if (!state.selected) return;
  let args;
  try {
    args = gatherArgs();
  } catch (err) {
    toast(err.message, "error");
    return;
  }

  els.runBtn.disabled = true;
  els.runBtn.innerHTML = '<span class="spinner"></span> Running…';
  els.resultStatus.textContent = "running…";
  els.resultStatus.className = "result-status";
  els.resultBody.innerHTML = '<p class="muted">Calling tool…</p>';

  try {
    const data = await api("/api/tools/call", {
      method: "POST",
      body: JSON.stringify({ name: state.selected.name, arguments: args }),
    });
    renderResult(data.result);
  } catch (err) {
    els.resultStatus.textContent = "error";
    els.resultStatus.className = "result-status err";
    els.resultBody.innerHTML = "";
    const pre = document.createElement("pre");
    pre.textContent = err.message;
    els.resultBody.appendChild(pre);
    toast(err.message, "error", 6000);
  } finally {
    els.runBtn.disabled = false;
    els.runBtn.textContent = "Run tool";
  }
}

function renderResult(result) {
  const isError = result && result.isError;
  els.resultStatus.textContent = isError ? "tool error" : "success";
  els.resultStatus.className = `result-status ${isError ? "err" : "ok"}`;
  els.resultBody.innerHTML = "";

  const content = (result && result.content) || [];
  if (Array.isArray(content) && content.length) {
    for (const block of content) {
      const section = document.createElement("div");
      section.className = "result-section";
      if (block.type === "text") {
        renderTextBlock(section, block.text);
      } else {
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(block, null, 2);
        section.appendChild(pre);
      }
      els.resultBody.appendChild(section);
    }
  } else if (result && result.structuredContent) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(result.structuredContent, null, 2);
    els.resultBody.appendChild(pre);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(result, null, 2);
    els.resultBody.appendChild(pre);
  }

  // Always offer the full raw payload.
  const details = document.createElement("details");
  details.className = "raw";
  const summary = document.createElement("summary");
  summary.textContent = "View raw response";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(result, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  els.resultBody.appendChild(details);
}

function renderTextBlock(container, text) {
  // Pretty-print JSON text payloads when possible.
  const trimmed = (text || "").trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(parsed, null, 2);
      container.appendChild(pre);
      return;
    } catch (_) {
      /* fall through to plain text */
    }
  }
  const div = document.createElement("div");
  div.className = "result-text";
  div.textContent = text;
  container.appendChild(div);
}

// --------------------------------------------------------------------------
// View switching (Assistant / Tools)
// --------------------------------------------------------------------------
function switchView(view) {
  state.view = view;
  els.viewTabs.forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view),
  );
  els.assistantView.classList.toggle("hidden", view !== "assistant");
  els.toolsView.classList.toggle("hidden", view !== "tools");
}

// --------------------------------------------------------------------------
// Assistant / chat
// --------------------------------------------------------------------------
async function initAgent() {
  try {
    const data = await api("/api/agent/status");
    state.agent = data;
    if (data.available) {
      els.agentModel.textContent = `${data.provider} · ${data.model}`;
      els.assistantDisabled.classList.add("hidden");
      els.chatForm.classList.remove("hidden");
      els.chatInput.disabled = false;
      els.chatSend.disabled = false;
    } else {
      els.agentModel.textContent = "assistant not configured";
      els.assistantDisabled.classList.remove("hidden");
      els.chatForm.classList.add("hidden");
    }
  } catch (_) {
    state.agent = { available: false, model: null };
  }
  // Default to the assistant when it's available, otherwise the tools browser.
  switchView(state.agent.available ? "assistant" : "tools");
}

function autosizeInput() {
  els.chatInput.style.height = "auto";
  els.chatInput.style.height = `${Math.min(els.chatInput.scrollHeight, 160)}px`;
}

function appendMessage(role, content) {
  els.chatEmpty.classList.add("hidden");
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  const label = document.createElement("div");
  label.className = "msg-role";
  label.textContent = role === "user" ? "You" : "Assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  els.chatLog.appendChild(wrap);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  return { wrap, bubble };
}

function appendTrace(bubble, steps) {
  if (!steps || !steps.length) return;
  const details = document.createElement("details");
  details.className = "trace";
  const summary = document.createElement("summary");
  summary.textContent = `${steps.length} tool call${steps.length > 1 ? "s" : ""}`;
  details.appendChild(summary);
  for (const step of steps) {
    const row = document.createElement("div");
    row.className = "trace-step";
    const dot = document.createElement("span");
    dot.className = `dot ${step.ok ? "ok" : "err"}`;
    dot.textContent = step.ok ? "●" : "✕";
    const name = document.createElement("span");
    name.className = "tcall";
    name.textContent = step.name;
    const args = document.createElement("span");
    args.className = "targs";
    const argStr = JSON.stringify(step.args || {});
    args.textContent = argStr === "{}" ? "" : argStr;
    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(args);
    details.appendChild(row);
  }
  bubble.appendChild(details);
}

async function sendChat(text) {
  const message = (text ?? els.chatInput.value).trim();
  if (!message || state.sending) return;
  if (!state.agent.available) {
    toast("AI assistant is not configured.", "error");
    return;
  }

  state.sending = true;
  els.chatSend.disabled = true;
  els.chatInput.value = "";
  autosizeInput();

  state.messages.push({ role: "user", content: message });
  appendMessage("user", message);

  // Pending assistant bubble with typing indicator.
  const pending = appendMessage("assistant", "");
  pending.bubble.innerHTML =
    '<div class="typing"><span></span><span></span><span></span></div>';

  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: state.messages }),
    });
    pending.bubble.innerHTML = renderMarkdown(data.reply || "(no response)");
    appendTrace(pending.bubble, data.steps);
    state.messages.push({ role: "assistant", content: data.reply || "" });
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  } catch (err) {
    pending.bubble.innerHTML = "";
    const errDiv = document.createElement("div");
    errDiv.style.color = "var(--accent)";
    errDiv.textContent = `Error: ${err.message}`;
    pending.bubble.appendChild(errDiv);
    toast(err.message, "error", 7000);
  } finally {
    state.sending = false;
    els.chatSend.disabled = false;
    els.chatInput.focus();
  }
}

// --------------------------------------------------------------------------
// Minimal, safe markdown renderer (escape first, then format)
// --------------------------------------------------------------------------
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    )
    .replace(
      /(^|[\s(])((https?:\/\/)[^\s)]+)(?=$|[\s).,])/g,
      '$1<a href="$2" target="_blank" rel="noopener">$2</a>',
    );
}

function renderMarkdown(md) {
  const src = escapeHtml(md || "");
  const lines = src.split("\n");
  let html = "";
  let i = 0;

  const flushParagraph = (buf) => {
    if (buf.length) html += `<p>${renderInline(buf.join(" "))}</p>`;
    return [];
  };

  let para = [];
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line.trim())) {
      para = flushParagraph(para);
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++;
      html += `<pre><code>${code.join("\n")}</code></pre>`;
      continue;
    }

    // Table (header row followed by a separator row of dashes/pipes)
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      para = flushParagraph(para);
      const parseRow = (r) =>
        r
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const headers = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      let t = "<table><thead><tr>";
      headers.forEach((h) => (t += `<th>${renderInline(h)}</th>`));
      t += "</tr></thead><tbody>";
      rows.forEach((r) => {
        t += "<tr>";
        r.forEach((c) => (t += `<td>${renderInline(c)}</td>`));
        t += "</tr>";
      });
      t += "</tbody></table>";
      html += t;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      para = flushParagraph(para);
      const level = h[1].length;
      html += `<h${level}>${renderInline(h[2])}</h${level}>`;
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      para = flushParagraph(para);
      let list = "<ul>";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        list += `<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`;
        i++;
      }
      list += "</ul>";
      html += list;
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      para = flushParagraph(para);
      let list = "<ol>";
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        list += `<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`;
        i++;
      }
      list += "</ol>";
      html += list;
      continue;
    }

    // Blank line ends a paragraph
    if (line.trim() === "") {
      para = flushParagraph(para);
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushParagraph(para);
  return html;
}

// --------------------------------------------------------------------------
// Auth redirect handling
// --------------------------------------------------------------------------
function handleAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get("auth");
  if (!auth) return;
  if (auth === "success") {
    toast("Authorization successful — connected!", "success");
  } else if (auth === "error") {
    toast(`Authorization failed: ${params.get("message") || "unknown error"}`, "error", 8000);
  }
  // Clean up the URL.
  window.history.replaceState({}, document.title, window.location.pathname);
}

// --------------------------------------------------------------------------
// Wire up events
// --------------------------------------------------------------------------
els.connectBtn.addEventListener("click", connect);
els.logoutBtn.addEventListener("click", logout);
els.runBtn.addEventListener("click", runTool);
els.toolSearch.addEventListener("input", renderToolList);
els.tabs.forEach((t) =>
  t.addEventListener("click", () => setMode(t.dataset.mode)),
);

// View tabs (Assistant / Tools)
els.viewTabs.forEach((t) =>
  t.addEventListener("click", () => switchView(t.dataset.view)),
);

// Chat composer
els.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendChat();
});
els.chatInput.addEventListener("input", autosizeInput);
els.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// Example prompt chips: fill the input and send immediately.
els.promptGrid.querySelectorAll(".prompt-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    // Use only the prompt text, not the category label.
    const goal = chip.querySelector(".prompt-goal");
    const text = chip.textContent
      .replace(goal ? goal.textContent : "", "")
      .replace(/\s+/g, " ")
      .trim();
    sendChat(text);
  });
});

handleAuthRedirect();
initAgent();
refreshStatus();
