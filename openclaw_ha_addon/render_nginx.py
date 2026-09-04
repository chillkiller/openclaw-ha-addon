#!/usr/bin/env python3
"""
Render nginx.conf and landing page HTML from templates.

Called by run.sh with the following env vars:
  INGRESS_PORT, CERTS_DIR, GW_PUBLIC_URL, GW_TOKEN, TERMINAL_PORT, TUI_PORT,
  GATEWAY_PORT, NETWORK_MODE, SHOW_WEBUI, SHOW_TERMINAL, SHOW_TUI, SHOW_DOCS,
  OPENCLAW_VERSION, DISK_TOTAL, DISK_USED, DISK_AVAIL, DISK_PCT
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
    gateway_port = os.environ.get('GATEWAY_PORT', '18789')
    network_mode = os.environ.get('NETWORK_MODE', 'ingress_only')
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
    # Authorization header forwarded to internal gateway so Ingress works
    # even when gateway.auth.mode is "token".
    gateway_auth_header = ('      proxy_set_header Authorization "Bearer ' + token + '";\n') if token else ''

    # TLS mode for internal gateway proxy (http vs https)
    gateway_tls_enabled = os.environ.get('GATEWAY_TLS_ENABLED', 'false').lower() in ('1', 'true', 'yes')

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

    # Choose internal proxy scheme based on network mode
    if network_mode in ('lan_https', 'tailnet'):
        webui_proxy_block = (
            '      proxy_pass https://127.0.0.1:' + gateway_port + '/;\n'
            '      proxy_ssl_verify off;\n'
            '      proxy_ssl_protocols TLSv1.2 TLSv1.3;\n'
            '      proxy_ssl_ciphers HIGH:!aNULL:!MD5;\n'
            '      proxy_ssl_server_name off;\n'
            '      proxy_ssl_session_reuse on;\n'
            + gateway_auth_header
        )
        api_health_proxy_block = (
            '      proxy_pass https://127.0.0.1:' + gateway_port + '/health;\n'
            '      proxy_ssl_verify off;\n'
            '      proxy_ssl_protocols TLSv1.2 TLSv1.3;\n'
            '      proxy_ssl_ciphers HIGH:!aNULL:!MD5;\n'
            '      proxy_ssl_server_name off;\n'
            + gateway_auth_header
        )
    else:
        webui_proxy_block = (
            '      proxy_pass http://127.0.0.1:' + gateway_port + '/;\n'
            + gateway_auth_header
        )
        api_health_proxy_block = (
            '      proxy_pass http://127.0.0.1:' + gateway_port + '/health;\n'
            + gateway_auth_header
        )

    conf = tpl.replace('__NGINX_ACCESS_LOG__', access_log_block)
    conf = conf.replace('__INGRESS_PORT__', ingress_port)
    conf = conf.replace('__CERTS_DIR__', certs_dir)
    conf = conf.replace('__TERMINAL_PORT__', terminal_port)
    conf = conf.replace('__TUI_PORT__', tui_port)
    conf = conf.replace('__GATEWAY_PORT__', gateway_port)
    conf = conf.replace('__WEBUI_PROXY_BLOCK__', webui_proxy_block)
    conf = conf.replace('__API_HEALTH_PROXY_BLOCK__', api_health_proxy_block)
    Path('/etc/nginx/nginx.conf').write_text(conf)

    # ── landing page ────────────────────────────────────────────
    # If no explicit public URL is set but lan_https is active, auto-construct one.
    if not public_url and network_mode == 'lan_https':
        try:
            lan_ip = subprocess.check_output(
                ['hostname', '-I'], text=True, timeout=2
            ).split()[0]
        except Exception:
            lan_ip = '127.0.0.1'
        public_url = f'https://{lan_ip}:{gateway_port}'
        gw_path = '/'

    landing = landing_tpl.replace('__OPENCLAW_VERSION__', openclaw_version)
    landing = landing.replace('__SHOW_WEBUI_JS__', 'true' if show_webui else 'false')
    landing = landing.replace('__SHOW_TERMINAL_JS__', 'true' if show_terminal else 'false')
    landing = landing.replace('__SHOW_TUI_JS__', 'true' if show_tui else 'false')
    landing = landing.replace('__SHOW_DOCS_JS__', 'true' if show_docs else 'false')
    landing = landing.replace('__GATEWAY_TOKEN__', html.escape(token, quote=True))
    landing = landing.replace('__GATEWAY_PUBLIC_URL__', public_url)
    landing = landing.replace('__GW_PUBLIC_URL_PATH__', gw_path)
    landing = landing.replace('__NETWORK_MODE__', network_mode)
    landing = landing.replace('__GATEWAY_PORT__', gateway_port)
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


