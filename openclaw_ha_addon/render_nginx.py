#!/usr/bin/env python3
"""
Render nginx.conf and landing page HTML from templates.

Called by run.sh with the following env vars:
  INGRESS_PORT, CERTS_DIR, GW_PUBLIC_URL, GW_TOKEN, TERMINAL_PORT,
  ENABLE_HTTPS_PROXY, HTTPS_PROXY_PORT, GATEWAY_INTERNAL_PORT, ACCESS_MODE,
  SHOW_WEBUI, SHOW_TERMINAL, SHOW_DOCS, OPENCLAW_VERSION,
  DISK_TOTAL, DISK_USED, DISK_AVAIL, DISK_PCT
"""

import os
import re
import subprocess
from pathlib import Path
import html



def main():
    tpl = Path('/etc/nginx/nginx.conf.tpl').read_text()
    landing_tpl = Path('/etc/nginx/landing.html.tpl').read_text()

    ingress_port = os.environ.get('INGRESS_PORT', '49200')
    certs_dir = os.environ.get('CERTS_DIR', '/config/certs')
    public_url = os.environ.get('GW_PUBLIC_URL', '')
    terminal_port = os.environ.get('TERMINAL_PORT', '7681')
    enable_https = os.environ.get('ENABLE_HTTPS_PROXY', 'false') == 'true'
    https_port = os.environ.get('HTTPS_PROXY_PORT', '')
    internal_gw_port = os.environ.get('GATEWAY_INTERNAL_PORT', '')
    access_mode = os.environ.get('ACCESS_MODE', 'custom')
    network_mode = os.environ.get('NETWORK_MODE', 'ingress_only')
    openclaw_version = os.environ.get('OPENCLAW_VERSION', 'unknown')

    # Defense-in-depth (audit 2026-10-09): every value interpolated into
    # nginx.conf below reaches an nginx directive or `listen`/proxy_pass port.
    # run.sh validates these, but the render step must not rely on its caller:
    # refuse to render instead of injecting a non-numeric or malformed value.
    for name, value, allow_empty in (
        ('INGRESS_PORT', ingress_port, False),
        ('TERMINAL_PORT', terminal_port, False),
        ('HTTPS_PROXY_PORT', https_port, True),
        ('GATEWAY_INTERNAL_PORT', internal_gw_port, True),
    ):
        if value == '' and allow_empty:
            continue
        if not value.isdigit() or not 1 <= len(value) <= 5:
            print(f"ERROR: {name} failed validation (expected numeric port, got {value!r}) — refusing to render nginx config", flush=True)
            raise SystemExit(1)
    # Audit-fix: certs_dir is a path (contains '/'), not a shell identifier —
    # the previous regex rejected the only value ever passed ('/config/certs')
    # and made every boot fail in render_landing. Validate as a metachar-free
    # absolute path instead.
    if not re.fullmatch(r'[/A-Za-z0-9._-]+', certs_dir):
        print(f"ERROR: CERTS_DIR failed validation ({certs_dir!r}) — refusing to render nginx config", flush=True)
        raise SystemExit(1)

    # Tab visibility flags (render to JS booleans)
    show_webui = os.environ.get('SHOW_WEBUI', 'true').lower() in ('1', 'true', 'yes')
    show_terminal = os.environ.get('SHOW_TERMINAL', 'true').lower() in ('1', 'true', 'yes')
    show_docs = os.environ.get('SHOW_DOCS', 'true').lower() in ('1', 'true', 'yes')

    # Disk usage info (collected by run.sh)
    disk_total = os.environ.get('DISK_TOTAL', '')
    disk_used = os.environ.get('DISK_USED', '')
    disk_avail = os.environ.get('DISK_AVAIL', '')
    disk_pct = os.environ.get('DISK_PCT', '')
    nginx_log_level = os.environ.get('NGINX_LOG_LEVEL', 'minimal')

    # Internal gateway port exposed to the landing page JS so it can probe
    # the OpenClaw health endpoint for a deeper readiness indication.
    gateway_internal_port = os.environ.get('GATEWAY_INTERNAL_PORT', '')

    # Token comes from environment (best-effort CLI query in run.sh)
    token = os.environ.get('GW_TOKEN', '')
    # Audit: a token containing nginx metacharacters (quotes, semicolons,
    # whitespace, newlines) used to break/inject `proxy_set_header` directives.
    # Omit auth rendering loudly instead of interpolating an unvalidated value.
    if token and not re.fullmatch(r'[A-Za-z0-9._~+/=-]+', token):
        print('ERROR: gateway token contains unsupported characters — Authorization header and landing token omitted (fix openclaw.json gateway.auth.token)', flush=True)
        token = ''

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
    # Forward token to internal gateway so Ingress/WebUI auth works with auth.mode=token.
    webui_auth_header = ''
    if token:
        webui_auth_header = '      proxy_set_header Authorization "Bearer ' + token + '";'

    conf = conf.replace('__TERMINAL_PORT__', terminal_port)
    conf = conf.replace('__GATEWAY_INTERNAL_PORT__', internal_gw_port)
    conf = conf.replace('__WEBUI_AUTH_HEADER__', webui_auth_header)

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

        # Proxy all traffic to the loopback gateway with WebSocket support.
        # NOTE: Do NOT set X-Forwarded-* / X-Real-IP here. OpenClaw 2026.8.2
        # treats their presence on loopback as proxy-shaped traffic and rejects
        # the request with proxy_attribution_required. We use token auth, so the
        # request is kept as plain local-direct traffic.
        #
        # Keep the plain HTTP proxy headers before the WebSocket upgrade
        # headers. When the client does not request an Upgrade, the map block
        # yields an empty $http_upgrade and $connection_upgrade=close. Sending
        # Upgrade/Connection headers unconditionally caused OpenClaw 2026.9.5
        # to reject plain HTTP requests on the loopback gateway.
        location / {{
            proxy_pass http://127.0.0.1:{internal_gw_port};
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_read_timeout 86400s;
            proxy_send_timeout 86400s;
            proxy_buffering off;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
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
    conf_path = Path('/etc/nginx/nginx.conf')
    conf_path.write_text(conf)
    # SECURITY (v0.7.12.1): the rendered config embeds the gateway bearer
    # token — root-only permissions instead of the default 0644.
    try:
        conf_path.chmod(0o600)
    except OSError as e:
        # Never silently continue with a world-readable token file.
        print(f"WARNING: could not restrict nginx.conf permissions: {e}")

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
    landing = landing.replace('__SHOW_DOCS_JS__', 'true' if show_docs else 'false')
    landing = landing.replace('__GATEWAY_TOKEN__', html.escape(token))
    landing = landing.replace('__GATEWAY_PUBLIC_URL__', public_url)
    landing = landing.replace('__GW_PUBLIC_URL_PATH__', gw_path)
    landing = landing.replace('__ACCESS_MODE__', access_mode)
    landing = landing.replace('__HTTPS_PORT__', https_port if enable_https else '')
    landing = landing.replace('__DISK_TOTAL__', disk_total)
    landing = landing.replace('__DISK_USED__', disk_used)
    landing = landing.replace('__DISK_AVAIL__', disk_avail)
    landing = landing.replace('__DISK_PCT__', disk_pct)
    # Internal gateway port so the landing page can probe /healthz or /startupz
    landing = landing.replace('__GATEWAY_INTERNAL_PORT__', gateway_internal_port)

    out_dir = Path('/etc/nginx/html')
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / 'index.html'
    out_file.write_text(landing)

    # Render the Docs page with the same runtime values.
    docs_tpl = Path('/openclaw_ha_addon/docs/index.html.tpl')
    if docs_tpl.exists():
        docs_out_dir = Path('/etc/nginx/html/docs')
        docs_out_dir.mkdir(parents=True, exist_ok=True)
        docs = docs_tpl.read_text()
        docs = docs.replace('__OPENCLAW_VERSION__', openclaw_version)
        docs = docs.replace('__ACCESS_MODE__', access_mode)
        docs = docs.replace('__NETWORK_MODE__', network_mode)
        (docs_out_dir / 'index.html').write_text(docs)

    # Ensure nginx can read it even if base image uses restrictive umask/permissions.
    try:
        out_dir.chmod(0o755)
        out_file.chmod(0o644)
    except Exception:
        pass


if __name__ == '__main__':
    main()
