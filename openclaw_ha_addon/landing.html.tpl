<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <script>
  (function () {
    'use strict';
    var root = document.documentElement;

    function parseCssColor(c) {
      if (!c) return null;
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;color:' + c;
      document.documentElement.appendChild(probe);
      var resolved = '';
      try { resolved = window.getComputedStyle(probe).color || ''; } catch (e) {}
      document.documentElement.removeChild(probe);
      var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(resolved);
      if (!m) return null;
      return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
    }
    function luminance(rgb) { return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255; }
    function shade(rgb, percent) {
      var t = percent < 0 ? 0 : 255, p = Math.abs(percent) / 100;
      return 'rgb(' + Math.round((t - rgb[0]) * p + rgb[0]) + ',' +
                       Math.round((t - rgb[1]) * p + rgb[1]) + ',' +
                       Math.round((t - rgb[2]) * p + rgb[2]) + ')';
    }
    function readParent() {
      try {
        if (window.parent && window.parent !== window && window.parent.document && window.parent.document.documentElement) {
          var cs = window.parent.getComputedStyle(window.parent.document.documentElement);
          return {
            bg: (cs.getPropertyValue('--primary-background-color') || '').trim(),
            card: (cs.getPropertyValue('--card-background-color') || '').trim(),
            text: (cs.getPropertyValue('--primary-text-color') || '').trim(),
            dim: (cs.getPropertyValue('--secondary-text-color') || '').trim(),
            accent: (cs.getPropertyValue('--primary-color') || '').trim(),
            divider: (cs.getPropertyValue('--divider-color') || '').trim()
          };
        }
      } catch (e) { /* cross-origin: fall through */ }
      return null;
    }
    function applyTheme() {
      var parent = readParent();
      var root = document.documentElement;
      var dark;
      if (parent && parent.bg) {
        root.style.setProperty('--ha-bg', parent.bg);
        if (parent.card) {
          root.style.setProperty('--ha-card', parent.card);
          var rgb = parseCssColor(parent.card);
          if (rgb) root.style.setProperty('--ha-card-2', shade(rgb, isDarkColor(parent.bg) ? 10 : -6));
        }
        if (parent.text) root.style.setProperty('--ha-text', parent.text);
        if (parent.dim) root.style.setProperty('--ha-text-dim', parent.dim);
        if (parent.accent) root.style.setProperty('--ha-accent', parent.accent);
        if (parent.divider) root.style.setProperty('--ha-border', parent.divider);
        dark = isDarkColor(parent.bg);
      } else {
        dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.setAttribute('data-ha-theme', dark ? 'dark' : 'light');
        return;
      }
      root.setAttribute('data-ha-theme', dark ? 'dark' : 'light');
    }
    function isDarkColor(c) {
      var rgb = parseCssColor(c);
      if (!rgb) {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
      return luminance(rgb) < 0.5;
    }
    applyTheme();
    // Follow in-place theme switches in the parent (HA swaps CSS variables /
    // inline styles on the root element) and OS-level preference changes.
    try {
      var parentDoc = window.parent && window.parent.document ? window.parent.document : null;
      if (parentDoc) {
        var obs = new MutationObserver(function () { applyTheme(); });
        obs.observe(parentDoc.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-ha-theme'] });
        obs.observe(parentDoc.head || parentDoc.documentElement, { childList: true, subtree: true });
      }
    } catch (e) { /* ignore */ }
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
    }
    // Belt and braces: re-sample periodically (HA may change vars without attributes).
    setInterval(applyTheme, 2000);
  })();
  </script>
  <title>OpenClaw Assistant</title>
    <style>
    :root{
      --ha-bg:#fafafa;
      --ha-card:#ffffff;
      --ha-card-2:#f0f2f5;
      --ha-border:rgba(0,0,0,.09);
      --ha-text:#141414;
      --ha-text-dim:#5e5e5e;
      --ha-accent:#009ac7;
      --ha-accent-soft:rgba(0,154,199,.12);
      --ha-ok:#1f9e4d;
      --ha-err:#d64848;
      --shadow:0 6px 24px rgba(20,20,30,.10);
      color-scheme: light;
    }
    html[data-ha-theme="dark"]{
      --ha-bg:#111418;
      --ha-card:#1b1f26;
      --ha-card-2:#232833;
      --ha-border:rgba(255,255,255,.09);
      --ha-text:#e8eaed;
      --ha-text-dim:#9aa3b2;
      --ha-accent:#03a9f4;
      --ha-accent-soft:rgba(3,169,244,.16);
      --ha-ok:#2fd46a;
      --ha-err:#f26d6d;
      --shadow:0 6px 24px rgba(0,0,0,.35);
      color-scheme: dark;
    }
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;height:100%;overflow:hidden}
    body{background:var(--ha-bg);color:var(--ha-text);font-family:Roboto,"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}

    .topbar{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;padding:8px 14px;background:var(--ha-card);border-bottom:1px solid var(--ha-border);min-height:54px;flex-shrink:0}
    .topbar-left{display:flex;align-items:center;gap:12px;justify-self:start;min-width:0}
    .logo{width:32px;height:32px;border-radius:8px;flex-shrink:0;object-fit:contain}
    .title{display:flex;flex-direction:column;line-height:1.15;min-width:0}
    .title h1{margin:0;font-size:15px;font-weight:600;white-space:nowrap}
    .title p{margin:0;font-size:11px;color:var(--ha-text-dim);white-space:nowrap}

    .tabs{display:flex;gap:8px;justify-self:center;align-items:center}
    .tab{appearance:none;border:1px solid var(--ha-border);background:var(--ha-card-2);color:var(--ha-text);
      border-radius:10px;padding:7px 13px;font-size:13px;font-weight:500;cursor:pointer;
      display:inline-flex;align-items:center;gap:7px;text-decoration:none;transition:background .15s,border-color .15s,color .15s;white-space:nowrap}
    .tab:hover{background:var(--ha-card-2);border-color:var(--ha-border)}
    .tab.active{background:var(--ha-accent-soft);border-color:var(--ha-accent);color:var(--ha-accent)}
    .tab.ghost{color:var(--ha-text-dim)}
    .tab svg{display:block}

    .status{display:flex;align-items:center;gap:8px;justify-self:end;padding-left:10px;border-left:1px solid var(--ha-border)}
    .pill{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:500;
      background:var(--ha-card-2);border:1px solid var(--ha-border);color:var(--ha-text-dim);white-space:nowrap}
    .pill .dot{width:8px;height:8px;border-radius:50%;background:var(--ha-text-dim);transition:background .25s}
    .pill.ok{color:var(--ha-ok);border-color:color-mix(in srgb, var(--ha-ok) 35%, transparent)}
    .pill.ok .dot{background:var(--ha-ok);box-shadow:0 0 8px color-mix(in srgb, var(--ha-ok) 55%, transparent)}
    .pill.err{color:var(--ha-err);border-color:color-mix(in srgb, var(--ha-err) 35%, transparent)}
    .pill.err .dot{background:var(--ha-err)}

    .stage{flex:1;position:relative;min-height:0}
    .pane{position:absolute;inset:0;border:0;width:100%;height:100%;background:var(--ha-bg);display:none}
    .pane.active{display:block}
    .pane.none{display:none;align-items:center;justify-content:center;color:var(--ha-text-dim);font-size:14px;background:var(--ha-bg)}
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
  var GATEWAY_MODE = '__GATEWAY_MODE__';
  var REMOTE = GATEWAY_MODE === 'remote';
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
  if (ext) {
    ext.setAttribute('href', webuiPath);
    if (!SHOW_WEBUI || REMOTE) ext.style.display = 'none';
  }

  var panes = {
    webui: { btn: $('tabWebui'), frame: $('paneWebui'), src: webuiPath, enabled: SHOW_WEBUI && !REMOTE },
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
        if (REMOTE) { setState('', 'Remote-Gateway (extern)'); return; }
        if (GATEWAY_INTERNAL_PORT && GATEWAY_INTERNAL_PORT !== '0') {
          return fetch('./webui/healthz', { cache: 'no-store' }).then(function (r) {
            setState(r.ok ? 'ok' : 'err', r.ok ? 'Gateway online' : 'Gateway startet/gestört');
          });
        }
        setState('ok', 'Ingress online');
      })
      .catch(function () { setState('err', REMOTE ? 'Remote-Gateway' : 'Nicht erreichbar'); });
  }
  poll();
  setInterval(poll, 15000);
})();
</script>
</body>
</html>
