worker_processes  1;

# Log to stderr/stdout (container-friendly)
error_log stderr notice;

events { worker_connections 1024; }

http {
  gzip off;

  # HTML responses must stay uncompressed so sub_filter can rewrite them.
  # The static-asset locations override this with an Accept-Encoding
  # passthrough so the gateway can serve brotli/gzip (3.4x smaller transfers).
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

  # Infer the HA Ingress base path from the request URI when the supervisor
  # does not send the X-Ingress-Path header. OpenClaw 2026.8.2 uses this
  # prefix to resolve WebSocket and asset URLs in the ControlUI.
  map $request_uri $ingress_path {
    ~^(/api/hassio_ingress/[^/]+)/    $1;
    default                          $http_x_ingress_path;
  }

  # Conditional prefixes for ControlUI asset rewriting.
  # If HA Supervisor sends X-Ingress-Path, use the absolute Ingress route.
  # Otherwise fall back to relative asset URLs so the browser resolves them
  # under the current /webui/ path (inside HA Ingress or direct nginx access).
  # Base path WITHOUT trailing slash. OpenClaw's ControlUI appends paths
  # like "/themes/" and "/assets/" itself, so a trailing slash would
  # produce double slashes (e.g. /webui//themes/claw.css).
  # Normalize the ingress path: defend against supervisor variants that
  # already include the /webui panel path (double-/webui bug, 2026-09-22)
  # and against the current variant that omits it (asset 404s, 2026-09-23).
  # All ControlUI prefixes are built as $ingress_path_norm + "/webui/..."
  # so the browser always resolves assets under the path the page was
  # loaded from (/api/hassio_ingress/<token>/webui/).
  map $ingress_path $ingress_path_norm {
    ""                        "";
    ~^(?<ip_base>.*)/webui/?$  $ip_base;
    default                    $ingress_path;
  }

  map $ingress_path_norm $control_ui_base_path {
    ""      "";
    default "$ingress_path_norm/webui";
  }

  map $ingress_path_norm $asset_href_prefix {
    ""      "./assets/";
    default "$ingress_path_norm/webui/assets/";
  }

  map $ingress_path_norm $asset_src_prefix {
    ""      "./assets/";
    default "$ingress_path_norm/webui/assets/";
  }

  map $ingress_path_norm $favicon_prefix {
    ""      "./favicon";
    default "$ingress_path_norm/webui/favicon";
  }

  map $ingress_path_norm $apple_prefix {
    ""      "./apple-touch-icon";
    default "$ingress_path_norm/webui/apple-touch-icon";
  }

  map $ingress_path_norm $manifest_prefix {
    ""      "./manifest.webmanifest";
    default "$ingress_path_norm/webui/manifest.webmanifest";
  }

  map $ingress_path_norm $theme_prefix {
    ""      "./themes/";
    default "$ingress_path_norm/webui/themes/";
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

    # Landing page (shown inside HA Ingress)
    location = / {
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

    # Static assets served under /webui/ must not require the app bearer
    # token because HA Supervisor proxies them without injecting that header.
    # HA Ingress already authenticates the user before forwarding the request.
    location ^~ /webui/assets/ {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/assets/;
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      proxy_set_header Accept-Encoding $http_accept_encoding;
      proxy_buffering off;
    }

    location ^~ /webui/themes/ {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/themes/;
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      proxy_set_header Accept-Encoding $http_accept_encoding;
      proxy_buffering off;
    }

    location ^~ /webui/favicon {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/favicon;
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      proxy_set_header Accept-Encoding $http_accept_encoding;
      proxy_buffering off;
    }

    location ^~ /webui/apple-touch-icon {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/apple-touch-icon;
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      proxy_set_header Accept-Encoding $http_accept_encoding;
      proxy_buffering off;
    }

    location ^~ /webui/manifest.webmanifest {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/manifest.webmanifest;
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:__GATEWAY_INTERNAL_PORT__;
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Forwarded "";
      proxy_set_header Accept-Encoding $http_accept_encoding;
      proxy_buffering off;
    }

    # WebSocket clients (HA Supervisor ingress bridge) request the panel path
    # WITHOUT a trailing slash when the ControlUI stored the gateway URL as
    # .../webui (its normalized localStorage form). The previous implicit
    # 301 redirect to /webui/ breaks WebSocket upgrades: WS clients never
    # follow redirects, so the HA Supervisor closed the client socket right
    # after its 101 and the ControlUI showed "Gateway nicht erreichbar".
    # Proxy the exact /webui path directly to the gateway instead; browser
    # loads always use /webui/ (panel URL), so only the WS bridge hits this.
    location = /webui {
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
    }

    location ^~ /webui/ {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/;
      proxy_set_header Accept-Encoding identity;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
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
      add_header X-Frame-Options "SAMEORIGIN" always;

      # Rewrite OpenClaw's CSP so that only frame-ancestors is relaxed to 'self'.
      # We do this by re-injecting a policy that mirrors the bundled defaults but
      # permits same-origin framing. If OpenClaw adds new CSP tokens in a future
      # release they will be lost by this override; revisit once OpenClaw offers a
      # configurable frame-ancestors list (see github.com/openclaw/openclaw/issues/78577).
      add_header Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; media-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; worker-src 'self'; connect-src 'self' ws: wss: data: https://api.openai.com https://tweakcn.com; frame-src 'self' http: https:" always;

      # OpenClaw 2026.8.2+ reads the base path from a data attribute on <html>.
      # When HA Supervisor sends X-Ingress-Path, set the attribute server-side.
      # When it doesn't (e.g. iframe/Companion App), a client-side script below
      # derives the path from window.location.pathname. We replace an existing
      # empty attribute to avoid duplicate attributes.
      sub_filter_types text/html;
      sub_filter_once off;

      sub_filter '<html data-openclaw-control-ui-base-path=""' '<html data-openclaw-control-ui-base-path="$control_ui_base_path"';
      sub_filter '<html ' '<html data-openclaw-control-ui-base-path="$control_ui_base_path" ';

      # OpenClaw 2026.9.4: when X-Ingress-Path is missing the attribute above is
      # empty, so the ControlUI falls back to ws://127.0.0.1:18789. We inject a
      # script immediately after <head> that:
      #  - Derives the Ingress base path from window.location.pathname.
      #  - Forces the data attribute on <html> (overwriting any duplicate/empty).
      #  - Removes stale localStorage gatewayUrl/bootRecord entries that would
      #    otherwise override the path and keep pointing at 127.0.0.1:18789.
      # This runs before any ControlUI module evaluates.
      sub_filter '<head>' '<head><script data-cfasync="false">(function(){var p=window.location.pathname||"/";var i=p.lastIndexOf("/webui/");var b=i>=0?p.slice(0,i+6):"";var e=document.documentElement;var a="data-openclaw-control-ui-base-path";if(b){e.removeAttribute(a);e.setAttribute(a,b);}try{var keys=Object.keys(localStorage);for(var k=0;k<keys.length;k++){var key=keys[k];if(key.indexOf("openclaw.control.gatewayUrl.v1:")===0||key.indexOf("openclaw.control.bootRecord.v1:")===0){var v=localStorage.getItem(key)||"";if(b?v.indexOf(b)<0:v.indexOf("127.0.0.1:18789")>=0){localStorage.removeItem(key);}}}}catch(_){}})();</script>';

      # Rewrite absolute asset links: relative when no Ingress path is known,
      # absolute under the Ingress path when X-Ingress-Path is sent. nginx
      # proxies both /webui/assets/* and /api/hassio_ingress/*/webui/assets/*
      # to the gateway's /assets/* regardless of the route.
      sub_filter "href=\"/favicon" "href=\"$favicon_prefix";
      sub_filter "href=\"/apple-touch-icon" "href=\"$apple_prefix";
      sub_filter "href=\"/manifest.webmanifest" "href=\"$manifest_prefix";
      sub_filter "href=\"/assets/" "href=\"$asset_href_prefix";
      sub_filter "src=\"/assets/" "src=\"$asset_src_prefix";

      # OpenClaw loads theme CSS dynamically via base + "/themes/theme.css".
      # Rewrite the absolute form as well, in case the base path injection fails.
      sub_filter "href=\"/themes/" "href=\"$theme_prefix";

      # If OpenClaw ever emits <base href="/">, rewrite it analogously.
      sub_filter '<base href="/"' '<base href="$control_ui_base_path"';
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

