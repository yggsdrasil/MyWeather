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
};

const state = {
  groups: [],
  selected: null, // currently selected tool object
  mode: "form", // "form" | "json"
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
    els.toolList.innerHTML = "";
    els.detailContent.classList.add("hidden");
    els.detailEmpty.classList.remove("hidden");
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

handleAuthRedirect();
refreshStatus();
