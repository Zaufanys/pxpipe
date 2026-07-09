/**
 * Local "paste in, compress out" GUI — `src/core/export.ts` wrapped in a tiny
 * one-page browser app for ad hoc use (compress a big paste before attaching
 * it to a chat, no CLI/proxy/session setup).
 *
 * Fully local: the page only ever talks to THIS SAME local server (loopback),
 * which does a pure in-process render — no model API is called, no API key is
 * needed, nothing is sent anywhere. Runtime-agnostic (Web Request/Response),
 * same convention as core/proxy.ts; src/node.ts supplies the Node http server.
 */

import { runExportCore, DEFAULT_EXPORT_MODEL, DEFAULT_EXPORT_COLS, type ExportManifest } from './core/export.js';
import { bytesToBase64 } from './core/png.js';

/** Defensive cap on pasted input — generous for the "paste a big blob" use case
 *  while bounding worst-case render time/memory on a single request. */
const MAX_INPUT_CHARS = 2_000_000;

export const GUI_COMPRESS_ROUTE = '/api/compress';

export interface GuiArtifact {
  readonly filename: string;
  /** Present for image artifacts (page-*.png) — base64-encoded PNG bytes. */
  readonly base64?: string;
  /** Present for text artifacts (factsheet.txt, prompt.txt) — decoded text. */
  readonly text?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface GuiCompressResult {
  readonly manifest: ExportManifest;
  readonly artifacts: GuiArtifact[];
  readonly truncated: boolean;
}

/** Run the same render/report pipeline `pxpipe export` uses, shaped for the browser
 *  (base64 images, decoded text artifacts, manifest.json artifact dropped since the
 *  manifest is already returned as structured JSON). Pure — no fs, no network. */
export async function runGuiCompress(text: string): Promise<GuiCompressResult> {
  const truncated = text.length > MAX_INPUT_CHARS;
  const source = truncated ? text.slice(0, MAX_INPUT_CHARS) : text;
  const { manifest, artifacts } = await runExportCore(source, {
    sourceFiles: [],
    cols: DEFAULT_EXPORT_COLS,
    model: DEFAULT_EXPORT_MODEL,
  });
  const dec = new TextDecoder();
  const out: GuiArtifact[] = [];
  for (const a of artifacts) {
    if (a.filename === 'manifest.json') continue; // already returned as `manifest`
    if (a.filename.endsWith('.png')) {
      const page = manifest.pages.find((p) => p.filename === a.filename);
      out.push({ filename: a.filename, base64: bytesToBase64(a.data), width: page?.width, height: page?.height });
    } else {
      out.push({ filename: a.filename, text: dec.decode(a.data) });
    }
  }
  return { manifest, artifacts: out, truncated };
}

/** Handle a GUI route. Returns `undefined` for a non-GUI path so the caller can
 *  404 or fall through, matching the `dispatchDashboard` convention in node.ts. */
export async function handleGuiRequest(req: Request): Promise<Response | undefined> {
  const url = new URL(req.url);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return new Response(guiHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  if (req.method === 'POST' && url.pathname === GUI_COMPRESS_ROUTE) {
    let parsed: { text?: unknown };
    try {
      parsed = JSON.parse(await req.text());
    } catch {
      return jsonError(400, 'bad JSON body');
    }
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    if (!text.trim()) return jsonError(400, 'nothing to compress — paste some text first');
    try {
      const result = await runGuiCompress(text);
      return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return jsonError(500, (e as Error).message || 'compress failed');
    }
  }

  return undefined;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The whole app: one self-contained HTML page, inline CSS + JS, no external
 *  requests (no CDN, no fonts, no analytics) — works offline, matches the
 *  project's no-phone-home posture. No user data is ever interpolated into
 *  this template; all dynamic content is injected client-side via the JSON
 *  API response, so there's no server-side templating/XSS surface here. */
export function guiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Squint — local compress (by pxpipe)</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #0f1115; --panel: #171a21; --border: #2a2f3a; --text: #e6e8ec;
    --muted: #8b93a3; --accent: #7aa2ff; --accent-text: #0f1115; --good: #5fd28d; --bad: #ff6b6b; --warn: #e0a940;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --border:#e2e5eb; --text:#1a1d24; --muted:#5b6272; --accent:#2f5fdc; --accent-text:#fff; --good:#1c8a52; --bad:#c0392b; --warn:#9a6b0a; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    padding: 24px; max-width: 900px; margin-inline: auto;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h1 .byline { color: var(--muted); font-weight: 400; font-size: 14px; }
  p.sub { color: var(--muted); margin: 0 0 20px; font-size: 13px; }
  textarea {
    width: 100%; min-height: 220px; resize: vertical; padding: 12px;
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; font: inherit; font-size: 13px;
  }
  .row { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  button {
    font: inherit; font-size: 13px; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--panel); color: var(--text); cursor: pointer;
  }
  button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; }
  button:disabled { opacity: .5; cursor: default; }
  #status { color: var(--muted); font-size: 13px; }
  .char-count { color: var(--muted); font-size: 12px; }
  .hint { color: var(--muted); font-size: 12px; margin-left: auto; }
  #error {
    margin-top: 14px; padding: 10px 12px; border-radius: 6px; background: color-mix(in srgb, var(--bad) 15%, transparent);
    border: 1px solid var(--bad); color: var(--bad); font-size: 13px;
  }
  .warn {
    margin-bottom: 14px; padding: 10px 12px; border-radius: 6px; background: color-mix(in srgb, var(--warn) 15%, transparent);
    border: 1px solid var(--warn); color: var(--warn); font-size: 13px;
  }
  #results { margin-top: 28px; }
  .stats { display: flex; gap: 22px; flex-wrap: wrap; padding: 14px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
  .stat .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .stat .v { font-size: 17px; font-weight: 600; }
  .stat .v.good { color: var(--good); }
  #pageGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; margin-top: 16px; }
  .page-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel); }
  .page-card img { width: 100%; border-radius: 4px; border: 1px solid var(--border); background: #fff; }
  .page-cap { color: var(--muted); font-size: 11px; margin: 8px 0 6px; }
  .dl-link { font-size: 12px; color: var(--accent); text-decoration: none; }
  .dl-link:hover { text-decoration: underline; }
  footer { margin-top: 32px; color: var(--muted); font-size: 12px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <h1>Squint <span class="byline">— local compress, by pxpipe</span></h1>
  <p class="sub">Paste bulky text, get compact PNG pages + a ready-to-paste prompt back. 100% local — this page only talks to itself; nothing is sent to any model, ever.</p>

  <textarea id="input" placeholder="Paste your bulky content here (logs, a file dump, old context, JSON, anything dense)…"></textarea>
  <div class="row">
    <span id="charCount" class="char-count"></span>
  </div>
  <div class="row">
    <button id="compressBtn" class="primary">Compress</button>
    <button id="clearBtn" type="button">Clear</button>
    <span id="status"></span>
    <span class="hint">⌘/Ctrl + Enter to compress</span>
  </div>
  <div id="error" hidden></div>

  <div id="results" hidden>
    <div id="truncatedWarn" class="warn" hidden></div>
    <div class="stats">
      <div class="stat"><div class="k">Text tokens</div><div class="v" id="statTextTokens">–</div></div>
      <div class="stat"><div class="k">Image tokens</div><div class="v" id="statImageTokens">–</div></div>
      <div class="stat"><div class="k">Savings</div><div class="v good" id="statSaved">–</div></div>
      <div class="stat"><div class="k">Pages</div><div class="v" id="statPages">–</div></div>
    </div>
    <div class="row">
      <button id="copyPromptBtn">Copy prompt.txt</button>
      <button id="copyFactsheetBtn">Copy factsheet.txt</button>
    </div>
    <div id="pageGrid"></div>
  </div>

  <footer>Next: drag the page-*.png files into your chat, then paste prompt.txt as your message.</footer>

<script>
(function () {
  var ta = document.getElementById('input');
  var btn = document.getElementById('compressBtn');
  var clearBtn = document.getElementById('clearBtn');
  var status = document.getElementById('status');
  var errorBox = document.getElementById('error');
  var results = document.getElementById('results');
  var charCount = document.getElementById('charCount');
  var lastPrompt = '';
  var lastFactsheet = '';
  // Bumped on every new compress AND on Clear, so a response that arrives after the user
  // moved on (cleared the form, or started a newer compress) is dropped instead of
  // silently re-populating stale results/copy buttons or popping a stale error banner.
  var requestGen = 0;

  function updateCharCount() {
    var n = ta.value.length;
    charCount.textContent = n > 0 ? fmt(n) + ' chars' : '';
  }
  ta.addEventListener('input', updateCharCount);
  updateCharCount(); // sync on load — a bfcache-restored textarea can have a value already

  function flash(el, msg) {
    var orig = el.textContent;
    el.textContent = msg;
    setTimeout(function () { el.textContent = orig; }, 1200);
  }

  function fmt(n) { return n.toLocaleString('en-US'); }

  function render(data) {
    var m = data.manifest, tr = m.tokenReport;
    var warnBox = document.getElementById('truncatedWarn');
    if (data.truncated) {
      warnBox.textContent = 'Your paste was longer than the 2,000,000-char limit — it was truncated before compressing, so these results only cover the first part of it.';
      warnBox.hidden = false;
    } else {
      warnBox.hidden = true;
    }
    document.getElementById('statTextTokens').textContent = fmt(tr.textTokens);
    document.getElementById('statImageTokens').textContent = fmt(tr.imageTokens);
    document.getElementById('statSaved').textContent =
      tr.percentSaved >= 0 ? tr.percentSaved.toFixed(1) + '% saved' : Math.abs(tr.percentSaved).toFixed(1) + '% more expensive';
    document.getElementById('statPages').textContent = m.pages.length;

    lastPrompt = ''; lastFactsheet = '';
    var grid = document.getElementById('pageGrid');
    grid.innerHTML = '';
    data.artifacts.forEach(function (a) {
      if (a.filename === 'prompt.txt') { lastPrompt = a.text || ''; return; }
      if (a.filename === 'factsheet.txt') { lastFactsheet = a.text || ''; return; }
      if (!a.base64) return;
      var src = 'data:image/png;base64,' + a.base64;
      var card = document.createElement('div');
      card.className = 'page-card';
      var img = document.createElement('img');
      img.src = src; img.alt = a.filename;
      var cap = document.createElement('div');
      cap.className = 'page-cap';
      cap.textContent = a.filename + ' · ' + a.width + '×' + a.height;
      var dl = document.createElement('a');
      dl.href = src; dl.download = a.filename; dl.className = 'dl-link'; dl.textContent = 'Download';
      card.appendChild(img); card.appendChild(cap); card.appendChild(dl);
      grid.appendChild(card);
    });
    results.hidden = false;
  }

  function runCompress() {
    var text = ta.value;
    if (!text.trim() || btn.disabled) return;
    // Captured so a response that arrives after Clear (which bumps requestGen) is
    // recognized as stale and ignored instead of resurrecting cleared results.
    var myGen = ++requestGen;
    btn.disabled = true;
    status.textContent = 'Compressing…';
    errorBox.hidden = true;
    results.hidden = true;
    fetch('/api/compress', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text }),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (myGen !== requestGen) return; // superseded by Clear or a newer compress
        if (!r.ok) throw new Error(r.data && r.data.error ? r.data.error : 'compress failed');
        render(r.data);
      })
      .catch(function (e) {
        if (myGen !== requestGen) return;
        errorBox.textContent = 'Error: ' + e.message;
        errorBox.hidden = false;
      })
      .finally(function () {
        if (myGen !== requestGen) return;
        btn.disabled = false;
        status.textContent = '';
      });
  }

  btn.addEventListener('click', runCompress);
  ta.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runCompress();
    }
  });

  clearBtn.addEventListener('click', function () {
    requestGen++; // invalidate any in-flight compress response
    ta.value = '';
    updateCharCount();
    errorBox.hidden = true;
    results.hidden = true;
    btn.disabled = false;
    status.textContent = '';
    ta.focus();
  });

  document.getElementById('copyPromptBtn').addEventListener('click', function (e) {
    navigator.clipboard.writeText(lastPrompt || '').then(function () { flash(e.target, 'Copied!'); });
  });
  document.getElementById('copyFactsheetBtn').addEventListener('click', function (e) {
    navigator.clipboard.writeText(lastFactsheet || '').then(function () { flash(e.target, 'Copied!'); });
  });
})();
</script>
</body>
</html>`;
}
