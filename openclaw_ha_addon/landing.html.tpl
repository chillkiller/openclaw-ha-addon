<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>OpenClaw Assistant</title>
  <style>
    :root{
      --ha-bg:#111416;
      --ha-surface:#1c1c21;
      --ha-surface-2:#242429;
      --ha-border:rgba(255,255,255,0.08);
      --ha-text:#e3e3e7;
      --ha-text-sec:#9fa0a6;
      --ha-accent:#0b96c2;
      --ha-accent-soft:rgba(11,150,194,0.16);
      --ha-ok:#17a34a;
      --ha-warn:#f59e0b;
      --ha-err:#ef4444;
      --ha-radius:10px;
      --ha-radius-sm:8px;
    }
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--ha-bg);color:var(--ha-text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;-webkit-font-smoothing:antialiased}
    body{display:flex;flex-direction:column}
    .titlebar{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--ha-surface);border-bottom:1px solid var(--ha-border);min-height:52px;flex-shrink:0}
    .titlebar .logo{height:28px;width:28px;flex-shrink:0;border-radius:6px}
    .titlebar h1{margin:0;font-size:16px;font-weight:600;white-space:nowrap;letter-spacing:-0.01em}
    .titlebar .version{color:var(--ha-text-sec);font-size:12px;white-space:nowrap;background:var(--ha-surface-2);padding:3px 8px;border-radius:999px;border:1px solid var(--ha-border)}
    .titlebar .buttons{display:flex;gap:8px;margin:0 auto;align-items:center;flex-wrap:wrap}
    .titlebar .status{display:flex;gap:8px;font-size:12px;color:var(--ha-text-sec);margin-left:auto;align-items:center}
    .btn{background:var(--ha-surface-2);color:var(--ha-text);border:1px solid var(--ha-border);border-radius:var(--ha-radius-sm);padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500;transition:background .15s,border-color .15s}
    .btn:hover{background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.16)}
    .btn.active{background:var(--ha-accent-soft);border-color:rgba(11,150,194,0.45);color:var(--ha-accent)}
    .btn.green{background:rgba(23,163,74,0.12);border-color:rgba(23,163,74,0.25);color:#4ade80}
    .btn.green:hover{background:rgba(23,163,74,0.18)}
    .btn.small{padding:4px 8px;font-size:12px}
    .main{flex:1;overflow:hidden;position:relative;display:flex;flex-direction:column}
    .iframe-pane{position:absolute;top:0;left:0;width:100%;height:100%;border:0;background:#000;display:none}
    .iframe-pane.active{display:block}
    .no-services{display:none;height:100%;justify-content:center;align-items:center;color:var(--ha-text-sec);font-size:15px;text-align:center;padding:20px}
    .no-services.visible{display:flex;flex-direction:column;gap:8px}
    .chip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:500;background:var(--ha-surface-2);border:1px solid var(--ha-border);color:var(--ha-text-sec)}
    .chip.ok{background:rgba(23,163,74,0.15);border-color:rgba(23,163,74,0.25);color:#4ade80}
    .chip.warn{background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.22);color:#fbbf24}
    .chip.err{background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.25);color:#fca5a5}
    .chip.accent{background:var(--ha-accent-soft);border-color:rgba(11,150,194,0.30);color:var(--ha-accent)}
    .banner{display:none;padding:12px 16px;border-radius:var(--ha-radius-sm);margin:0 12px 10px;font-size:13px;line-height:1.5;background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.25);color:#fbbf24}
    .banner.visible{display:block}
    @media (max-width: 720px){
      .titlebar{flex-wrap:wrap;height:auto;gap:8px}
      .titlebar .buttons{order:3;width:100%;margin:4px 0 0 0;justify-content:flex-start}
      .titlebar .status{order:2;width:auto;margin-left:auto}
    }
  </style>
</head>
<body>

<div class="titlebar">
  <img class="logo" src="./icon.png" alt="OpenClaw" onerror="this.style.display='none'">
  <h1>OpenClaw Assistant</h1>
  <span class="version">__OPENCLAW_VERSION__</span>
  <div class="buttons">
    <button class="btn active" id="btnWebui" onclick="setMode('webui')">WebUI</button>
    <a class="btn" id="btnWebuiExternal" href="__GATEWAY_PUBLIC_URL__" target="_blank" rel="noopener noreferrer">WebUI ↗</a>
    <button class="btn" id="btnTerminal" onclick="setMode('terminal')">Terminal</button>
    <button class="btn" id="btnTui" onclick="setMode('tui')">TUI</button>
    <button class="btn" id="btnDocs" onclick="setMode('docs')">Docs</button>
    <a class="btn green small" id="btnCert" href="./cert/ca.crt" download="openclaw-ca.crt">CA Cert</a>
  </div>
  <div class="status">
    <span class="chip accent" id="modeBadge">__ACCESS_MODE__</span>
    <span class="chip" id="statusGateway">Gateway: …</span>
    <span class="chip" id="statusSecure">Context: …</span>
  </div>
</div>

<div id="webuiWarning" class="banner">
  ⚠️ OpenClaw WebUI erfordert HTTPS/secure context. Klicke auf <b>WebUI ↗</b>, um es in einem neuen Tab zu öffnen.
</div>

<div class="main">
  <iframe id="frameWebui" class="iframe-pane" src="" title="OpenClaw WebUI"></iframe>
  <iframe id="frameTerminal" class="iframe-pane" src="" title="Terminal"></iframe>
  <iframe id="frameTui" class="iframe-pane" src="" title="TUI"></iframe>
  <iframe id="frameDocs" class="iframe-pane" src="" title="Docs"></iframe>
  <div id="noServices" class="no-services">
    Keine Services aktiviert.<br>
    Aktiviere WebUI, Terminal, TUI oder Docs in der Add-on-Konfiguration.
  </div>
</div>

<script>
(function() {
  const buttons = {
    webui: document.getElementById('btnWebui'),
    terminal: document.getElementById('btnTerminal'),
    tui: document.getElementById('btnTui'),
    docs: document.getElementById('btnDocs')
  };
  const frames = {
    webui: document.getElementById('frameWebui'),
    terminal: document.getElementById('frameTerminal'),
    tui: document.getElementById('frameTui'),
    docs: document.getElementById('frameDocs')
  };
  const btnWebuiExternal = document.getElementById('btnWebuiExternal');

  const SHOW_WEBUI = __SHOW_WEBUI_JS__;
  const SHOW_TERMINAL = __SHOW_TERMINAL_JS__;
  const SHOW_TUI = __SHOW_TUI_JS__;
  const SHOW_DOCS = __SHOW_DOCS_JS__;
  const ACCESS_MODE = '__ACCESS_MODE__';
  const GATEWAY_TOKEN = '__GATEWAY_TOKEN__';

  let inIframe;
  try { inIframe = window !== window.top; } catch (e) { inIframe = true; }

  let current = null;
  const loaded = { webui: false, terminal: false, tui: false, docs: false };

  function isEnabled(mode) {
    return { webui: SHOW_WEBUI, terminal: SHOW_TERMINAL, tui: SHOW_TUI, docs: SHOW_DOCS }[mode];
  }

  function updateVisibility() {
    const any = SHOW_WEBUI || SHOW_TERMINAL || SHOW_TUI || SHOW_DOCS;
    document.getElementById('noServices').classList.toggle('visible', !any);
    if (!any) {
      for (const b of Object.values(buttons)) b.style.display = 'none';
      if (btnWebuiExternal) btnWebuiExternal.style.display = 'none';
      return;
    }

    // WebUI inline tab: visible only when enabled and inside HA Ingress iframe.
    buttons.webui.style.display = (SHOW_WEBUI && inIframe) ? '' : 'none';
    // External WebUI link: visible when enabled and either not in iframe or no inline iframe possible (HTTP context).
    if (btnWebuiExternal) {
      btnWebuiExternal.style.display = SHOW_WEBUI ? '' : 'none';
    }
    buttons.terminal.style.display = SHOW_TERMINAL ? '' : 'none';
    buttons.tui.style.display = SHOW_TUI ? '' : 'none';
    buttons.docs.style.display = SHOW_DOCS ? '' : 'none';

    if (current === null || !isEnabled(current)) {
      for (const k of ['webui','terminal','tui','docs']) {
        if (isEnabled(k)) { setMode(k); return; }
      }
    }
  }

  window.setMode = function(mode) {
    if (!isEnabled(mode)) return;
    if (current === mode) return;

    if (current) {
      frames[current].classList.remove('active');
      buttons[current].classList.remove('active');
    }

    current = mode;
    frames[current].classList.add('active');
    buttons[current].classList.add('active');

    if (!loaded[current]) {
      let src = './' + current + '/';
      if (current === 'webui' && GATEWAY_TOKEN && GATEWAY_TOKEN.indexOf('__') !== 0) {
        src += '#token=' + encodeURIComponent(GATEWAY_TOKEN);
      }
      frames[current].src = src;
      loaded[current] = true;
    }

    document.getElementById('webuiWarning').classList.toggle('visible',
      mode === 'webui' && inIframe && !window.isSecureContext);
  };

  const btnCert = document.getElementById('btnCert');
  if (ACCESS_MODE !== 'lan_https') {
    btnCert.style.display = 'none';
  }

  const statusSecure = document.getElementById('statusSecure');
  try {
    if (window.isSecureContext) {
      statusSecure.textContent = 'Secure';
      statusSecure.classList.add('ok');
    } else {
      statusSecure.textContent = 'Unsicher';
      statusSecure.classList.add('warn');
    }
  } catch(e) {
    statusSecure.textContent = 'Unbekannt';
    statusSecure.classList.add('warn');
  }

  const statusGateway = document.getElementById('statusGateway');
  function pollGateway() {
    fetch('./api/health', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (data && data.ok) {
          statusGateway.textContent = 'Gateway online';
          statusGateway.className = 'chip ok';
        } else {
          throw new Error('not ok');
        }
      })
      .catch(() => {
        statusGateway.textContent = 'Gateway offline';
        statusGateway.className = 'chip err';
      });
  }
  pollGateway();
  setInterval(pollGateway, 15000);

  updateVisibility();
})();
</script>
</body>
</html>
