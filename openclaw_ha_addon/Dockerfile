# OpenClaw HA-App v0.7.13 — Debian Bookworm Full-Stack
# OpenClaw 2026.9.9 + node-llama-cpp@3.20.0 + mcporter@0.12.3 + CUPS/Scanner + crawl4ai + Go-PATH-Fix + D-Bus/Avahi
# Builder stage removed (dead code since v0.7.5.1 — never wired)
# Build dependencies are kept in the final image so runtime native builds work
# NOTE: Since HA Supervisor 2026.04, build.yaml is obsolete. Base image must be
# set explicitly here. BUILD_ARCH is provided by the Supervisor/Builder.
ARG BUILD_ARCH
FROM ghcr.io/home-assistant/${BUILD_ARCH}-base-debian:bookworm

# Labels required when not using the official GitHub builder action
LABEL \
  io.hass.version="0.7.13.3" \
  io.hass.type="app" \
  io.hass.arch="aarch64|amd64"

ENV DEBIAN_FRONTEND=noninteractive
ENV OOM_SCORE_ADJ=0
ENV HOME=/config
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV NODE_COMPILE_CACHE=/config/.node-compile-cache
ENV CHROMIUM_CACHE=/tmp/openclaw/chromium_cache
# Playwright browsers are installed to /opt/ms-playwright during build and shared
# by playwright, patchright and crawl4ai (PLAYWRIGHT_BROWSERS_PATH is set below):
# Python tools resolve browsers directly in that root; /usr/bin/chromium is only
# an alias maintained by /usr/local/bin/link-playwright-chromium (image build +
# run.sh boot self-heal) - never by hardcoded globs.
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
    openssh-client \
    sshpass \
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
    usbutils \
    libpci3 \
    pulseaudio-utils \
    v4l-utils \
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
# Install Node.js 24 LTS from NodeSource
# =============================================================================
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && chmod 644 /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
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
# browser_links.sh -> /usr/local/bin/link-playwright-chromium resolves the real
# binary layout-agnostically (chrome-linux/ on x64, chrome-linux-arm64/ on arm64;
# the old chromium-*/chrome-linux/chrome glob matched only x64 and silently left
# dangling symlinks on every arm64 rebuild) and FAILS THE BUILD if nothing is found.
# Pin policy (survey 2026-10-07): playwright 1.63.0 = PyPI latest. Pins make
# builds reproducible; version bumps are deliberate (survey + audit + owner GO).
# =============================================================================
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# PEP 668 blocks system-wide pip on Debian Trixie.
# --break-system-packages is safe in a Docker image (no system to break).
COPY browser_links.sh /usr/local/bin/link-playwright-chromium
RUN chmod +x /usr/local/bin/link-playwright-chromium && \
    uv pip install --system --break-system-packages "playwright==1.63.0" && \
    playwright install chromium --with-deps && \
    /usr/local/bin/link-playwright-chromium

# =============================================================================
# crawl4ai — Web Crawling Framework (Basis, ohne ML-Deps)
# PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright (shared, ~956MB bereits im Image)
# KEIN [all] — torch, transformers, scipy explizit ausgeschlossen
# crawl4ai 0.9.x launches browsers through playwright AND patchright; each pins
# its own Chromium revision. Browser downloads previously happened only in the
# playwright layer above, so a crawl4ai bump could upgrade the packages while
# the matching revision was never fetched into /opt/ms-playwright (green build,
# broken crawls). Re-running both installs is a no-op at revision parity and
# closes that drift; the linker refreshes /usr/bin/chromium when the revision
# advances.
# Pins (survey 2026-10-07): crawl4ai 0.9.4 and patchright 1.63.0 = PyPI latest.
# =============================================================================
RUN uv pip install --system --break-system-packages "crawl4ai==0.9.4" "patchright==1.63.0" \
    && python3 -c 'from importlib.metadata import version; print("crawl4ai installed: " + version("crawl4ai"))' \
    && playwright install chromium \
    && patchright install chromium \
    && /usr/local/bin/link-playwright-chromium

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
# Robust install: explicit bash execution, verified sudo/su fallback, and
# required dependencies for the official installer on minimal Debian images.
# =============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    file \
    ruby \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash linuxbrew \
    && echo "linuxbrew ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/linuxbrew \
    && chmod 0440 /etc/sudoers.d/linuxbrew \
    && mkdir -p /home/linuxbrew/.linuxbrew \
    && chown -R linuxbrew:linuxbrew /home/linuxbrew

RUN curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o /tmp/install_homebrew.sh \
    && chmod +x /tmp/install_homebrew.sh \
    && if command -v sudo >/dev/null 2>&1; then \
         sudo -u linuxbrew NONINTERACTIVE=1 bash /tmp/install_homebrew.sh 2>&1 | tee /tmp/homebrew_install.log; \
       else \
         su - linuxbrew -c "NONINTERACTIVE=1 bash /tmp/install_homebrew.sh" 2>&1 | tee /tmp/homebrew_install.log; \
       fi \
    && cat /tmp/homebrew_install.log \
    && rm -f /tmp/install_homebrew.sh /tmp/homebrew_install.log

RUN if [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then \
        su - linuxbrew -c 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && brew --version'; \
    else \
        echo "ERROR: Homebrew brew binary not found at /home/linuxbrew/.linuxbrew/bin/brew" && exit 1; \
    fi

RUN echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> /home/linuxbrew/.bashrc

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
# Install OpenClaw 2026.9.9 + node-llama-cpp 3.20.0 + mcporter 0.12.3
# Bundle node-llama-cpp in the image so the default local memory/embeddings
# provider works in HAOS without requiring manual npm installs in /usr/lib.
#
# node-llama-cpp postinstall compiles llama.cpp from source. To prevent the
# RPi5 from pegging at 100% for minutes, we skip the automatic postinstall,
# patch the build to honor NLC_BUILD_PARALLEL, and run it manually with a
# conservative thread count. The compiled binary is baked into the image.
# =============================================================================
ENV NODE_LLAMA_CPP_POSTINSTALL=skip
# Version pinned after the 0.7.13 delta analysis (dist-verified 2026-10-09:
# exit-classifier token-identical to 2026.9.8, resolveThresholds byte-identical,
# unicode-guard anchors + undefined-rejection shim registry present, no Node
# engine bump). npm itself verifies the registry dist.integrity for the pinned
# version; the post-install gate re-checks the exact installed version so a
# silently wrong registry manifest fails the build loudly.
RUN npm install -g openclaw@2026.9.9 \
    && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('/usr/lib/node_modules/openclaw/package.json','utf8'));if(p.version!=='2026.9.9'){console.error('ERROR: unexpected OpenClaw version installed: '+p.version);process.exit(1)};console.log('OpenClaw pin verified: '+p.version)" \
    && npm install -g node-llama-cpp@3.20.0 \
    && npm install -g mcporter@0.12.3 \
    && npm install -g pnpm \
    && npm cache clean --force

# OpenClaw 2026.9.9 keeps the openai-http agentId fix natively (tarball-verified
# 2026-10-09 in dist/openai-http-CQ7X8xZA.mjs: agentId forwarded in the
# request-context path). No patch block needed.

# OWASP LLM01:2026 Control #5 — context-sensitive invisible-Unicode stripping at
# OpenClaw's external-content ingest boundaries (web_fetch/web_search results,
# email/webhook/cron/browser content). Upstream 2026.9.8 ships a naive char-class
# strip that breaks valid ZWJ emoji (👨‍👩‍👧) and leaves isolated variation
# selectors (U+FE00–U+FE0F) as a documented smuggling channel; web_search output
# strip was not stripped at all. Through 2026.9.9 upstream ships no native
# sanitizer (tarball-verified 2026-10-09: the patch applies cleanly, universality
# sweep 0 residues across 9160 dist files). The patch script splices the tested implementation
# from unicode-guard/strip-invisible-unicode.mjs into the dist and fails the
# build LOUDLY when upstream anchors change (never silently lose a security
# control). Behavior matrix + tradeoffs: unicode-guard/README.md.
COPY unicode-guard /openclaw_ha_addon/unicode-guard
RUN node /openclaw_ha_addon/unicode-guard/apply-unicode-guard-patch.mjs /usr/lib/node_modules/openclaw

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
# Copy app files
# =============================================================================
COPY run.sh /run.sh
COPY oc_config_helper.py /oc_config_helper.py
COPY oc_acpx_helper.py /oc_acpx_helper.py
COPY render_nginx.py /render_nginx.py
COPY oc-cleanup.sh /usr/local/bin/oc-cleanup
COPY oom-shim.cjs /usr/local/lib/oom-shim.cjs
COPY undefined-rejection-shim.cjs /app/undefined-rejection-shim.cjs
COPY openclaw-proxy-shim.cjs /usr/local/lib/openclaw-proxy-shim.cjs
COPY nginx.conf.tpl /etc/nginx/nginx.conf.tpl
COPY landing.html.tpl /etc/nginx/landing.html.tpl
COPY acpx /openclaw_ha_addon/acpx
COPY docs/index.html.tpl /openclaw_ha_addon/docs/index.html.tpl
COPY loading.html /openclaw_ha_addon/loading.html
COPY icon.png /openclaw_ha_addon/icon.png
COPY logo.png /openclaw_ha_addon/logo.png

RUN chmod +x /run.sh /oc_config_helper.py /oc_acpx_helper.py /render_nginx.py \
    /usr/local/bin/oc-cleanup /usr/local/lib/oom-shim.cjs /usr/local/lib/openclaw-proxy-shim.cjs \
    && mkdir -p /run/nginx /openclaw_ha_addon

RUN mkdir -p /config/.local/lib/python3.11/site-packages
ENV PYTHONPATH=/config/.local/lib/python3.11/site-packages

# Health check for Home Assistant Supervisor Watchdog
# 420s start-period + 4 retries (v0.7.12.7): Homebrew sync, skill copy, and gateway
# init take >4 min on a Raspberry Pi. Evidence — supervisor log 2026-10-07 19:41:39:
# "Watchdog found app OpenClaw Assistant is unhealthy, restarting..." followed by a
# docker kill (exit 137) on a CLEAN boot: the old 120s window expired while the gateway
# was still initializing, before /startupz could answer. Docker start-period semantics:
# failures during the grace window do not count toward retries, so slow-but-clean boots
# no longer trip the watchdog; real hangs are still caught fast afterwards (4 consecutive
# failed probes at a 30s interval).
# /api/health proves nginx is up; /startupz proves the OpenClaw gateway is ready for traffic.
# The gateway port is read at check time from the persisted config so it works across
# ingress_only / lan_http / lan_https internal port differences.
# TLS (audit 2026-10-09): in tailnet_serve/tailnet_funnel modes the gateway
# serves HTTPS on GW_PORT, so the plain-HTTP probe failed on every check and
# put a healthy container into the Supervisor restart loop. Read
# gateway.tls.enabled and probe accordingly.
HEALTHCHECK --interval=30s --timeout=10s --start-period=420s --retries=4 \
  CMD sh -c 'CONF=/config/.openclaw/openclaw.json; \
    GW_PORT=$(jq -r ".gateway.port // 18789" "$CONF" 2>/dev/null || echo 18789); \
    TLS=$(jq -r ".gateway.tls.enabled // false" "$CONF" 2>/dev/null || echo false); \
    wget --no-verbose --tries=1 --spider http://localhost:49200/api/health || exit 1; \
    if [ "$TLS" = "true" ]; then \
      wget --no-verbose --tries=1 --spider --no-check-certificate https://127.0.0.1:${GW_PORT}/startupz; \
    else \
      wget --no-verbose --tries=1 --spider http://127.0.0.1:${GW_PORT}/startupz; \
    fi'

ENTRYPOINT [ "/usr/bin/tini", "-g", "--" ]
CMD [ "/run.sh" ]

