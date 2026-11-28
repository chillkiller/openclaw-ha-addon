worker_processes  1;

# Log to stderr/stdout (container-friendly)
error_log stderr notice;

events { worker_connections 1024; }

http {
  gzip off;

  # HTML responses must stay uncompressed so sub_filter can rewrite them
  # (the Control UI HTML carries the ingress prefix into asset URLs).
  proxy_set_header Accept-Encoding "";
  include       /etc/nginx/mime.types;
  default_type  application/octet-stream;

  __NGINX_ACCESS_LOG__
  error_log  stderr notice;

  sendfile        on;
  keepalive_timeout  65;
  client_body_buffer_size 16m;
  client_max_body_size 0;

  # WebSocket upgrade mapping
  map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
  }

  # Ingress prefix of the current request ("/api/hassio_ingress/<token>").
  # The gateway serves the Control UI rooted at /webui (gateway.controlUi.basePath),
  # so the gateway emits asset/bootstrap URLs as /webui/... — but in Home Assistant
  # the browser reaches the app through the ingress prefix, so HTML responses are
  # rewritten below to $ingress_path_norm-prefixed URLs.
  map $request_uri $ingress_path {
    ~^(/api/hassio_ingress/[^/]+)/    $1;
    default                          $http_x_ingress_path;
  }

  # Normalize the ingress path: strip a trailing "/webui" when the supervisor
  # includes it, and guard against empty (direct nginx access).
  map $ingress_path $ingress_path_norm {
    ""                        "";
    ~^(?<ip_base>.*)/webui/?$  $ip_base;
    default                    $ingress_path;
  }

  server {
    listen __INGRESS_PORT__;
    server_name _;

    # SECURITY (v0.7.12.1): the ingress port binds all interfaces (host
    # network). Restrict it to the HA Supervisor ingress proxy (container
    # network segment 172.30.32.0/23 — verified source 172.30.32.2) and to
    # loopback (Docker health checks). LAN clients must go through the
    # authenticated Home Assistant Ingress session; direct LAN access to the
    # terminal and the token-bearing landing page is rejected with 403.
    allow 127.0.0.1;
    allow ::1;
    allow 172.30.32.0/23;
    deny all;

    # Home of the app: the OpenClaw landing page (HA-styled launcher with
    # gateway status + deep links into Control UI, Terminal, Docs and cert).
    # It is static and renders even when the gateway is down — the WebUI
    # itself stays at /webui/ for the panel and direct links.
    location = / {
      root /etc/nginx/html;
      default_type text/html;
      try_files /index.html =404;
      add_header Cache-Control "no-cache";
    }
    location = /landing {
      root /etc/nginx/html;
      default_type text/html;
      try_files /index.html =404;
      add_header Cache-Control "no-cache";
    }

    # Loading / splash page during startup
    location = /loading {
      root /etc/nginx/html;
      default_type text/html;
      try_files /loading.html =404;
      add_header Cache-Control "no-cache";
    }

    # Static app icon/logo
    location = /icon.png {
      alias /etc/nginx/html/icon.png;
      default_type image/png;
      add_header Cache-Control "public, max-age=86400";
    }

    # CA certificate download
    location = /cert/ca.crt {
      alias __CERTS_DIR__/ca.crt;
      default_type application/x-x509-ca-cert;
      add_header Content-Disposition 'attachment; filename="openclaw-ca.crt"';
    }

    # Health check (JSON ok, so the landing page status badge works)
    location = /api/health {
      access_log off;
      return 200 '{"ok":true}\n';
      add_header Content-Type application/json;
    }

    # Gateway readiness proxy for the landing page JS.
    # Avoids hard-coding the gateway port in the frontend and works across
    # ingress_only / lan_http / lan_https internal port differences.
    location = /webui/healthz {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/healthz;
      proxy_http_version 1.1;
      # OpenClaw 2026.9.5 identifies loopback requests by the Host header.
      # If we forward the original HA/Nabu Casa hostname, the gateway treats
      # the connection as remote and rejects the WebSocket handshake.
      # Force the loopback Host so the gateway keeps treating this as local.
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      access_log off;
    }

    # App log tail (read-only)
    location = /api/logs {
      alias /config/clawd/logs/gateway_startup.log;
      default_type text/plain;
      add_header Cache-Control "no-cache";
    }

    # WebUI — OpenClaw Gateway (loopback, WebSocket-capable)
    # NOTE: Do NOT set X-Forwarded-* / X-Real-IP here. OpenClaw 2026.8.2
    # treats loopback requests with forwarded-header evidence as proxy-shaped
    # traffic and rejects them with proxy_attribution_required unless they pass
    # trusted-proxy auth. We run the gateway locally in token-auth mode, so we
    # keep the request as plain local-direct traffic.

    # WebSocket clients (HA Supervisor ingress bridge) request the panel path
    # WITHOUT a trailing slash when the ControlUI stored the gateway URL as
    # .../webui (its normalized localStorage form). The previous implicit
    # 301 redirect to /webui/ breaks WebSocket upgrades: WS clients never
    # follow redirects, so the HA Supervisor closed the client socket right
    # after its 101 and the ControlUI showed "Gateway nicht erreichbar".
    # Proxy the exact /webui path directly to the gateway instead; browser
    # loads always use /webui/ (panel URL), so only the WS bridge hits this.
    location = /webui {
      # 0.7.12.4: during gateway startup (multi-minute SQLite warmup) show the
      # loading page instead of a raw 502, so the panel explains itself.
      proxy_intercept_errors on;
      error_page 502 503 504 = /loading;
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/webui/;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      proxy_set_header Accept-Encoding identity;
      proxy_read_timeout 86400s;
      proxy_send_timeout 86400s;
      proxy_buffering off;
      proxy_hide_header X-Frame-Options;
      proxy_hide_header Content-Security-Policy;
      # The gateway emits an unprefixed Link: </webui/...>; rel=preload header
      # that the browser resolves against the HA origin root. The HTML already
      # carries the correctly prefixed preload, so drop the header.
      proxy_hide_header Link;
      add_header X-Frame-Options "SAMEORIGIN" always;
      add_header Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; media-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; worker-src 'self'; connect-src 'self' ws: wss: data: https://api.openai.com https://tweakcn.com; frame-src 'self' http: https:" always;
    }

    location ^~ /webui/ {
      # 0.7.12.4: during gateway startup (multi-minute SQLite warmup) show the
      # loading page instead of a raw 502, so the panel explains itself.
      proxy_intercept_errors on;
      error_page 502 503 504 = /loading;
      # The gateway serves the Control UI rooted at /webui
      # (gateway.controlUi.basePath=/webui, set via oc_config_helper).
      # The ingress prefix is handled by the sub_filter rewrites below:
      # the browser lives under /api/hassio_ingress/<token>/webui/, so
      # HTML references to /webui/... must be re-prefixed with the ingress path.
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/webui/;
      proxy_set_header Accept-Encoding identity;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      # OpenClaw identifies loopback requests by the Host header.
      # If we forward the original HA/Nabu Casa hostname, the gateway treats
      # the connection as remote and rejects the WebSocket handshake.
      # Force the loopback Host so the gateway keeps treating this as local.
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      __WEBUI_AUTH_HEADER__
      proxy_read_timeout 86400s;
      proxy_send_timeout 86400s;
      proxy_buffering off;

      # OpenClaw ControlUI sends DENY framing headers by default. Strip them
      # here so the UI can be embedded inside the HA Ingress iframe, then
      # preserve OpenClaw's remaining CSP directives and only relax
      # frame-ancestors so same-origin framing works.
      proxy_hide_header X-Frame-Options;
      proxy_hide_header Content-Security-Policy;
      # The gateway emits an unprefixed Link: </webui/...>; rel=preload header
      # that the browser resolves against the HA origin root. The HTML already
      # carries the correctly prefixed preload, so drop the header.
      proxy_hide_header Link;
      add_header X-Frame-Options "SAMEORIGIN" always;

      # Rewrite OpenClaw's CSP so that only frame-ancestors is relaxed to 'self'.
      # We do this by re-injecting a policy that mirrors the bundled defaults but
      # permits same-origin framing. If OpenClaw adds new CSP tokens in a future
      # release they will be lost by this override; revisit once OpenClaw offers a
      # configurable frame-ancestors list (see github.com/openclaw/openclaw/issues/78577).
      add_header Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; media-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; worker-src 'self'; connect-src 'self' ws: wss: data: https://api.openai.com https://tweakcn.com; frame-src 'self' http: https:" always;

      # The gateway stamps <html data-openclaw-control-ui-base-path="/webui">.
      # Inside HA Ingress the browser path is /api/hassio_ingress/<token>/webui/,
      # so re-prefix the attribute (and the URLs the gateway emits) with the
      # ingress path. Without a prefix (direct nginx access) the untouched
      # "/webui/..." URLs stay correct.
      sub_filter_once off;
      sub_filter 'data-openclaw-control-ui-base-path="/webui"' 'data-openclaw-control-ui-base-path="$ingress_path_norm/webui"';
      sub_filter 'href="/webui/' 'href="$ingress_path_norm/webui/';
      sub_filter 'src="/webui/' 'src="$ingress_path_norm/webui/';
      sub_filter '<base href="/webui/"' '<base href="$ingress_path_norm/webui/"';
      # The gateway bakes build-time root-absolute asset URLs into its inline
      # import map / module manifest. Rewrite those too (plain and
      # entity-encoded forms), otherwise the browser fetches /webui/... from
      # the HA origin root and every dynamic chunk 404s.
      sub_filter '"/webui/' '"$ingress_path_norm/webui/';
      sub_filter '&quot;/webui/' '&quot;$ingress_path_norm/webui/';
      # The bootstrap config carries basePath:"/webui" (plain and
      # entity-encoded); the runtime builds asset URLs from it, so it must
      # point at the ingress-prefixed path as well.
      sub_filter '"basePath":"/webui"' '"basePath":"$ingress_path_norm/webui"';
      sub_filter '&quot;basePath&quot;:&quot;/webui&quot;' '&quot;basePath&quot;:&quot;$ingress_path_norm/webui&quot;';

      # No injected sidebar chrome: the HA panel chrome (collapsible sidebar
      # rail, like the rest of HA) is the intended navigation.

      # Purging stale localStorage entries left by pre-basePath builds
      # (gatewayUrl/bootRecord pointing at 127.0.0.1:18789 or at an ingress
      # path from another token). Runs before the ControlUI modules evaluate.
      sub_filter '<head>' '<head><script data-cfasync="false">(function(){var p=window.location.pathname||"/";var i=p.lastIndexOf("/webui/");var b=i>=0?p.slice(0,i+6):"";var m=p.match(/^(\/api\/hassio_ingress\/[^/]+)\//);if(m){try{var a=document.documentElement.getAttribute("data-openclaw-control-ui-base-path")||"";if(a.indexOf(m[1])!==0){document.documentElement.setAttribute("data-openclaw-control-ui-base-path",m[1]+"/webui");}}catch(_){}}try{var keys=Object.keys(localStorage);for(var k=0;k<keys.length;k++){var key=keys[k];if(key.indexOf("openclaw.control.gatewayUrl.v1:")===0||key.indexOf("openclaw.control.bootRecord.v1:")===0){var v=localStorage.getItem(key)||"";if(b?v.indexOf(b)<0:v.indexOf("127.0.0.1:18789")>=0){localStorage.removeItem(key);}}}}catch(_){}})();</script>';
    }

    # Static Control UI assets are served with their upstream precompressed
    # representation when the browser offers one. Unlike the HTML these change
    # only with releases (content-hashed names), so they are safe to cache and
    # must NOT be forced through identity encoding.
    location ^~ /webui/assets/ {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/webui/assets/;
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      proxy_set_header Accept-Encoding $http_accept_encoding;
      proxy_hide_header X-Frame-Options;
      proxy_hide_header Content-Security-Policy;
      proxy_hide_header Cache-Control;
      add_header X-Frame-Options "SAMEORIGIN" always;
      add_header Cache-Control "public, max-age=31536000, immutable";
      proxy_buffering off;
    }

    location ^~ /webui/themes/ {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/webui/themes/;
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      proxy_set_header Accept-Encoding $http_accept_encoding;
      proxy_hide_header X-Frame-Options;
      proxy_hide_header Content-Security-Policy;
      proxy_hide_header Cache-Control;
      add_header X-Frame-Options "SAMEORIGIN" always;
      add_header Cache-Control "public, max-age=3600";
      proxy_buffering off;
    }

    # Web terminal (ttyd)
    location = /terminal { return 302 /terminal/; }
    location ^~ /terminal/ {
      proxy_pass http://127.0.0.1:__TERMINAL_PORT__/terminal/;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
    }

    # Docs / Info
    location = /docs { return 302 /docs/; }
    location ^~ /docs/ {
      root /etc/nginx/html;
      index index.html;
      try_files $uri $uri/ =404;
      add_header Cache-Control "no-cache";
    }

    # Everything else: 404
    location / {
      return 404;
    }
  }

  __HTTPS_GATEWAY_BLOCK__
}

