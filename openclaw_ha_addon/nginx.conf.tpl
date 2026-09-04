worker_processes  1;

# Log to stderr/stdout (container-friendly)
error_log stderr notice;

events { worker_connections 1024; }

http {
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

    # Health check — proxy to actual OpenClaw Gateway health endpoint
    location = /api/health {
      access_log off;
      proxy_pass http://127.0.0.1:__GATEWAY_PORT__/health;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_connect_timeout 5s;
    }

    # Add-on log tail (read-only)
    location = /api/logs {
      alias /config/clawd/logs/gateway_startup.log;
      default_type text/plain;
      add_header Cache-Control "no-cache";
    }

    # WebUI — OpenClaw Gateway (loopback, WebSocket-capable)
    # For Ingress we always proxy via plain HTTP to the loopback gateway.
    # External HTTPS access is handled by __HTTPS_GATEWAY_BLOCK__.
    location ^~ /webui/ {
      proxy_pass http://127.0.0.1:__GATEWAY_PORT__/;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-User "homeassistant";
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 86400s;
      proxy_send_timeout 86400s;
      proxy_buffering off;

      # OpenClaw ControlUI sends DENY framing headers by default. Strip them
      # here so the UI can be embedded inside the HA Ingress iframe.
      proxy_hide_header X-Frame-Options;
      proxy_hide_header Content-Security-Policy;
      add_header Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; worker-src 'self'; connect-src 'self' ws: wss: https://api.openai.com https://tweakcn.com" always;
      add_header X-Frame-Options "SAMEORIGIN" always;

      # Inject the HA Ingress base path into the ControlUI HTML so the bundle
      # resolves the WebSocket URL against the external Ingress path instead of
      # window.location. This makes the WebUI work via Nabu Casa remote access.
      # Match both terminal-enabled="false" and "true" so the injection works
      # regardless of whether the terminal tab is enabled.
      sub_filter "data-openclaw-terminal-enabled=\"false\" lang=\"en\"" "data-openclaw-terminal-enabled=\"false\" lang=\"en\" data-openclaw-control-ui-base-path=\"$http_x_ingress_path/webui/\"";
      sub_filter "data-openclaw-terminal-enabled=\"true\" lang=\"en\"" "data-openclaw-terminal-enabled=\"true\" lang=\"en\" data-openclaw-control-ui-base-path=\"$http_x_ingress_path/webui/\"";
      sub_filter_once on;
    }

    # Web terminal (ttyd) — keep /terminal/ prefix because ttyd is started with -b /terminal
    location = /terminal { return 302 /terminal/; }
    location ^~ /terminal/ {
      proxy_pass http://127.0.0.1:__TERMINAL_PORT__;
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

  # HTTPS reverse proxy removed — OpenClaw terminates TLS natively via gateway.tls.
}

