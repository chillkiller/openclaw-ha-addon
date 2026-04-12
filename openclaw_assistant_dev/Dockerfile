# Dockerfile for OpenClaw Dev-Addon v0.6.1.7
# Multi-stage build for disk space optimization
# FIXED: Added sudo package (was missing causing Homebrew install failure)
FROM debian:trixie-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive

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
ENV HOME=/config
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV NODE_COMPILE_CACHE=/config/.node-compile-cache
ENV CHROMIUM_CACHE=/tmp/openclaw/chromium_cache
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
    # Dev-Tools (P2)
    tmux \
    ripgrep \
    fd-find \
    golang-go \
    # GitHub CLI
    gh \
    && rm -rf /var/lib/apt/lists/*

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

# =============================================================================
# Chromium - OPTIONAL (check if really needed, 348MB)
# If video processing is needed, keep. Otherwise can be removed.
# =============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# ttyd (web terminal) binary
# =============================================================================
ARG TARGETARCH
RUN ARCH=$(echo ${TARGETARCH:-$(dpkg --print-architecture)} | sed 's|arm64|aarch64|;s|arm/v7|armhf|;s|armv7|armhf|;s|amd64|x86_64|') \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${ARCH}" -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# =============================================================================
# Install OpenClaw v0.6.6 (pinned version)
# =============================================================================
RUN npm install -g openclaw@2026.4.10 \
    && npm install -g pnpm \
    && npm cache clean --force

RUN npm cache clean --force

# Fix safe.directory
RUN git config --global safe.directory /home/linuxbrew/.linuxbrew/Homebrew

# =============================================================================
# Copy add-on files
# =============================================================================
COPY run.sh /run.sh
COPY oc_config_helper.py /oc_config_helper.py
COPY render_nginx.py /render_nginx.py
COPY oc-cleanup.sh /usr/local/bin/oc-cleanup
COPY openclaw-proxy-shim.cjs /usr/local/lib/openclaw-proxy-shim.cjs
COPY nginx.conf.tpl /etc/nginx/nginx.conf.tpl
COPY landing.html.tpl /etc/nginx/landing.html.tpl

RUN chmod +x /run.sh /oc_config_helper.py /render_nginx.py /usr/local/bin/oc-cleanup \
    && mkdir -p /run/nginx

RUN mkdir -p /config/.local/lib/python3.11/site-packages
ENV PYTHONPATH=/config/.local/lib/python3.11/site-packages:

CMD [ "/run.sh" ]