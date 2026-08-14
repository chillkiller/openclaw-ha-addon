<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw Assistant</title>
  <style>
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0b0f14;color:#e6edf3;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif}
    body{display:flex;flex-direction:column}
    .titlebar{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#111827;border-bottom:1px solid #1f2937;min-height:42px;flex-shrink:0}
    .titlebar .logo{height:24px;width:24px;flex-shrink:0}
    .titlebar h1{margin:0;font-size:16px;font-weight:600;white-space:nowrap}
    .titlebar .version{color:#ffd700;font-size:12px;white-space:nowrap}
    .titlebar .buttons{display:flex;gap:6px;margin:0 auto;align-items:center;flex-wrap:wrap}
    .titlebar .status{display:flex;gap:8px;font-size:12px;color:#9ca3af;margin-left:auto;align-items:center}
    .btn{background:#2563eb;color:white;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500}
    .btn.secondary{background:#334155}
    .btn.green{background:#059669}
    .btn.amber{background:#d97706}
    .btn:hover{filter:brightness(1.15)}
    .btn.active{background:#f36d00}
    .btn.small{padding:4px 8px;font-size:12px}
    .main{flex:1;overflow:hidden;position:relative;display:flex;flex-direction:column}
    .iframe-pane{position:absolute;top:0;left:0;width:100%;height:100%;border:0;background:#000;display:none}
    .iframe-pane.active{display:block}
    .no-services{display:none;height:100%;justify-content:center;align-items:center;color:#9ca3af;font-size:15px;text-align:center;padding:20px}
    .no-services.visible{display:flex}
    .status-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;background:#1f2937}
    .status-badge.ok{background:#14532d;color:#86efac}
    .status-badge.warn{background:#713f12;color:#fde047}
    .status-badge.err{background:#450a0a;color:#fca5a5}
    .mode-badge{padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;background:#1e3a8a;color:#93c5fd}
    .banner{display:none;padding:12px 16px;border-radius:8px;margin:0 14px 10px;font-size:13px;line-height:1.5;background:#422006;border:1px solid #d97706;color:#fde047}
    .banner.visible{display:block}
    @media (max-width: 640px) {
      .titlebar{flex-wrap:wrap;height:auto}
      .titlebar .status{width:100%;justify-content:flex-start;margin-left:0;margin-top:4px}
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
    <a class="btn secondary" id="btnWebuiExternal" href="__GATEWAY_PUBLIC_URL__" target="_blank" rel="noopener noreferrer">Open WebUI ↗</a>
    <button class="btn secondary" id="btnTerminal" onclick="setMode('terminal')">Terminal</button>
    <button class="btn secondary" id="btnTui" onclick="setMode('tui')">TUI</button>
    <button class="btn secondary" id="btnDocs" onclick="setMode('docs')">Docs</button>
    <a class="btn green small" id="btnCert" href="./cert/ca.crt" download="openclaw-ca.crt">CA Cert</a>
  </div>
  <div class="status">
    <span class="mode-badge" id="modeBadge">__ACCESS_MODE__</span>
    <span class="status-badge" id="statusGateway">Gateway: …</span>
    <span class="status-badge" id="statusSecure">Context: …</span>
  </div>
</div>

<div id="webuiWarning" class="banner">
  ⚠️ OpenClaw WebUI erfordert HTTPS/secure context. Klicke auf <b>Open WebUI ↗</b>, um es in einem neuen Tab zu öffnen.
</div>

<div class="main">
  <iframe id="frameWebui" class="iframe-pane" src="" title="OpenClaw WebUI"></iframe>
  <iframe id="frameTerminal" class="iframe-pane" src="" title="Terminal"></iframe>
  <iframe id="frameTui" class="iframe-pane" src="" title="TUI"></iframe>
  <iframe id="frameDocs" class="iframe-pane" src="" title="Docs"></iframe>
  <div id="noServices" class="no-services">
    No services enabled.<br>
    Enable WebUI, Terminal, TUI or Docs in the add-on Configuration.
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

  let current = null;
  const loaded = { webui: false, terminal: false, tui: false, docs: false };

  function isEnabled(mode) {
    return { webui: SHOW_WEBUI, terminal: SHOW_TERMINAL, tui: SHOW_TUI, docs: SHOW_DOCS }[mode];
  }

  function updateVisibility() {
    const inIframe = (function() {
      try { return window !== window.top; } catch (e) { return true; }
    })();

    // Inside the HA Ingress iframe we always show the inline WebUI tab.
    // The external link is only useful when accessed outside Ingress or when
    // a public URL has been configured explicitly.
    const webuiInlineOk = SHOW_WEBUI && inIframe;
    const showExternalWebui = SHOW_WEBUI && !inIframe && btnWebuiExternal && btnWebuiExternal.href;

    buttons.webui.style.display = webuiInlineOk ? '' : 'none';
    if (btnWebuiExternal) {
      btnWebuiExternal.style.display = showExternalWebui ? '' : 'none';
    }
    buttons.terminal.style.display = SHOW_TERMINAL ? '' : 'none';
    buttons.tui.style.display = SHOW_TUI ? '' : 'none';
    buttons.docs.style.display = SHOW_DOCS ? '' : 'none';

    const any = SHOW_WEBUI || SHOW_TERMINAL || SHOW_TUI || SHOW_DOCS;
    document.getElementById('noServices').classList.toggle('visible', !any);

    if (!any) return;
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
      buttons[current].classList.add('secondary');
    }

    current = mode;
    frames[current].classList.add('active');
    buttons[current].classList.add('active');
    buttons[current].classList.remove('secondary');

    if (!loaded[current]) {
      let src = './' + current + '/';
      if (current === 'webui' && GATEWAY_TOKEN && GATEWAY_TOKEN.indexOf('__') !== 0) {
        src += '#token=' + encodeURIComponent(GATEWAY_TOKEN);
      }
      frames[current].src = src;
      loaded[current] = true;
    }

    // Only show the HTTPS warning when accessed directly (outside the HA Ingress iframe).
    document.getElementById('webuiWarning').classList.toggle('visible',
      mode === 'webui' && !inIframe && !window.isSecureContext);
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
      statusSecure.textContent = 'Not secure';
      statusSecure.classList.add('warn');
    }
  } catch(e) {
    statusSecure.textContent = 'Unknown';
    statusSecure.classList.add('warn');
  }

  const statusGateway = document.getElementById('statusGateway');
  function pollGateway() {
    fetch('/api/health', { cache: 'no-store' })
      .then(r => {
        if (r.ok) {
          statusGateway.textContent = 'Gateway OK';
          statusGateway.className = 'status-badge ok';
        } else {
          throw new Error('not ok');
        }
      })
      .catch(() => {
        statusGateway.textContent = 'Gateway down';
        statusGateway.className = 'status-badge err';
      });
  }
  pollGateway();
  setInterval(pollGateway, 15000);

  updateVisibility();
})();
</script>
</body>
</html>
