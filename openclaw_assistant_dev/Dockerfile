# OpenClaw Home Assistant Addon - Dev Channel (Beta)
# Baut OpenClaw aus deinem Fork für Zugang zu Fixes und experimentellen Features

ARG BUILD_FROM=ghcr.io/hassio-addons/debian-base:7.3.4
FROM ${BUILD_FROM} AS builder

# Build-Dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

# OpenClaw Source (Dein Fork mit Subagent-Fix)
ARG OPENCLAW_VERSION=2026.4.8-patch1
ARG OPENCLAW_REPO=https://github.com/chillkiller/openclaw.git

WORKDIR /tmp/openclaw
RUN git clone --depth 1 --branch v${OPENCLAW_VERSION} ${OPENCLAW_REPO} . \
    || git clone --depth 1 ${OPENCLAW_REPO} .

# Installiere Dependencies und baue
RUN npm ci \
    && npm run build \
    && npm prune --production

# Runtime Image
FROM ${BUILD_FROM}

# Runtime Dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS (nur Runtime)
RUN curl -fsSL https://deb.source.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Kopiere gebauten OpenClaw
COPY --from=builder /tmp/openclaw/dist /opt/openclaw/dist
COPY --from=builder /tmp/openclaw/node_modules /opt/openclaw/node_modules
COPY --from=builder /tmp/openclaw/package.json /opt/openclaw/

# OpenClaw Binary verlinken
RUN ln -sf /opt/openclaw/dist/cli.js /usr/local/bin/openclaw

# Home Assistant Add-on Scripts
COPY rootfs /
RUN chmod a+x /etc/services.d/openclaw/*

# Ports
EXPOSE 18790 18789

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s \
    CMD curl -f http://localhost:18790/health || exit 1

# Start
CMD ["/init"]