# OpenClaw HA-Addon v0.7.7.2 — Debian Bookworm Full-Stack
# OpenClaw 2026.6.8 + CUPS/Scanner + crawl4ai + Go-PATH-Fix + D-Bus/Avahi
# Builder stage removed (dead code since v0.7.5.1 — never wired)
# Build dependencies are kept in the final image so runtime native builds work
FROM debian:bookworm-slim

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
# Zone 1: Persistent Runtime Dependencies (kept in final image)
# =============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core utilities
    sudo \
    tini \
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
    # Runtime libraries (keep -dev headers too for runtime native builds)
    libvips42 \
    libvips-dev \
    liblapack3 \
    libopenblas0 \
    libopenblas-dev \
    libopus0 \
    libopus-dev \
    libportaudio2 \
    portaudio19-dev \
    libasound2 \
    libasound2-dev \
    libpq5 \
    libpq-dev \
    # Playwright runtime deps
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
    nginx \
    jq \
    openssl \
    # mDNS / Bonjour / Avahi (LAN discovery)
    dbus \
    avahi-daemon \
    avahi-utils \
    libnss-mdns \
    # Audio/Media Stack
    sox \
    libsox-fmt-all \
    espeak-ng \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-tools \
    alsa-utils \
    # Database Tools
    postgresql-client \
    python3-psycopg2 \
    python3-pyodbc \
    # Dev-Tools
    tmux \
    ripgrep \
    fd-find \
    # GitHub CLI
    gh \
    # Printing Stack (CUPS/IPP/AirPrint)
    cups \
    cups-client \
    cups-daemon \
    cups-filters \
    cups-ipp-utils \
    cups-browsed \
    # Scanner Stack (eSCL/AirScan/WSD)
    sane-airscan \
    sane-utils \
    && rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates

# =============================================================================
# Zone 2: Native Build Dependencies (kept in final image)
# Required for node-llama-cpp, node-gyp native modules, and runtime skill builds.
# Kept because the target system has ample storage and we want everything built
# into the image/on first run rather than failing later due to missing headers.
# =============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Zone 3: Modern Toolchains (Go, Bun, uv) - Direct Binary Download
# =============================================================================
ARG TARGETARCH

# Go Runtime — official binary (Bookworm's golang-go package is Go 1.19, outdated)
RUN ARCH=$(echo ${TARGETARCH:-$(dpkg --print-architecture)} | sed 's|arm64|arm64|;s|amd64|amd64|') \
    && GO_VERSION=1.24.1 \
    && echo "Installing Go ${GO_VERSION} for architecture: ${ARCH}" \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
    | tar -C /usr/local -xzf - \
    && ln -sf /usr/local/go/bin/go /usr/local/bin/go \
    && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
    && go version \
    && if dpkg -l golang-go 2>/dev/null | grep -q '^ii'; then \
         echo "Purging conflicting golang-go (apt) to prevent PATH shadowing of Go ${GO_VERSION}" \
         && apt-get remove --purge -y golang-go \
         && apt-get autoremove --purge -y; \
       fi

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
# crawl4ai — Web Crawling Framework (Basis, ohne ML-Deps)
# PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright (shared, ~956MB bereits im Image)
# KEIN [all] — torch, transformers, scipy explizit ausgeschlossen
# =============================================================================
RUN uv pip install --system --break-system-packages crawl4ai \
    && echo "crawl4ai installed: $(python3 -c 'import crawl4ai; print(crawl4ai.__version__)' 2>/dev/null || echo 'version check failed')"

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
# Install OpenClaw 2026.6.8 + node-llama-cpp
# Bundle node-llama-cpp in the image so the default local memory/embeddings
# provider works in HAOS without requiring manual npm installs in /usr/lib.
#
# node-llama-cpp postinstall compiles llama.cpp from source. To prevent the
# RPi5 from pegging at 100% for minutes, we skip the automatic postinstall,
# patch the build to honor NLC_BUILD_PARALLEL, and run it manually with a
# conservative thread count. The compiled binary is baked into the image.
# =============================================================================
ENV NODE_LLAMA_CPP_POSTINSTALL=skip
RUN npm install -g openclaw@2026.6.8 node-llama-cpp@3.18.1 \
    && npm install -g pnpm \
    && npm cache clean --force

# Patch node-llama-cpp to honor NLC_BUILD_PARALLEL for constrained builds
RUN node - <<'NODE'
const fs = require('fs');
const path = '/usr/lib/node_modules/node-llama-cpp/dist/bindings/utils/compileLLamaCpp.js';
if (!fs.existsSync(path)) {
  console.error('ERROR: compileLLamaCpp.js not found at', path);
  process.exit(1);
}
let src = fs.readFileSync(path, 'utf8');
const marker = 'function getParallelBuildThreadsToUse(platform, gpu, ciMode = false) {';
if (!src.includes(marker)) {
  console.error('ERROR: getParallelBuildThreadsToUse marker not found');
  process.exit(1);
}
const injection = marker + '\n' +
  '    const envParallel = process.env.NLC_BUILD_PARALLEL;\n' +
  '    if (envParallel != null) {\n' +
  '        return Math.max(1, parseInt(envParallel, 10));\n' +
  '    }\n';
src = src.replace(marker, injection);
fs.writeFileSync(path, src);
console.log('OK: compileLLamaCpp.js now honors NLC_BUILD_PARALLEL');
NODE

# Build node-llama-cpp native bindings with limited parallelism (2 threads)
# so the RPi5 stays responsive during the Docker image build.
ENV NODE_LLAMA_CPP_POSTINSTALL=auto NLC_BUILD_PARALLEL=2
RUN node /usr/lib/node_modules/node-llama-cpp/dist/cli/cli.js postinstall \
    || (echo "WARN: node-llama-cpp postinstall failed; runtime build may be needed" && exit 0)

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
ENV PYTHONPATH=/config/.local/lib/python3.11/site-packages

# Health check for Home Assistant Supervisor Watchdog
# 120s start-period accounts for Homebrew sync, skill copy, and gateway init on slow hardware
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:48099/ || exit 1

ENTRYPOINT [ "/usr/bin/tini", "-g", "--" ]
CMD [ "/run.sh" ]
