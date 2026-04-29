# OpenClaw HA-Addon v4.22 (Trixie Baseline)
# Chunk 2: OOM-Shim implemented
FROM debian:trixie-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive

# Build ARGs for optional features
ARG OPENCLAW_EXTENSIONS=""
ARG OPENCLAW_INSTALL_BROWSER=""
ARG OPENCLAW_INSTALL_DOCKER_CLI=""
ARG OPENCLAW_DOCKER_APT_PACKAGES=""

# Build tools only needed during image build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    wget \
    ca-certificates \
    gnupg \
    lsb-release \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Rust (optional - only if needed for skills)
# RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# =============================================================================
# Stage 2: Runtime Image
# =============================================================================
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV OOM_SCORE_ADJ=0
ENV HOME=/config
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV NODE_COMPILE_CACHE=/config/.node-compile-cache
ENV CHROMIUM_CACHE=/tmp/openclaw/chromium_cache
# Playwright browsers are installed to /opt/ms-playwright during build.
# At runtime, run.sh symlinks /config/.cache/ms-playwright -> /opt/ms-playwright
# so that crawl4ai and other tools find them in the expected location.
ENV CHROME_FLAGS="--disk-cache-dir=/tmp/openclaw/chromium_cache --disk-cache-size=524288000"

# =============================================================================
# Zone 1: Core APT Dependencies (Audio/Media, Database, Dev-Tools)
# =============================================================================
# FIXED: Added sudo package for Homebrew installation
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core utilities (INCLUDES sudo - FIX!)
    sudo \
    curl \
    git \
    wget \
    unzip \
    ca-certificates \
    gnupg \
    lsb-release \
    procps \
    lsof \
    hostname \
    python3 \
    python3-pip \
    python3-full \
    ffmpeg \
    libvips-dev \
    liblapack3 \
    libopenblas-dev \
    libopus-dev \
    # Build tools (needed for node-gyp fallback compile)
    build-essential \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    nginx \
    jq \
    openssl \
    # mDNS / Bonjour / Avahi (LAN discovery)
    dbus \
    avahi-daemon \
    avahi-utils \
    libnss-mdns \
    # Audio/Media Stack (P0/P1 - missing in original)
    sox \
    libsox-fmt-all \
    espeak-ng \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-tools \
    alsa-utils \
    portaudio19-dev \
    libasound2-dev \
    # Database Tools (P1)
    postgresql-client \
    libpq-dev \
    python3-psycopg2 \
    python3-pyodbc \
    # Dev-Tools (P2)
    tmux \
    ripgrep \
    fd-find \
    golang-go \
    # GitHub CLI
    gh \
    && rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates

# =============================================================================
# Zone 3: Modern Toolchains (Bun, uv) - Direct Binary Download (Sledgehammer)
# =============================================================================
ARG TARGETARCH
RUN ARCH=$(echo ${TARGETARCH:-$(dpkg --print-architecture)} | sed 's|arm64|aarch64|;s|amd64|x64|') \
    && echo "Installing Bun for architecture: ${ARCH}" \
    && curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-${ARCH}.zip" -o /tmp/bun.zip \
    && unzip -oqd /tmp /tmp/bun.zip \
    && mv /tmp/bun-linux-${ARCH}/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-${ARCH} \
    && bun --version

# uv (Fast Python Packages)
RUN ARCH=$(echo ${TARGETARCH:-$(dpkg --print-architecture)} | sed 's|arm64|aarch64|;s|amd64|x86_64|') \
    && echo "Installing uv for architecture: ${ARCH}" \
    && curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-${ARCH}-unknown-linux-gnu.tar.gz" -o /tmp/uv.tar.gz \
    && tar -xzf /tmp/uv.tar.gz -C /tmp \
    && mv /tmp/uv-${ARCH}-unknown-linux-gnu/uv /usr/local/bin/uv \
    && chmod +x /usr/local/bin/uv \
    && rm -rf /tmp/uv.tar.gz /tmp/uv-${ARCH}-unknown-linux-gnu \
    && uv --version

# =============================================================================
# Install Node.js 22 LTS from NodeSource
# =============================================================================
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && chmod 644 /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Playwright Chromium - Single source for browser binaries
# Replaces system chromium to avoid duplication
# Installs to /opt/ms-playwright (inside the image, NOT /config which is runtime-only)
# =============================================================================
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# PEP 668 blocks system-wide pip on Debian Trixie.
# --break-system-packages is safe in a Docker image (no system to break).
RUN uv pip install --system --break-system-packages playwright && \
    playwright install chromium --with-deps && \
    # Create symlinks for compatibility with scripts expecting chromium-browser
    ln -sf /opt/ms-playwright/chromium-*/chrome-linux/chrome /usr/bin/chromium-browser && \
    ln -sf /opt/ms-playwright/chromium-*/chrome-linux/chrome /usr/bin/chromium && \
    echo "Playwright Chromium installed: $(/opt/ms-playwright/chromium-*/chrome-linux/chrome --version 2>/dev/null || echo 'version check failed')"

# =============================================================================
# Discord Plugin Dependency (P1)
# NOTE: Removed from build-time install. @discordjs/opus@0.10.0 has a known
# NEON intrinsic compile bug on aarch64 with GCC 14+ (celt_inner_prod_neon
# implicit declaration). OpenClaw installs its own npm deps at runtime, and
# the system libopus-dev (already installed) provides the shared library.
# If Discord voice is needed, opusscript works as a JS-only fallback.
# =============================================================================

# =============================================================================
# Install Homebrew (Linuxbrew)
# =============================================================================
RUN useradd -m -s /bin/bash linuxbrew \
    && echo "linuxbrew ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o /tmp/install_homebrew.sh \
    && chmod +x /tmp/install_homebrew.sh \
    && sudo -u linuxbrew -i /bin/bash -c "NONINTERACTIVE=1 /tmp/install_homebrew.sh 2>&1 | tee /tmp/homebrew_install.log" \
    && sudo -u linuxbrew -i /bin/bash -c 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && brew --version' \
    && echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> /home/linuxbrew/.bashrc \
    && cat /tmp/homebrew_install.log \
    && rm -f /tmp/install_homebrew.sh /tmp/homebrew_install.log

ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_BREW_FILE="/home/linuxbrew/.linuxbrew/Homebrew"

# Chromium is provided by Playwright (see above /opt/ms-playwright)
# No separate apt install needed

# =============================================================================
# ttyd (web terminal) binary
# =============================================================================
ARG TARGETARCH
RUN ARCH=$(echo ${TARGETARCH:-$(dpkg --print-architecture)} | sed 's|arm64|aarch64|;s|arm/v7|armhf|;s|armv7|armhf|;s|amd64|x86_64|') \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${ARCH}" -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# =============================================================================
# Install OpenClaw v0.7.5.2 (pinned version)
# =============================================================================
RUN npm install -g openclaw@2026.4.26 \
    && npm install -g pnpm \
    && npm cache clean --force

# Fix safe.directory
RUN git config --global safe.directory /home/linuxbrew/.linuxbrew/Homebrew

# =============================================================================
# Copy add-on files
# =============================================================================
COPY run.sh /run.sh
COPY oc_config_helper.py /oc_config_helper.py
COPY render_nginx.py /render_nginx.py
COPY oc-cleanup.sh /usr/local/bin/oc-cleanup
COPY oom-shim.cjs /usr/local/lib/oom-shim.cjs
COPY openclaw-proxy-shim.cjs /usr/local/lib/openclaw-proxy-shim.cjs
COPY nginx.conf.tpl /etc/nginx/nginx.conf.tpl
COPY landing.html.tpl /etc/nginx/landing.html.tpl

RUN chmod +x /run.sh /oc_config_helper.py /render_nginx.py /usr/local/bin/oc-cleanup /usr/local/lib/oom-shim.cjs \
    && mkdir -p /run/nginx

RUN mkdir -p /config/.local/lib/python3.11/site-packages
ENV PYTHONPATH=/config/.local/lib/python3.11/site-packages:

# Health check for Home Assistant Supervisor Watchdog
# 120s start-period accounts for Homebrew sync, skill copy, and gateway init on slow hardware
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:48099/ || exit 1

CMD [ "/run.sh" ]
