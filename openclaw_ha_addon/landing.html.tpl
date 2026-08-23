<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>OpenClaw Assistant</title>
  <style>
    :root {
      --ha-bg: #111416;
      --ha-card: #1c1c21;
      --ha-card-2: #242429;
      --ha-text: #e3e3e7;
      --ha-text-sec: #9fa0a6;
      --ha-border: rgba(255,255,255,0.08);
      --ha-accent: #0b96c2;
      --ha-accent-soft: rgba(11,150,194,0.15);
      --ha-ok: #17a34a;
      --ha-warn: #f59e0b;
      --ha-err: #ef4444;
      --ha-radius: 12px;
      --ha-radius-sm: 8px;
      --ha-shadow: 0 2px 8px rgba(0,0,0,0.28);
      --ha-gap: 16px;
    }
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;height:100%;background:var(--ha-bg);color:var(--ha-text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}
    body{display:flex;justify-content:center;padding:var(--ha-gap)}
    .wrap{width:100%;max-width:720px;display:flex;flex-direction:column;gap:var(--ha-gap)}
    .card{background:var(--ha-card);border-radius:var(--ha-radius);box-shadow:var(--ha-shadow);border:1px solid var(--ha-border);overflow:hidden}
    .header{padding:18px 18px 14px;display:flex;align-items:flex-start;gap:14px}
    .icon{width:40px;height:40px;border-radius:var(--ha-radius-sm);background:var(--ha-accent-soft);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--ha-accent);flex-shrink:0}
    .title h1{margin:0;font-size:18px;font-weight:600;letter-spacing:-0.01em}
    .title .meta{margin-top:4px;font-size:12px;color:var(--ha-text-sec)}
    .status-row{display:flex;gap:10px;padding:0 18px 16px;flex-wrap:wrap}
    .chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:500;background:var(--ha-card-2);border:1px solid var(--ha-border);color:var(--ha-text-sec)}
    .chip.ok{background:rgba(23,163,74,0.15);border-color:rgba(23,163,74,0.25);color:#4ade80}
    .chip.warn{background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.22);color:#fbbf24}
    .chip.err{background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.25);color:#fca5a5}
    .section{padding:16px 18px;border-top:1px solid var(--ha-border)}
    .section-title{margin:0 0 12px;font-size:13px;font-weight:600;color:var(--ha-text-sec);text-transform:uppercase;letter-spacing:0.04em}
    .nav{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
    .nav-item{display:flex;align-items:center;gap:12px;padding:14px;border-radius:var(--ha-radius-sm);background:var(--ha-card-2);border:1px solid var(--ha-border);cursor:pointer;transition:background 0.15s,border-color 0.15s;user-select:none}
    .nav-item:hover{background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.14)}
    .nav-item.active{background:var(--ha-accent-soft);border-color:rgba(11,150,194,0.35)}
    .nav-item .ico{font-size:20px;width:24px;text-align:center}
    .nav-item .lbl{font-weight:500}
    .nav-item.hidden{display:none}
    .content{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
    .frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;display:none}
    .frame.active{display:block}
    .empty{display:none;align-items:center;justify-content:center;height:100%;color:var(--ha-text-sec);font-size:14px;text-align:center;padding:24px}
    .empty.active{display:flex}
    .warn-box{display:none;margin:16px 18px;padding:12px 14px;border-radius:var(--ha-radius-sm);background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.25);color:#fbbf24;font-size:13px}
    .warn-box.active{display:block}
    .warn-box a{color:var(--ha-accent);text-decoration:none}
    .warn-box a:hover{text-decoration:underline}
    .cert-link{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:500;background:rgba(23,163,74,0.12);border:1px solid rgba(23,163,74,0.25);color:#4ade80;text-decoration:none}
    .cert-link:hover{background:rgba(23,163,74,0.18);text-decoration:none}
    .footer{padding:12px 18px;border-top:1px solid var(--ha-border);font-size:12px;color:var(--ha-text-sec);text-align:center}
    @media (max-width: 480px){
      body{padding:10px}
      .nav{grid-template-columns:repeat(2,1fr)}
      .header{padding:14px 14px 10px}
      .status-row{padding:0 14px 12px}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="header">
        <div class="icon">🦾</div>
        <div class="title">
          <h1>OpenClaw Assistant</h1>
          <div class="meta">Version __OPENCLAW_VERSION__ · <span id="statusSecure">…</span></div>
        </div>
      </div>
      <div class="status-row">
        <span class="chip" id="statusGateway">Gateway: …</span>
        <span class="chip" id="statusIngress">Ingress: …</span>
        <a class="cert-link hidden" id="btnCert" href="./cert/ca.crt" download="openclaw-ca.crt">🔒 CA Cert</a>
      </div>

      <div class="warn-box" id="webuiWarning">
        <strong>Secure Context erforderlich.</strong> Der WebUI-Tab erfordert HTTPS. Klicke auf den Button, um die WebUI extern zu öffnen, oder aktiviere den <code>lan_https</code>-Modus.
      </div>

      <div class="section">
        <h2 class="section-title">Ingress-Tabs</h2>
        <div class="nav" id="nav">
          <div class="nav-item" id="btnWebui" data-mode="webui">
            <span class="ico">🌐</span>
            <span class="lbl">WebUI</span>
          </div>
          <div class="nav-item" id="btnTerminal" data-mode="terminal">
            <span class="ico">🖥️</span>
            <span class="lbl">Terminal</span>
          </div>
          <div class="nav-item" id="btnTui" data-mode="tui">
            <span class="ico">📊</span>
            <span class="lbl">TUI</span>
          </div>
          <div class="nav-item" id="btnDocs" data-mode="docs">
            <span class="ico">📄</span>
            <span class="lbl">Docs</span>
          </div>
        </div>
      </div>

      <div class="content" id="contentHost">
        <iframe id="frameWebui" class="frame" title="OpenClaw WebUI"></iframe>
        <iframe id="frameTerminal" class="frame" title="Terminal"></iframe>
        <iframe id="frameTui" class="frame" title="TUI"></iframe>
        <iframe id="frameDocs" class="frame" title="Docs"></iframe>
        <div id="noServices" class="empty">Keine Services aktiviert.</div>
      </div>

      <div class="footer" id="footer">OpenClaw HA Add-on · Speicher: __DISK_USED__ / __DISK_TOTAL__ (__DISK_PCT__)</div>
    </div>
  </div>

  <script>
  (function() {
    const ACCESS_MODE = '__ACCESS_MODE__';
    const GATEWAY_TOKEN = '__GATEWAY_TOKEN__';
    const GATEWAY_PUBLIC_URL = '__GATEWAY_PUBLIC_URL__';
    const SHOW_WEBUI = __SHOW_WEBUI_JS__;
    const SHOW_TERMINAL = __SHOW_TERMINAL_JS__;
    const SHOW_TUI = __SHOW_TUI_JS__;
    const SHOW_DOCS = __SHOW_DOCS_JS__;

    const modes = {
      webui: { btn: 'btnWebui', frame: 'frameWebui', src: './webui/?token=' + encodeURIComponent(GATEWAY_TOKEN), external: GATEWAY_PUBLIC_URL },
      terminal: { btn: 'btnTerminal', frame: 'frameTerminal', src: './terminal/' },
      tui: { btn: 'btnTui', frame: 'frameTui', src: './tui/' },
      docs: { btn: 'btnDocs', frame: 'frameDocs', src: './docs/' }
    };

    let current = null;
    let loaded = {};

    function isEnabled(mode) {
      switch(mode) {
        case 'webui': return SHOW_WEBUI;
        case 'terminal': return SHOW_TERMINAL;
        case 'tui': return SHOW_TUI;
        case 'docs': return SHOW_DOCS;
      }
      return false;
    }

    function updateVisibility() {
      let any = false;
      for (const mode of Object.keys(modes)) {
        const enabled = isEnabled(mode);
        document.getElementById(modes[mode].btn).classList.toggle('hidden', !enabled);
        any = any || enabled;
      }
      const diskUsed = '__DISK_USED__';
      const diskTotal = '__DISK_TOTAL__';
      const diskPct = '__DISK_PCT__';
      let footerText = any
        ? (isEnabled('webui') && !window.isSecureContext && window.top !== window
            ? 'Wähle einen Tab aus. WebUI öffnet extern (HTTP).' 
            : 'Wähle einen Tab aus, um den Service zu laden.')
        : 'Keine Ingress-Services aktiviert.';
      if (diskUsed && diskTotal && diskPct) {
        footerText += ' · Speicher: ' + diskUsed + ' / ' + diskTotal + ' (' + diskPct + ')';
      }
      document.getElementById('footer').textContent = footerText;
      document.getElementById('noServices').classList.toggle('active', !any);
      if (!any) {
        document.getElementById('contentHost').style.display = 'none';
      }
      // CA cert download only in lan_https mode
      document.getElementById('btnCert').classList.toggle('hidden', ACCESS_MODE !== 'lan_https');
    }

    function setMode(mode) {
      if (!isEnabled(mode)) return;

      if (mode === 'webui' && !window.isSecureContext && window.top !== window) {
        document.getElementById('webuiWarning').classList.add('active');
      } else {
        document.getElementById('webuiWarning').classList.remove('active');
      }

      for (const m of Object.keys(modes)) {
        const cfg = modes[m];
        const active = m === mode;
        document.getElementById(cfg.btn).classList.toggle('active', active);
        const frame = document.getElementById(cfg.frame);
        frame.classList.toggle('active', active);
        if (active && !loaded[m]) {
          if (m === 'webui' && !window.isSecureContext && window.top !== window) {
            // HTTP ingress: open WebUI externally instead of iframe
            window.open(cfg.external, '_blank');
          } else {
            frame.src = cfg.src;
          }
          loaded[m] = true;
        }
      }
      current = mode;
    }

    for (const mode of Object.keys(modes)) {
      document.getElementById(modes[mode].btn).addEventListener('click', () => setMode(mode));
    }

    const statusSecure = document.getElementById('statusSecure');
    try {
      statusSecure.textContent = window.isSecureContext ? 'Secure Context' : 'HTTP / Unsicher';
      statusSecure.className = window.isSecureContext ? '' : 'warn';
    } catch(e) {
      statusSecure.textContent = 'Unbekannt';
    }

    const statusGateway = document.getElementById('statusGateway');
    function pollGateway() {
      fetch('./api/health', { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
          if (data && data.ok) {
            statusGateway.textContent = 'Gateway: online';
            statusGateway.className = 'chip ok';
          } else {
            throw new Error('not ok');
          }
        })
        .catch(() => {
          statusGateway.textContent = 'Gateway: offline';
          statusGateway.className = 'chip err';
        });
    }
    pollGateway();
    setInterval(pollGateway, 15000);

    const statusIngress = document.getElementById('statusIngress');
    statusIngress.textContent = 'Ingress: verbunden';
    statusIngress.className = 'chip ok';

    updateVisibility();
    // Load first enabled mode
    for (const mode of ['webui', 'terminal', 'tui', 'docs']) {
      if (isEnabled(mode)) { setMode(mode); break; }
    }
  })();
  </script>
</body>
</html>
