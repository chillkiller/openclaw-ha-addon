<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>OpenClaw Assistant</title>
    <style>
    :root{
      --bg:#101318;
      --surface:#1a1d24;
      --surface-2:#22262f;
      --border:rgba(255,255,255,.07);
      --border-strong:rgba(255,255,255,.12);
      --text:#e8eaed;
      --text-dim:#9aa3b2;
      --accent:#03a9f4;
      --accent-soft:rgba(3,169,244,.16);
      --ok:#2fd46a;
      --warn:#f5b53f;
      --err:#f26d6d;
      --radius:14px;
    }
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;height:100%;overflow:hidden}
    body{background:var(--bg);color:var(--text);font-family:Roboto,"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}

    .topbar{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;padding:8px 14px;background:var(--surface);border-bottom:1px solid var(--border);min-height:54px;flex-shrink:0}
    .topbar-left{display:flex;align-items:center;gap:12px;justify-self:start;min-width:0}
    .logo{width:32px;height:32px;border-radius:8px;flex-shrink:0;object-fit:contain}
    .title{display:flex;flex-direction:column;line-height:1.15;min-width:0}
    .title h1{margin:0;font-size:15px;font-weight:600;white-space:nowrap}
    .title p{margin:0;font-size:11px;color:var(--text-dim);white-space:nowrap}

    .tabs{display:flex;gap:8px;justify-self:center;align-items:center}
    .tab{appearance:none;border:1px solid var(--border);background:var(--surface-2);color:var(--text);
      border-radius:10px;padding:7px 13px;font-size:13px;font-weight:500;cursor:pointer;
      display:inline-flex;align-items:center;gap:7px;text-decoration:none;transition:background .15s,border-color .15s,color .15s;white-space:nowrap}
    .tab:hover{background:#262b34;border-color:var(--border-strong)}
    .tab.active{background:var(--accent-soft);border-color:rgba(3,169,244,.45);color:var(--accent)}
    .tab.ghost{color:var(--text-dim)}
    .tab svg{display:block}

    .status{display:flex;align-items:center;gap:8px;justify-self:end;padding-left:10px;border-left:1px solid var(--border)}
    .pill{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:500;
      background:var(--surface-2);border:1px solid var(--border);color:var(--text-dim);white-space:nowrap}
    .pill .dot{width:8px;height:8px;border-radius:50%;background:var(--text-dim);transition:background .25s}
    .pill.ok{color:#8ef0bb;border-color:rgba(47,212,106,.35)}
    .pill.ok .dot{background:var(--ok);box-shadow:0 0 8px rgba(47,212,106,.55)}
    .pill.err{color:#ffb0b0;border-color:rgba(242,109,109,.35)}
    .pill.err .dot{background:var(--err)}

    .stage{flex:1;position:relative;min-height:0}
    .pane{position:absolute;inset:0;border:0;width:100%;height:100%;background:#000;display:none}
    .pane.active{display:block}
    .pane.none{display:none;align-items:center;justify-content:center;color:var(--text-dim);font-size:14px;background:var(--bg)}
    .pane.none.active{display:flex}

    @media (max-width:760px){
      .title p{display:none}
      .tabs{gap:6px;flex-wrap:wrap;justify-self:start;grid-column:1 / -1;order:3}
      .topbar{grid-template-columns:1fr auto;padding:8px 10px}
      .status{border-left:none;padding-left:0;margin-left:0}
    }
    @media (prefers-reduced-motion: reduce){*{transition:none !important}}
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <img class="logo" src="./icon.png?v=__OPENCLAW_VERSION__" alt="OpenClaw" onerror="this.style.visibility='hidden'">
      <div class="title">
        <h1>OpenClaw Assistant</h1>
        <p>Version __OPENCLAW_VERSION__ · Home Assistant Ingress</p>
      </div>
    </div>
    <nav class="tabs" id="tabs" aria-label="Ansicht wählen">
      <button class="tab" id="tabWebui" data-pane="webui" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Control UI
      </button>
      <button class="tab" id="tabTerminal" data-pane="terminal" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        Terminal
      </button>
      <button class="tab" id="tabDocs" data-pane="docs" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/></svg>
        Docs
      </button>
      <a class="tab ghost" id="linkWebuiExternal" href="./webui/" target="_blank" rel="noopener noreferrer" title="Control UI in neuem Tab öffnen">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
      <a class="tab ghost" id="btnCert" href="./cert/ca.crt" download="openclaw-ca.crt" title="CA-Zertifikat herunterladen">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z"/></svg>
        CA
      </a>
    </nav>
    <div class="status">
      <span class="pill" id="pill"><span class="dot"></span><span id="statusText">…</span></span>
    </div>
  </header>

  <main class="stage">
    <iframe class="pane" id="paneWebui" title="OpenClaw Control UI"></iframe>
    <iframe class="pane" id="paneTerminal" title="Terminal"></iframe>
    <iframe class="pane" id="paneDocs" title="Dokumentation"></iframe>
    <div class="pane none" id="paneNone">Keine Oberflächen aktiviert — aktiviere WebUI, Terminal oder Docs in der Add-on-Konfiguration.</div>
  </main>

<script>
(function () {
  var SHOW_WEBUI = __SHOW_WEBUI_JS__;
  var SHOW_TERMINAL = __SHOW_TERMINAL_JS__;
  var SHOW_DOCS = __SHOW_DOCS_JS__;
  var ACCESS_MODE = '__ACCESS_MODE__';
  var GATEWAY_TOKEN = '__GATEWAY_TOKEN__';
  var GATEWAY_INTERNAL_PORT = '__GATEWAY_INTERNAL_PORT__';
  var $ = function (id) { return document.getElementById(id); };

  if (!/^(lan_https|tailnet_serve|tailnet_funnel)$/.test(ACCESS_MODE)) {
    $('btnCert').style.display = 'none';
  }

  var webuiPath = (GATEWAY_TOKEN && GATEWAY_TOKEN.indexOf('__') !== 0)
    ? './webui/#token=' + encodeURIComponent(GATEWAY_TOKEN)
    : './webui/';
  var ext = $('linkWebuiExternal');
  if (ext) ext.setAttribute('href', webuiPath);

  var panes = {
    webui: { btn: $('tabWebui'), frame: $('paneWebui'), src: webuiPath, enabled: SHOW_WEBUI },
    terminal: { btn: $('tabTerminal'), frame: $('paneTerminal'), src: './terminal/', enabled: SHOW_TERMINAL },
    docs: { btn: $('tabDocs'), frame: $('paneDocs'), src: './docs/', enabled: SHOW_DOCS }
  };
  var current = null;

  function activate(name) {
    var p = panes[name];
    if (!p || !p.enabled) return;
    if (current === name) return;
    current = name;
    Object.keys(panes).forEach(function (k) {
      var q = panes[k];
      q.btn.classList.toggle('active', k === name);
      q.frame.classList.toggle('active', k === name);
    });
    if (!p.frame.dataset.loaded) {
      p.frame.src = p.src;
      p.frame.dataset.loaded = '1';
    }
  }

  var any = false;
  Object.keys(panes).forEach(function (k) {
    var p = panes[k];
    if (!p.enabled) {
      p.btn.style.display = 'none';
    } else {
      any = true;
      p.btn.addEventListener('click', function () { activate(k); });
    }
  });
  if (!any) { $('paneNone').classList.add('active'); }
  else { $('paneNone').classList.remove('active'); }
  if (panes.webui.enabled) activate('webui');
  else if (panes.terminal.enabled) activate('terminal');
  else activate('docs');

  var pill = $('pill'), statusText = $('statusText');
  function setState(cls, text) {
    pill.classList.remove('ok', 'err');
    if (cls) pill.classList.add(cls);
    statusText.textContent = text;
  }
  function poll() {
    fetch('./api/health', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('ingress'); return r.json(); })
      .then(function () {
        if (GATEWAY_INTERNAL_PORT && GATEWAY_INTERNAL_PORT !== '0') {
          return fetch('./webui/healthz', { cache: 'no-store' }).then(function (r) {
            setState(r.ok ? 'ok' : 'err', r.ok ? 'Gateway online' : 'Gateway startet/gestört');
          });
        }
        setState('ok', 'Ingress online');
      })
      .catch(function () { setState('err', 'Nicht erreichbar'); });
  }
  poll();
  setInterval(poll, 15000);
})();
</script>
</body>
</html>
