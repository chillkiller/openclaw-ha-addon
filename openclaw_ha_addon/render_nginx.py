#!/usr/bin/env python3
"""
Render nginx.conf and landing page HTML from templates.

Called by run.sh with the following env vars:
  INGRESS_PORT, CERTS_DIR, GW_PUBLIC_URL, GW_TOKEN, TERMINAL_PORT,
  ENABLE_HTTPS_PROXY, HTTPS_PROXY_PORT, GATEWAY_INTERNAL_PORT, ACCESS_MODE,
  SHOW_WEBUI, SHOW_TERMINAL, SHOW_TUI, SHOW_DOCS, OPENCLAW_VERSION,
  DISK_TOTAL, DISK_USED, DISK_AVAIL, DISK_PCT
"""

import os
import subprocess
import html
from pathlib import Path


def main():
    tpl = Path('/etc/nginx/nginx.conf.tpl').read_text()
    landing_tpl = Path('/etc/nginx/landing.html.tpl').read_text()

    ingress_port = os.environ.get('INGRESS_PORT', '49200')
    certs_dir = os.environ.get('CERTS_DIR', '/config/certs')
    public_url = os.environ.get('GW_PUBLIC_URL', '')
    terminal_port = os.environ.get('TERMINAL_PORT', '7681')
    tui_port = os.environ.get('TUI_PORT', '7682')
    enable_https = os.environ.get('ENABLE_HTTPS_PROXY', 'false') == 'true'
    https_port = os.environ.get('HTTPS_PROXY_PORT', '')
    internal_gw_port = os.environ.get('GATEWAY_INTERNAL_PORT', '')
    access_mode = os.environ.get('ACCESS_MODE', 'custom')
    openclaw_version = os.environ.get('OPENCLAW_VERSION', 'unknown')

    # Tab visibility flags (render to JS booleans)
    show_webui = os.environ.get('SHOW_WEBUI', 'true').lower() in ('1', 'true', 'yes')
    show_terminal = os.environ.get('SHOW_TERMINAL', 'true').lower() in ('1', 'true', 'yes')
    show_tui = os.environ.get('SHOW_TUI', 'true').lower() in ('1', 'true', 'yes')
    show_docs = os.environ.get('SHOW_DOCS', 'true').lower() in ('1', 'true', 'yes')

    # Disk usage info (collected by run.sh)
    disk_total = os.environ.get('DISK_TOTAL', '')
    disk_used = os.environ.get('DISK_USED', '')
    disk_avail = os.environ.get('DISK_AVAIL', '')
    disk_pct = os.environ.get('DISK_PCT', '')
    nginx_log_level = os.environ.get('NGINX_LOG_LEVEL', 'minimal')

    # Token comes from environment (best-effort CLI query in run.sh)
    token = os.environ.get('GW_TOKEN', '')

    gw_path = '' if public_url.endswith('/') else '/'

    # ── nginx.conf ──────────────────────────────────────────────
    # Build access_log directive (minimal suppresses HA health-check / polling noise)
    if nginx_log_level == 'minimal':
        access_log_block = (
            '# Suppress repetitive HA health-check / polling requests\n'
            '  map $http_user_agent $loggable {\n'
            '    ~HomeAssistant 0;\n'
            '    default 1;\n'
            '  }\n'
            '  access_log stdout combined if=$loggable;'
        )
    else:
        access_log_block = 'access_log stdout;'

    conf = tpl.replace('__NGINX_ACCESS_LOG__', access_log_block)
    conf = conf.replace('__INGRESS_PORT__', ingress_port)
    conf = conf.replace('__CERTS_DIR__', certs_dir)
    conf = conf.replace('__TERMINAL_PORT__', terminal_port)
    conf = conf.replace('__TUI_PORT__', tui_port)
    conf = conf.replace('__GATEWAY_INTERNAL_PORT__', internal_gw_port)

    # Build HTTPS gateway proxy block (only for lan_https mode)
    https_block = ''
    if enable_https and https_port and internal_gw_port:
        https_block = f"""
    # --- HTTPS Gateway Proxy (lan_https mode) ---
    server {{
        listen {https_port} ssl;

        ssl_certificate     {certs_dir}/gateway.crt;
        ssl_certificate_key {certs_dir}/gateway.key;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         HIGH:!aNULL:!MD5;

        # Proxy all traffic to the loopback gateway with WebSocket support
        location / {{
            proxy_pass http://127.0.0.1:{internal_gw_port};
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto https;
            proxy_read_timeout 86400s;
            proxy_send_timeout 86400s;
            proxy_buffering off;
        }}

        # Download the local CA certificate (install on phone for trusted access)
        location = /cert/ca.crt {{
            alias {certs_dir}/ca.crt;
            default_type application/x-x509-ca-cert;
            add_header Content-Disposition 'attachment; filename="openclaw-ca.crt"';
        }}
    }}
"""

    conf = conf.replace('__HTTPS_GATEWAY_BLOCK__', https_block)
    Path('/etc/nginx/nginx.conf').write_text(conf)

    # ── landing page ────────────────────────────────────────────
    # If lan_https and no explicit public URL, auto-construct one
    if enable_https and not public_url:
        try:
            lan_ip = subprocess.check_output(
                ['hostname', '-I'], text=True, timeout=2
            ).split()[0]
        except Exception:
            lan_ip = '127.0.0.1'
        public_url = f'https://{lan_ip}:{https_port}'
        gw_path = '/'

    landing = landing_tpl.replace('__OPENCLAW_VERSION__', openclaw_version)
    landing = landing.replace('__SHOW_WEBUI_JS__', 'true' if show_webui else 'false')
    landing = landing.replace('__SHOW_TERMINAL_JS__', 'true' if show_terminal else 'false')
    landing = landing.replace('__SHOW_TUI_JS__', 'true' if show_tui else 'false')
    landing = landing.replace('__SHOW_DOCS_JS__', 'true' if show_docs else 'false')
    landing = landing.replace('__GATEWAY_TOKEN__', html.escape(token, quote=True))
    landing = landing.replace('__GATEWAY_PUBLIC_URL__', public_url)
    landing = landing.replace('__GW_PUBLIC_URL_PATH__', gw_path)
    landing = landing.replace('__ACCESS_MODE__', access_mode)
    landing = landing.replace('__HTTPS_PORT__', https_port if enable_https else '')
    landing = landing.replace('__TUI_PORT__', tui_port)
    landing = landing.replace('__DISK_TOTAL__', disk_total)
    landing = landing.replace('__DISK_USED__', disk_used)
    landing = landing.replace('__DISK_AVAIL__', disk_avail)
    landing = landing.replace('__DISK_PCT__', disk_pct)

    out_dir = Path('/etc/nginx/html')
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / 'index.html'
    out_file.write_text(landing)

    # Ensure nginx can read it even if base image uses restrictive umask/permissions.
    try:
        out_dir.chmod(0o755)
        out_file.chmod(0o644)
    except Exception:
        pass


if __name__ == '__main__':
    main()
