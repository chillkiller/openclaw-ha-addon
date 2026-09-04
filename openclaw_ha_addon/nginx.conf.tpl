worker_processes  1;

# Log to stderr/stdout (container-friendly)
error_log stderr notice;

events { worker_connections 1024; }

http {
  gzip off;

  # Disable proxy compression so sub_filter can rewrite HTML
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
  map $ingress_path $control_ui_base_path {
    ""      "";
    default "$ingress_path/webui/";
  }

  map $ingress_path $asset_href_prefix {
    ""      "assets/";
    default "$ingress_path/webui/assets/";
  }

  map $ingress_path $asset_src_prefix {
    ""      "assets/";
    default "$ingress_path/webui/assets/";
  }

  map $ingress_path $favicon_prefix {
    ""      "favicon";
    default "$ingress_path/webui/favicon";
  }

  map $ingress_path $apple_prefix {
    ""      "apple-touch-icon";
    default "$ingress_path/webui/apple-touch-icon";
  }

  map $ingress_path $manifest_prefix {
    ""      "manifest.webmanifest";
    default "$ingress_path/webui/manifest.webmanifest";
  }

  server {
    listen __INGRESS_PORT__;
    server_name _;

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

    # Static add-on icon/logo
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

    # Add-on log tail (read-only)
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
    location ^~ /webui/ {
      proxy_pass http://127.0.0.1:__GATEWAY_INTERNAL_PORT__/;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host $host;
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
      # here so the UI can be embedded inside the HA Ingress iframe.
      proxy_hide_header X-Frame-Options;
      proxy_hide_header Content-Security-Policy;
      add_header Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; worker-src 'self'; connect-src 'self' ws: wss: https://api.openai.com https://tweakcn.com" always;
      add_header X-Frame-Options "SAMEORIGIN" always;

      # OpenClaw 2026.8.2 ships the ControlUI with an empty
      # data-openclaw-control-ui-base-path attribute. When HA Supervisor tells us
      # the Ingress path, set it explicitly so WebSocket/asset URLs resolve there.
      # If the header is missing, leave it empty so OpenClaw falls back to
      # window.location (which is correct inside the HA Ingress iframe).
      sub_filter 'data-openclaw-control-ui-base-path=""' 'data-openclaw-control-ui-base-path="$control_ui_base_path"';

      # Rewrite absolute asset links: relative when no Ingress path is known,
      # absolute under the Ingress path when X-Ingress-Path is sent. nginx
      # proxies both /webui/assets/* and /api/hassio_ingress/*/webui/assets/*
      # to the gateway's /assets/* regardless of the route.
      sub_filter "href=\"/favicon" "href=\"$favicon_prefix";
      sub_filter "href=\"/apple-touch-icon" "href=\"$apple_prefix";
      sub_filter "href=\"/manifest.webmanifest" "href=\"$manifest_prefix";
      sub_filter "href=\"/assets/" "href=\"$asset_href_prefix";
      sub_filter "src=\"/assets/" "src=\"$asset_src_prefix";

      # If OpenClaw ever emits <base href="/">, rewrite it analogously.
      sub_filter '<base href="/"' '<base href="$control_ui_base_path"';

      sub_filter_once off;
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

    # OpenClaw TUI (ttyd running `openclaw tui`)
    location = /tui { return 302 /tui/; }
    location ^~ /tui/ {
      proxy_pass http://127.0.0.1:__TUI_PORT__;
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

