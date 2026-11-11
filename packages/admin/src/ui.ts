/**
 * Static operator console for the admin API. Assets are served from the same
 * origin under `/ui/` and are intentionally dependency-free: no build step, no
 * remote fonts, no analytics, and no inline script, so the CSP can stay strict.
 *
 * The bearer token lives in a password input and a module-scoped variable only.
 * It is never written to localStorage, cookies, URLs, or the page output.
 */
export const ADMIN_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>ChainMcp Web Studio — Declarative admin</title>
    <link rel="stylesheet" href="/ui/app.css" />
  </head>
  <body>
    <header class="site-header">
      <h1>ChainMcp Web Studio — Declarative tool admin</h1>
      <p>
        Self-hosted visual studio and operator console for validating, previewing, and publishing
        descriptor-backed tools. Validation and preview never contact the
        upstream API; publishing goes through the dynamic gateway.
      </p>
    </header>

    <main>
      <section class="card">
        <h2>Connection</h2>
        <div class="grid">
          <label>
            Admin token
            <input
              id="token"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="Bearer token"
            />
          </label>
          <label>
            Contract
            <select id="contract">
              <option value="">Load contracts to choose one</option>
            </select>
          </label>
        </div>
        <div class="actions">
          <button id="load" type="button">Load contracts</button>
          <button id="revisions" type="button">Load revisions</button>
          <span id="status" class="status" role="status" aria-live="polite"></span>
          <span id="studio-status" class="status" role="status" aria-live="polite"></span>
        </div>
        <p class="hint">
          The token stays in this page's memory. Nothing is persisted by the
          browser.
        </p>
      </section>

      <section class="card" id="tools-section">
        <div class="card-heading">
          <h2>Tools &amp; Curation</h2>
          <button id="load-tools" type="button" class="secondary">
            Refresh tools
          </button>
        </div>
        <div id="tools-list" class="tools-list">
          <p class="hint">Load a contract to inspect and curate its endpoints.</p>
        </div>
        <p class="hint">
          Prune unused tools or endpoints to eliminate LLM context bloat. Toggling
          active status updates active revisions and syncs with configuration.
        </p>
      </section>

      <section class="card" id="playground-section">
        <div class="card-heading">
          <h2>Interactive Projection Playground</h2>
          <span class="badge" id="playground-tool-badge">Select a tool</span>
        </div>
        <p class="hint">
          Test-fire tools against upstream APIs in sandboxed, non-cached mode.
          Configure field inclusion and exclusion paths to inspect raw vs projected
          payloads side by side and calculate context token savings.
        </p>

        <div class="grid">
          <label>
            Tool to test
            <select id="pg-tool-select">
              <option value="">Load tools first</option>
            </select>
          </label>
          <label>
            Include fields (comma-separated, e.g. <code>id, name</code>)
            <input id="pg-include" spellcheck="false" placeholder="id, name, email" />
          </label>
        </div>

        <div class="grid">
          <label>
            Exclude fields (comma-separated, e.g. <code>metadata, internalId</code>)
            <input id="pg-exclude" spellcheck="false" placeholder="metadata, internalId" />
          </label>
          <div class="playground-tokens" id="pg-metrics-summary">
            <span class="token-metric">Raw: <strong id="m-raw-tokens">-</strong> tokens</span>
            <span class="token-metric">Projected: <strong id="m-proj-tokens">-</strong> tokens</span>
            <span class="token-metric savings">Reduction: <strong id="m-savings-pct">-</strong></span>
          </div>
        </div>

        <label for="pg-arguments">Arguments (JSON object)<textarea id="pg-arguments" rows="4" spellcheck="false">{}</textarea></label>

        <div class="actions">
          <button id="pg-test-fire" type="button" class="primary">Test Fire Upstream</button>
          <span id="pg-status" class="status" role="status" aria-live="polite"></span>
        </div>

        <div class="playground-diff-grid">
          <div>
            <h3>Raw Upstream Output</h3>
            <pre id="pg-raw-output">Ready to fire.</pre>
          </div>
          <div>
            <h3>Projected LLM Output</h3>
            <pre id="pg-projected-output">Ready to fire.</pre>
          </div>
        </div>
      </section>

      <section class="card" id="observability-section">
        <div class="card-heading">
          <h2>Shield &amp; OTel Observability</h2>
          <div class="header-actions">
            <label class="inline-select">
              Live Auto-Refresh
              <select id="obs-auto-refresh">
                <option value="0">Off</option>
                <option value="3000">Every 3s</option>
                <option value="5000">Every 5s</option>
                <option value="10000">Every 10s</option>
              </select>
            </label>
            <button id="obs-refresh" type="button" class="secondary">
              Refresh metrics
            </button>
          </div>
        </div>
        <p class="hint">
          Real-time governance, token accounting, cache shield efficiency, and
          OTel span correlation querying directly from storage.
        </p>

        <div class="grid filter-bar">
          <label>
            Time Window
            <select id="obs-time-window">
              <option value="300000">Last 5 minutes</option>
              <option value="900000">Last 15 minutes</option>
              <option value="3600000" selected>Last 1 hour</option>
              <option value="86400000">Last 24 hours</option>
            </select>
          </label>
          <label>
            Tool Filter
            <select id="obs-tool-filter">
              <option value="">All Tools</option>
            </select>
          </label>
          <label>
            Status
            <select id="obs-status-filter">
              <option value="all">All (Success &amp; Error)</option>
              <option value="success">Success only</option>
              <option value="error">Errors only</option>
            </select>
          </label>
        </div>

        <div class="metrics-cards-grid" id="obs-metrics-cards">
          <div class="metric-card">
            <span class="metric-title">Invocation Volume</span>
            <span class="metric-value" id="m-val-requests">0</span>
            <span class="metric-sub" id="m-sub-requests">0 errors</span>
          </div>
          <div class="metric-card">
            <span class="metric-title">Shield Cache Hit Ratio</span>
            <span class="metric-value highlight" id="m-val-cache">0%</span>
            <span class="metric-sub" id="m-sub-cache">0 cached requests</span>
          </div>
          <div class="metric-card">
            <span class="metric-title">Error Rate</span>
            <span class="metric-value" id="m-val-errors">0%</span>
            <span class="metric-sub" id="m-sub-errors">healthy</span>
          </div>
          <div class="metric-card">
            <span class="metric-title">Token Consumption</span>
            <span class="metric-value" id="m-val-tokens">0</span>
            <span class="metric-sub" id="m-sub-tokens">0 avg / req</span>
          </div>
          <div class="metric-card">
            <span class="metric-title">p95 Latency</span>
            <span class="metric-value" id="m-val-p95">0ms</span>
            <span class="metric-sub" id="m-sub-latency">p50: 0ms | p99: 0ms</span>
          </div>
        </div>

        <div class="telemetry-table-container">
          <h3>Recent Invocations &amp; Spans</h3>
          <table class="telemetry-table" id="obs-telemetry-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Tool</th>
                <th>Status</th>
                <th>Cache</th>
                <th>Duration</th>
                <th>Tokens</th>
                <th>Trace / Span</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="obs-telemetry-body">
              <tr>
                <td colspan="8" class="empty-state">No recent events recorded.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div id="obs-detail-modal" class="modal-backdrop hidden">
          <div class="modal-card">
            <div class="modal-heading">
              <h3>Telemetry Event Details</h3>
              <button id="obs-modal-close" type="button" class="close-btn">&times;</button>
            </div>
            <pre id="obs-modal-content">Loading...</pre>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-heading">
          <h2>Builder</h2>
          <button id="example" type="button" class="secondary">
            Reset example
          </button>
        </div>
        <div class="grid">
          <label>Name<input id="b-name" spellcheck="false" placeholder="get_user" /></label>
          <label>Method
            <select id="b-method">
              <option>GET</option><option>POST</option><option>PUT</option>
              <option>PATCH</option><option>DELETE</option><option>HEAD</option>
            </select>
          </label>
          <label>Path<input id="b-path" spellcheck="false" placeholder="/users/{userId}" /></label>
        </div>
        <label for="b-description">Description<textarea id="b-description" rows="2"></textarea></label>
        <label>Parameter (name)<input id="b-p-name" spellcheck="false" placeholder="userId" /></label>
        <label>Parameter location
          <select id="b-p-in"><option>path</option><option>query</option><option>header</option><option>cookie</option></select>
        </label>
        <label>Parameter type
          <select id="b-p-type"><option>string</option><option>number</option><option>integer</option><option>boolean</option></select>
        </label>
        <div class="actions"><button id="add-param" type="button" class="secondary">Add parameter</button></div>
        <label class="sr-only" for="descriptors">Descriptor JSON</label>
        <textarea id="descriptors" spellcheck="false" rows="16"></textarea>
        <div class="actions">
          <button id="validate" type="button">Validate</button>
          <button id="preview" type="button">Preview</button>
          <button id="publish" type="button" class="primary">Publish</button>
          <button id="rollback" type="button" class="secondary">
            Roll back to revision
          </button>
        </div>
        <p class="hint">
          Publishing replaces the contract's active toolset with this
          descriptor set. Descriptors are re-validated and lowered through the
          same bounded executor as compiled contracts. Rollback republishes a
          stored revision, so it also works after a restart when the admin
          server uses a durable store.
        </p>
      </section>

      <section class="card">
        <h2>Result</h2>
        <pre id="output" aria-live="polite">Ready.</pre>
      </section>
    </main>

    <noscript>This console requires JavaScript. The API is usable directly.</noscript>
    <script src="/ui/app.js"></script>
  </body>
</html>
`;

export const ADMIN_APP_CSS = `:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --card: #ffffff;
  --border: #d9dee6;
  --text: #1b2028;
  --muted: #5d6673;
  --accent: #1f6feb;
  --danger: #b42318;
  --ok: #0f7b3f;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151a;
    --card: #1a1e25;
    --border: #2d333d;
    --text: #e7ebf0;
    --muted: #9aa4b2;
    --accent: #4c8dff;
    --danger: #ff8a7a;
    --ok: #58d68d;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 2rem 1.25rem 4rem;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}

.site-header,
main {
  max-width: 60rem;
  margin: 0 auto;
}

.site-header h1 {
  margin: 0 0 0.35rem;
  font-size: 1.6rem;
}

.site-header p {
  margin: 0 0 1.5rem;
  color: var(--muted);
  max-width: 46rem;
}

.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem 1.15rem 1.15rem;
  margin-bottom: 1.15rem;
}

.card h2 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
  letter-spacing: 0.01em;
}

.card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.85rem;
}

label {
  display: block;
  font-size: 0.85rem;
  color: var(--muted);
}

input,
select,
textarea {
  display: block;
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 0.9rem;
}

textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.82rem;
  resize: vertical;
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}

textarea:focus-visible,
input:focus-visible,
select:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.9rem;
}

button {
  padding: 0.45rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 0.88rem;
  cursor: pointer;
}

button:hover:not(:disabled) {
  border-color: var(--accent);
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}

button.secondary {
  font-size: 0.8rem;
}

button:disabled {
  opacity: 0.55;
  cursor: progress;
}

.status {
  font-size: 0.85rem;
  color: var(--muted);
}

.status.ok {
  color: var(--ok);
}

.status.error {
  color: var(--danger);
}

.tools-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.tool-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 0.75rem 1rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  gap: 1rem;
}

.tool-info {
  flex: 1;
}

.tool-header-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.tool-name {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9rem;
}

.badge {
  font-size: 0.7rem;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}

.badge.enabled {
  background: rgba(15, 123, 63, 0.15);
  color: var(--ok);
}

.badge.disabled {
  background: rgba(180, 35, 24, 0.15);
  color: var(--danger);
}

.tool-desc {
  font-size: 0.85rem;
  color: var(--muted);
  margin-bottom: 0.5rem;
}

.tool-schema {
  margin-top: 0.35rem;
  font-size: 0.75rem;
  max-height: 10rem;
}

.tool-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5rem;
}

.playground-diff-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  margin-top: 1rem;
}

@media (max-width: 768px) {
  .playground-diff-grid {
    grid-template-columns: 1fr;
  }
}

.playground-tokens {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
}

.token-metric.savings strong {
  color: var(--ok);
}

.hint {
  margin: 0.75rem 0 0;
  font-size: 0.8rem;
  color: var(--muted);
}

pre {
  margin: 0;
  padding: 0.85rem;
  min-height: 6rem;
  max-height: 34rem;
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.inline-select {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
}

.inline-select select {
  margin: 0;
  padding: 0.35rem 0.5rem;
  font-size: 0.8rem;
}

.metrics-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem;
  margin: 1rem 0;
}

.metric-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
}

.metric-title {
  font-size: 0.75rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 0.25rem;
}

.metric-value {
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1.2;
}

.metric-value.highlight {
  color: var(--ok);
}

.metric-sub {
  font-size: 0.75rem;
  color: var(--muted);
  margin-top: 0.25rem;
}

.telemetry-table-container {
  margin-top: 1.25rem;
  overflow-x: auto;
}

.telemetry-table-container h3 {
  font-size: 0.9rem;
  margin: 0 0 0.5rem;
}

.telemetry-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
  text-align: left;
}

.telemetry-table th,
.telemetry-table td {
  padding: 0.5rem 0.65rem;
  border-bottom: 1px solid var(--border);
}

.telemetry-table th {
  color: var(--muted);
  font-weight: 600;
  border-top: 1px solid var(--border);
}

.badge.cached {
  background: rgba(14, 116, 144, 0.15);
  color: var(--brand);
}

.badge.trace {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.7rem;
  text-transform: none;
  background: rgba(120, 120, 120, 0.12);
  color: var(--fg);
}

.empty-state {
  text-align: center;
  color: var(--muted);
  padding: 1.5rem !important;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-backdrop.hidden {
  display: none;
}

.modal-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  width: 90%;
  max-width: 44rem;
  max-height: 85vh;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
}

.modal-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.modal-heading h3 {
  margin: 0;
  font-size: 1.1rem;
}

.close-btn {
  background: transparent;
  border: none;
  font-size: 1.4rem;
  cursor: pointer;
  color: var(--muted);
  padding: 0 0.4rem;
}

.close-btn:hover {
  color: var(--fg);
}

noscript {
  display: block;
  max-width: 60rem;
  margin: 1rem auto 0;
  color: var(--muted);
}
`;

export const ADMIN_APP_JS = `(function () {
  "use strict";

  var EXAMPLE = [
    {
      descriptorVersion: 1,
      name: "get_user",
      description: "Fetches one user from the upstream directory",
      request: {
        method: "GET",
        path: "/users/{userId}",
        parameters: [
          { name: "userId", in: "path", required: true },
          { name: "limit", in: "query" }
        ]
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["userId"],
        properties: {
          userId: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        }
      },
      policy: { cacheTtlSeconds: 30, timeoutMs: 10000 }
    }
  ];

  var tokenInput = document.getElementById("token");
  var contractSelect = document.getElementById("contract");
  var textarea = document.getElementById("descriptors");
  var output = document.getElementById("output");
  var status = document.getElementById("status");
  var toolsList = document.getElementById("tools-list");
  var pgToolSelect = document.getElementById("pg-tool-select");
  var pgInclude = document.getElementById("pg-include");
  var pgExclude = document.getElementById("pg-exclude");
  var pgArguments = document.getElementById("pg-arguments");
  var pgRawOutput = document.getElementById("pg-raw-output");
  var pgProjectedOutput = document.getElementById("pg-projected-output");
  var pgStatus = document.getElementById("pg-status");
  var pgBadge = document.getElementById("playground-tool-badge");
  var mRawTokens = document.getElementById("m-raw-tokens");
  var mProjTokens = document.getElementById("m-proj-tokens");
  var mSavingsPct = document.getElementById("m-savings-pct");
  var buttons = [
    document.getElementById("load"),
    document.getElementById("revisions"),
    document.getElementById("load-tools"),
    document.getElementById("pg-test-fire"),
    document.getElementById("validate"),
    document.getElementById("preview"),
    document.getElementById("publish"),
    document.getElementById("rollback"),
    document.getElementById("example")
  ];
  var contracts = [];

  function setStatus(message, kind) {
    status.textContent = message;
    status.className = "status" + (kind ? " " + kind : "");
  }

  function setBusy(busy) {
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].disabled = busy;
    }
  }

  function show(title, payload) {
    output.textContent = title + "\\n\\n" + JSON.stringify(payload, null, 2);
  }

  function showError(error) {
    output.textContent = String(error);
    setStatus("Request failed", "error");
  }

  function selectedContract() {
    var picked = contracts[contractSelect.selectedIndex];
    if (!picked) throw new Error("Load contracts and choose one first");
    return picked;
  }

  function endpoint(action) {
    var picked = selectedContract();
    return (
      "/api/v1/tenants/" +
      encodeURIComponent(picked.tenantId) +
      "/contracts/" +
      encodeURIComponent(picked.contractName) +
      "/" +
      action
    );
  }

  function authorization() {
    var token = tokenInput.value.trim();
    if (!token) throw new Error("Enter an admin bearer token");
    return "Bearer " + token;
  }

  function readDescriptors() {
    var parsed;
    try {
      parsed = JSON.parse(textarea.value);
    } catch (error) {
      throw new Error("Descriptor editor does not contain valid JSON: " + error.message);
    }
    if (!Array.isArray(parsed)) throw new Error("Descriptors must be a JSON array");
    return parsed;
  }

  async function request(method, path, body) {
    var headers = { authorization: authorization() };
    if (body !== undefined) headers["content-type"] = "application/json";
    var response = await fetch(path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit"
    });
    var text = await response.text();
    var payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (ignored) {
      payload = text;
    }
    return { status: response.status, ok: response.ok, payload: payload };
  }

  async function loadContracts() {
    var result = await request("GET", "/api/v1/contracts");
    if (!result.ok) {
      show("Contracts", result);
      setStatus("HTTP " + result.status, "error");
      return;
    }
    contracts = result.payload.contracts || [];
    contractSelect.textContent = "";
    if (contracts.length === 0) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "No contracts are bound to this token";
      contractSelect.appendChild(empty);
      setStatus("No contracts bound", "error");
      return;
    }
    for (var i = 0; i < contracts.length; i += 1) {
      var option = document.createElement("option");
      option.value = String(i);
      option.textContent = contracts[i].tenantId + " / " + contracts[i].contractName;
      contractSelect.appendChild(option);
    }
    show("Contracts", result.payload);
    setStatus(contracts.length + " contract(s)", "ok");
    await loadTools();
  }

  async function loadTools() {
    if (!toolsList) return;
    var picked;
    try {
      picked = selectedContract();
    } catch {
      toolsList.textContent = "";
      var hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Load a contract to inspect and curate its endpoints.";
      toolsList.appendChild(hint);
      return;
    }
    var result = await request("GET", endpoint("tools"));
    if (!result.ok) {
      show("Tools", result);
      setStatus("Failed to load tools: HTTP " + result.status, "error");
      return;
    }
    var tools = (result.payload && result.payload.tools) || [];
    toolsList.textContent = "";
    if (pgToolSelect) {
      pgToolSelect.textContent = "";
    }
    if (obsToolFilter) {
      obsToolFilter.textContent = "";
      var allOpt = document.createElement("option");
      allOpt.value = "";
      allOpt.textContent = "All Tools";
      obsToolFilter.appendChild(allOpt);
    }
    if (tools.length === 0) {
      var emptyMsg = document.createElement("p");
      emptyMsg.className = "hint";
      emptyMsg.textContent = "No tools defined in this contract.";
      toolsList.appendChild(emptyMsg);
      if (pgBadge) pgBadge.textContent = "No tools";
      loadObservabilityMetrics().catch(function () {});
      return;
    }

    if (pgBadge && tools.length > 0) {
      pgBadge.textContent = tools[0].name;
    }

    for (var i = 0; i < tools.length; i += 1) {
      if (pgToolSelect) {
        var opt = document.createElement("option");
        opt.value = tools[i].name;
        opt.textContent = tools[i].name + (tools[i].enabled === false ? " (pruned)" : "");
        pgToolSelect.appendChild(opt);
      }
      if (obsToolFilter) {
        var toOpt = document.createElement("option");
        toOpt.value = tools[i].name;
        toOpt.textContent = tools[i].name;
        obsToolFilter.appendChild(toOpt);
      }
      (function (tool) {
        var item = document.createElement("div");
        item.className = "tool-item";

        var info = document.createElement("div");
        info.className = "tool-info";

        var headerRow = document.createElement("div");
        headerRow.className = "tool-header-row";

        var nameSpan = document.createElement("span");
        nameSpan.className = "tool-name";
        nameSpan.textContent = tool.name;
        headerRow.appendChild(nameSpan);

        var badge = document.createElement("span");
        badge.className = "badge " + (tool.enabled !== false ? "enabled" : "disabled");
        badge.textContent = tool.enabled !== false ? "Active" : "Pruned";
        headerRow.appendChild(badge);

        info.appendChild(headerRow);

        if (tool.description) {
          var descP = document.createElement("div");
          descP.className = "tool-desc";
          descP.textContent = tool.description;
          info.appendChild(descP);
        }

        if (tool.inputSchema) {
          var schemaDetails = document.createElement("details");
          var summary = document.createElement("summary");
          summary.textContent = "Input Schema";
          summary.className = "hint";
          summary.style.cursor = "pointer";
          schemaDetails.appendChild(summary);
          var pre = document.createElement("pre");
          pre.className = "tool-schema";
          pre.textContent = JSON.stringify(tool.inputSchema, null, 2);
          schemaDetails.appendChild(pre);
          info.appendChild(schemaDetails);
        }

        item.appendChild(info);

        var actions = document.createElement("div");
        actions.className = "tool-actions";

        var toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = tool.enabled !== false ? "secondary" : "primary";
        toggleBtn.textContent = tool.enabled !== false ? "Prune" : "Enable";
        toggleBtn.addEventListener("click", action(async function () {
          var targetEnabled = tool.enabled === false;
          var patchRes = await request(
            "PATCH",
            endpoint("tools/" + encodeURIComponent(tool.name)),
            { enabled: targetEnabled }
          );
          if (!patchRes.ok) {
            show("Curate Tool", patchRes);
            setStatus(
              "Curate failed: HTTP " + patchRes.status + (patchRes.payload && patchRes.payload.error ? " · " + patchRes.payload.error.code : ""),
              "error"
            );
            return;
          }
          setStatus("Tool '" + tool.name + "' " + (targetEnabled ? "enabled" : "pruned"), "ok");
          await loadTools();
        }));

        var playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "secondary";
        playBtn.textContent = "Playground";
        playBtn.addEventListener("click", function () {
          if (pgToolSelect) pgToolSelect.value = tool.name;
          if (pgBadge) pgBadge.textContent = tool.name;
          var el = document.getElementById("playground-section");
          if (el) el.scrollIntoView({ behavior: "smooth" });
          if (pgArguments) pgArguments.focus();
        });

        actions.appendChild(toggleBtn);
        actions.appendChild(playBtn);
        item.appendChild(actions);

        toolsList.appendChild(item);
      })(tools[i]);
    }
    loadObservabilityMetrics().catch(function () {});
  }

  async function testFireTool() {
    var toolName = pgToolSelect ? pgToolSelect.value : "";
    if (!toolName) {
      setStatus("Select a tool to test first", "error");
      return;
    }
    var parsedArgs = {};
    var rawArgs = pgArguments ? pgArguments.value.trim() : "";
    if (rawArgs) {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch (err) {
        showError("Arguments must be valid JSON: " + (err && err.message ? err.message : String(err)));
        return;
      }
    }
    var body = { arguments: parsedArgs };
    var inc = pgInclude ? pgInclude.value.trim() : "";
    var exc = pgExclude ? pgExclude.value.trim() : "";
    if (inc || exc) {
      body.projection = {};
      if (inc) body.projection.include = inc.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      if (exc) body.projection.exclude = exc.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    }

    if (pgStatus) {
      pgStatus.textContent = "Test firing upstream...";
      pgStatus.className = "status";
    }

    var res = await request(
      "POST",
      endpoint("tools/" + encodeURIComponent(toolName) + "/test"),
      body
    );

    if (!res.ok) {
      if (pgRawOutput) pgRawOutput.textContent = JSON.stringify(res.payload, null, 2);
      if (pgProjectedOutput) pgProjectedOutput.textContent = "Execution failed.";
      if (pgStatus) {
        pgStatus.textContent = "HTTP " + res.status + " · Test failed";
        pgStatus.className = "status error";
      }
      loadObservabilityMetrics().catch(function () {});
      return;
    }

    var data = res.payload;
    if (pgRawOutput) pgRawOutput.textContent = JSON.stringify(data.raw, null, 2);
    if (pgProjectedOutput) pgProjectedOutput.textContent = JSON.stringify(data.projected, null, 2);
    if (data.metrics) {
      if (mRawTokens) mRawTokens.textContent = String(data.metrics.rawTokens);
      if (mProjTokens) mProjTokens.textContent = String(data.metrics.projectedTokens);
      if (mSavingsPct) mSavingsPct.textContent = data.metrics.percentSavings + "% (" + data.metrics.savedTokens + " tokens)";
    }
    if (pgStatus) {
      pgStatus.textContent = "HTTP 200 · " + data.executionTimeMs + " ms";
      pgStatus.className = "status ok";
    }
    setStatus("Tool '" + toolName + "' test fired in " + data.executionTimeMs + " ms", "ok");
    loadObservabilityMetrics().catch(function () {});
  }

  async function submit(action) {
    var body = { descriptors: readDescriptors() };
    var result = await request("POST", endpoint(action), body);
    show(action.toUpperCase() + " HTTP " + result.status, result.payload);
    if (!result.ok) {
      setStatus(
        "HTTP " + result.status + (result.payload && result.payload.error ? " · " + result.payload.error.code : ""),
        "error"
      );
      return;
    }
    var count = result.payload && result.payload.tools ? result.payload.tools.length : 0;
    setStatus("HTTP " + result.status + " · " + count + " tool(s)", "ok");
  }

  async function loadRevisions() {
    var result = await request("GET", endpoint("revisions"));
    show("REVISIONS HTTP " + result.status, result.payload);
    if (!result.ok) {
      setStatus("HTTP " + result.status, "error");
      return;
    }
    var count = result.payload && result.payload.revisions ? result.payload.revisions.length : 0;
    setStatus(count + " revision(s)", "ok");
  }

  function action(handler) {
    return async function () {
      setBusy(true);
      try {
        await handler();
      } catch (error) {
        showError(error && error.message ? error.message : error);
      } finally {
        setBusy(false);
      }
    };
  }

  document.getElementById("load").addEventListener("click", action(loadContracts));
  document.getElementById("revisions").addEventListener("click", action(loadRevisions));
  document.getElementById("load-tools").addEventListener("click", action(loadTools));
  if (pgToolSelect) {
    pgToolSelect.addEventListener("change", function () {
      if (pgBadge) pgBadge.textContent = pgToolSelect.value;
    });
  }
  var testFireBtn = document.getElementById("pg-test-fire");
  if (testFireBtn) {
    testFireBtn.addEventListener("click", action(testFireTool));
  }
  contractSelect.addEventListener("change", action(loadTools));
  document.getElementById("validate").addEventListener("click", action(function () {
    return submit("validate");
  }));
  document.getElementById("preview").addEventListener("click", action(function () {
    return submit("preview");
  }));
  document.getElementById("publish").addEventListener("click", action(async function () {
    var picked = selectedContract();
    var confirmed = window.confirm(
      "Replace the active toolset of " + picked.tenantId + " / " + picked.contractName + "?"
    );
    if (!confirmed) {
      setStatus("Publish cancelled");
      return;
    }
    await submit("publish");
    await loadTools();
  }));
  document.getElementById("rollback").addEventListener("click", action(async function () {
    var picked = selectedContract();
    var revisionId = window.prompt(
      "Stored revision id to restore for " + picked.tenantId + " / " + picked.contractName + " (dset_…):"
    );
    if (!revisionId) {
      setStatus("Rollback cancelled");
      return;
    }
    var result = await request("POST", endpoint("rollback"), {
      revisionId: revisionId.trim()
    });
    show("ROLLBACK HTTP " + result.status, result.payload);
    if (!result.ok) {
      setStatus(
        "HTTP " + result.status + (result.payload && result.payload.error ? " · " + result.payload.error.code : ""),
        "error"
      );
      return;
    }
    setStatus("Rolled back to " + revisionId.trim(), "ok");
    await loadTools();
  }));
  document.getElementById("example").addEventListener("click", function () {
    textarea.value = JSON.stringify(EXAMPLE, null, 2);
    setStatus("Example restored");
  });

  textarea.value = JSON.stringify(EXAMPLE, null, 2);

  // ---- Visual builder: forms emit one descriptor (array of one) ----
  var bName = document.getElementById("b-name");
  var bMethod = document.getElementById("b-method");
  var bPath = document.getElementById("b-path");
  var bDesc = document.getElementById("b-description");
  var bPName = document.getElementById("b-p-name");
  var bPIn = document.getElementById("b-p-in");
  var bPType = document.getElementById("b-p-type");
  var params = [];

  function emitDescriptor() {
    var name = bName.value.trim() || "example_tool";
    var props = {};
    var required = [];
    var requestParams = [];
    for (var i = 0; i < params.length; i += 1) {
      props[params[i].name] = { type: params[i].type };
      if (params[i].in === "path") required.push(params[i].name);
      requestParams.push({ name: params[i].name, in: params[i].in, required: params[i].in === "path" });
    }
    var descriptor = {
      descriptorVersion: 1,
      name: name,
      description: bDesc.value.trim() || "Descriptor built in the visual builder",
      request: {
        method: bMethod.value,
        path: bPath.value.trim() || "/example",
        ...(requestParams.length > 0 ? { parameters: requestParams } : {})
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        ...(required.length > 0 ? { required: required } : {}),
        properties: props
      }
    };
    textarea.value = JSON.stringify([descriptor], null, 2);
  }

  [bName, bMethod, bPath, bDesc].forEach(function (el) {
    if (el) el.addEventListener("input", emitDescriptor);
    if (el) el.addEventListener("change", emitDescriptor);
  });
  var addParam = document.getElementById("add-param");
  if (addParam) {
    addParam.addEventListener("click", function () {
      var n = bPName.value.trim();
      if (!n) {
        setStatus("Enter a parameter name first", "error");
        return;
      }
      params.push({ name: n, in: bPIn.value, type: bPType.value });
      bPName.value = "";
      emitDescriptor();
      setStatus("Parameter added: " + n, "ok");
    });
  }
  // Observability & Shield Dashboard controller
  var obsAutoRefresh = document.getElementById("obs-auto-refresh");
  var obsRefreshBtn = document.getElementById("obs-refresh");
  var obsTimeWindow = document.getElementById("obs-time-window");
  var obsToolFilter = document.getElementById("obs-tool-filter");
  var obsStatusFilter = document.getElementById("obs-status-filter");
  var mValRequests = document.getElementById("m-val-requests");
  var mSubRequests = document.getElementById("m-sub-requests");
  var mValCache = document.getElementById("m-val-cache");
  var mSubCache = document.getElementById("m-sub-cache");
  var mValErrors = document.getElementById("m-val-errors");
  var mSubErrors = document.getElementById("m-sub-errors");
  var mValTokens = document.getElementById("m-val-tokens");
  var mSubTokens = document.getElementById("m-sub-tokens");
  var mValP95 = document.getElementById("m-val-p95");
  var mSubLatency = document.getElementById("m-sub-latency");
  var obsTelemetryBody = document.getElementById("obs-telemetry-body");
  var obsDetailModal = document.getElementById("obs-detail-modal");
  var obsModalContent = document.getElementById("obs-modal-content");
  var obsModalClose = document.getElementById("obs-modal-close");
  var obsTimer = null;

  async function loadObservabilityMetrics() {
    var windowMs = obsTimeWindow ? Number(obsTimeWindow.value || 3600000) : 3600000;
    var until = Date.now();
    var since = until - windowMs;
    var tool = obsToolFilter ? obsToolFilter.value : "";
    var statusVal = obsStatusFilter ? obsStatusFilter.value : "all";

    var qs = "since=" + since + "&until=" + until;
    if (tool) qs += "&tool=" + encodeURIComponent(tool);

    var picked;
    try {
      picked = selectedContract();
    } catch {
      picked = null;
    }

    var metricsPath = picked
      ? "/api/v1/tenants/" + encodeURIComponent(picked.tenantId) + "/telemetry/metrics?" + qs
      : "/api/v1/telemetry/metrics?" + qs;

    var telemPath = picked
      ? "/api/v1/tenants/" + encodeURIComponent(picked.tenantId) + "/telemetry?" + qs
      : "/api/v1/telemetry?" + qs;

    if (statusVal && statusVal !== "all") {
      telemPath += "&status=" + encodeURIComponent(statusVal);
    }
    telemPath += "&limit=50&order=desc";

    var [metricsRes, telemRes] = await Promise.all([
      request("GET", metricsPath),
      request("GET", telemPath)
    ]);

    if (metricsRes.ok && metricsRes.payload && metricsRes.payload.summary) {
      var s = metricsRes.payload.summary;
      if (mValRequests) mValRequests.textContent = Number(s.totalRequests || 0).toLocaleString();
      if (mSubRequests) mSubRequests.textContent = (s.totalErrors || 0) + " errors (" + Math.round((s.errorRate || 0) * 100) + "%)";
      if (mValCache) mValCache.textContent = Math.round((s.cacheHitRatio || 0) * 100) + "%";
      if (mSubCache) mSubCache.textContent = (s.totalCached || 0) + " cached requests";
      if (mValErrors) mValErrors.textContent = Math.round((s.errorRate || 0) * 100) + "%";
      if (mSubErrors) mSubErrors.textContent = s.totalErrors > 0 ? s.totalErrors + " failed" : "healthy";
      if (mValTokens) mValTokens.textContent = Number(s.totalTokens || 0).toLocaleString();
      if (mSubTokens) mSubTokens.textContent = (s.avgTokensPerRequest || 0) + " avg / req";
      if (mValP95) mValP95.textContent = (s.p95DurationMs || 0) + "ms";
      if (mSubLatency) mSubLatency.textContent = "p50: " + (s.p50DurationMs || 0) + "ms | p99: " + (s.p99DurationMs || 0) + "ms";
    }

    if (telemRes.ok && telemRes.payload && Array.isArray(telemRes.payload.events) && obsTelemetryBody) {
      var events = telemRes.payload.events;
      obsTelemetryBody.textContent = "";
      if (events.length === 0) {
        var emptyRow = document.createElement("tr");
        var emptyCell = document.createElement("td");
        emptyCell.colSpan = 8;
        emptyCell.className = "empty-state";
        emptyCell.textContent = "No recent telemetry events recorded.";
        emptyRow.appendChild(emptyCell);
        obsTelemetryBody.appendChild(emptyRow);
      } else {
        events.forEach(function (ev) {
          var tr = document.createElement("tr");

          var tdTime = document.createElement("td");
          tdTime.textContent = new Date(ev.timestamp).toLocaleTimeString();
          tr.appendChild(tdTime);

          var tdTool = document.createElement("td");
          tdTool.className = "tool-name";
          tdTool.textContent = ev.toolName || "-";
          tr.appendChild(tdTool);

          var tdStatus = document.createElement("td");
          var stBadge = document.createElement("span");
          stBadge.className = "badge " + (ev.isError ? "disabled" : "enabled");
          stBadge.textContent = ev.isError ? (ev.errorCode || "error") : "ok";
          tdStatus.appendChild(stBadge);
          tr.appendChild(tdStatus);

          var tdCache = document.createElement("td");
          var cBadge = document.createElement("span");
          cBadge.className = "badge " + (ev.cached ? "cached" : "");
          cBadge.textContent = ev.cached ? "HIT" : "MISS";
          tdCache.appendChild(cBadge);
          tr.appendChild(tdCache);

          var tdDuration = document.createElement("td");
          tdDuration.textContent = ev.durationMs !== undefined ? ev.durationMs + "ms" : "-";
          tr.appendChild(tdDuration);

          var tdTokens = document.createElement("td");
          tdTokens.textContent = ev.tokenCount !== undefined ? String(ev.tokenCount) : "-";
          tr.appendChild(tdTokens);

          var tdTrace = document.createElement("td");
          if (ev.traceId) {
            var trBadge = document.createElement("span");
            trBadge.className = "badge trace";
            trBadge.title = ev.traceId;
            trBadge.textContent = ev.traceId.slice(0, 8) + "...";
            tdTrace.appendChild(trBadge);
          } else {
            tdTrace.textContent = "-";
          }
          tr.appendChild(tdTrace);

          var tdActions = document.createElement("td");
          var btnInspect = document.createElement("button");
          btnInspect.type = "button";
          btnInspect.className = "secondary";
          btnInspect.style.padding = "0.2rem 0.5rem";
          btnInspect.style.fontSize = "0.75rem";
          btnInspect.textContent = "Inspect";
          btnInspect.addEventListener("click", function () {
            if (obsModalContent) obsModalContent.textContent = JSON.stringify(ev, null, 2);
            if (obsDetailModal) obsDetailModal.classList.remove("hidden");
          });
          tdActions.appendChild(btnInspect);
          tr.appendChild(tdActions);

          obsTelemetryBody.appendChild(tr);
        });
      }
    }
  }

  if (obsRefreshBtn) {
    obsRefreshBtn.addEventListener("click", action(loadObservabilityMetrics));
  }
  if (obsTimeWindow) {
    obsTimeWindow.addEventListener("change", action(loadObservabilityMetrics));
  }
  if (obsToolFilter) {
    obsToolFilter.addEventListener("change", action(loadObservabilityMetrics));
  }
  if (obsStatusFilter) {
    obsStatusFilter.addEventListener("change", action(loadObservabilityMetrics));
  }
  if (obsAutoRefresh) {
    obsAutoRefresh.addEventListener("change", function () {
      if (obsTimer) {
        clearInterval(obsTimer);
        obsTimer = null;
      }
      var ms = Number(obsAutoRefresh.value || 0);
      if (ms > 0) {
        obsTimer = setInterval(function () {
          loadObservabilityMetrics().catch(function () {});
        }, ms);
      }
    });
  }
  if (obsModalClose && obsDetailModal) {
    obsModalClose.addEventListener("click", function () {
      obsDetailModal.classList.add("hidden");
    });
    obsDetailModal.addEventListener("click", function (e) {
      if (e.target === obsDetailModal) obsDetailModal.classList.add("hidden");
    });
  }

  async function checkStudioStatus() {
    try {
      var res = await fetch("/api/v1/status", { cache: "no-store" });
      if (res.ok) {
        var data = await res.json();
        var el = document.getElementById("studio-status");
        if (el && data && data.storage) {
          el.textContent = "Studio ready (" + (data.storage.driver || "memory") + " storage)";
          el.className = "status ok";
        }
      }
    } catch (ignored) {}
  }
  checkStudioStatus();
})();

`;
