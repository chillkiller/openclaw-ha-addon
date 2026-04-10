# =============================================================================
# Ultimate OpenClaw Dev-Addon (Sovereign Edition)
# Basis: Debian Trixie (13) - Official HA Base Image
# =============================================================================
# Warum Trixie?
# - Python 3.13, Go 1.23, ffmpeg 7.x, GStreamer 1.24 (alles aktuell)
# - Offizielle HA-Unterstützung (ghcr.io/home-assistant/{arch}-base-debian:trixie)
# - Längere Lebensdauer als Bookworm
# - Reduziert manuelle Installationen (mehr Pakete aus APT verfügbar)
# =============================================================================

ARG BUILD_FROM
FROM ${BUILD_FROM}

# Shell für bessere Fehlerbehandlung
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# =============================================================================
# ZONE 1: Core-System (APT - Immutable)
# Fundamentale Basis für alle Architekturen
# =============================================================================
RUN \
  apt-get update && \
  apt-get install -y --no-install-recommends \
    # Media & Audio (echte Pakete, keine Phantome!)
    ffmpeg \
    sox \
    libopus-dev \
    libvips-dev \
    espeak-ng \
    libsndfile1 \
    libsamplerate0-dev \
    portaudio19-dev \
    libpulse-dev \
    libasound2-dev \
    \
    # GStreamer für STT (faster-whisper, sherpa-onnx)
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-tools \
    \
    # Memory & Math (für Embeddings, BLAS, lancedb)
    liblapack3 \
    libopenblas-dev \
    \
    # Knowledge-DB Client (PostgreSQL + pgvector Vorbereitung)
    libpq-dev \
    postgresql-client \
    python3-psycopg2 \
    \
    # Python Development (für C-Extensions in ML-Bibliotheken)
    python3-dev \
    python3-venv \
    build-essential \
    pkg-config \
    cmake \
    \
    # Core Tools
    tmux \
    ripgrep \
    jq \
    fd-find \
    curl \
    git \
    openssl \
    \
    # CLI Tools (Debian-first Strategie)
    gh \
    golang-go \
    && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

# =============================================================================
# ZONE 2: Hardware-Acceleration (ENTFERNT)
# OpenClaw ist Orchestrator, kein GPU-Worker
# GPU-Arbeit läuft in separaten Addons
# =============================================================================
# Hinweis: ffmpeg-VAAPI-Zugriff optional via config.yaml: video: true
# Keine GPU-Bibliotheken im Image nötig

# =============================================================================
# ZONE 3: Dev-Toolchain & ML-Runtimes
# Werkzeuge zur Skill-Installation und Ausführung
# =============================================================================

# Node.js 22 LTS (über NodeSource, da Trixie evtl. nur 20.x hat)
RUN \
  mkdir -p /etc/apt/keyrings && \
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | \
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
  chmod 644 /etc/apt/keyrings/nodesource.gpg && \
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > \
    /etc/apt/sources.list.d/nodesource.list && \
  apt-get update && \
  apt-get install -y --no-install-recommends nodejs && \
  NODE_VERSION="$(node -v)" && \
  echo "$NODE_VERSION" | grep -E '^v22\.' && \
  rm -f /etc/apt/sources.list.d/nodesource.list && \
  rm -f /etc/apt/keyrings/nodesource.gpg && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

# pnpm global installieren (für clawhub und andere Skills)
RUN npm install -g pnpm && pnpm -v

# Bun Runtime (für QMD Memory Engine und JS-Tooling)
RUN \
  curl -fsSL https://bun.sh/install | bash && \
  bun --version

# Go Compiler (bereits in Zone 1 via apt install golang-go)
# Verifikation
RUN go version

# Homebrew (Linuxbrew) - NUR als Fallback für echte Ausnahmen
# Strategie: Debian-first, Homebrew nur wenn kein Debian-Paket existiert
ENV HOMEBREW_NO_AUTO_UPDATE=1 \
    HOMEBREW_NO_INSTALL_CLEANUP=1 \
    HOMEBREW_NO_ANALYTICS=1

RUN \
  useradd -m -s /bin/bash linuxbrew && \
  mkdir -p /home/linuxbrew/.linuxbrew && \
  chown -R linuxbrew:linuxbrew /home/linuxbrew/.linuxbrew && \
  # Homebrew installieren (mit SSSE3-Check - kann auf alter CPU fehlschlagen)
  (/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || \
    (echo "WARNUNG: Homebrew Installation fehlgeschlagen (CPU unterstützt SSSE3 nicht). Einige Skills könnten nicht funktionieren." && exit 0)) && \
  # Homebrew aktualisieren falls erfolgreich
  if [ -d /home/linuxbrew/.linuxbrew/Homebrew ]; then \
    cd /home/linuxbrew/.linuxbrew/Homebrew && \
    git config --global --add safe.directory /home/homebrew/.linuxbrew/Homebrew && \
    /home/linuxbrew/.linuxbrew/bin/brew update --force || true; \
  fi && \
  user root

# Homebrew zu PATH für alle User hinzufügen (Wrapper priorisiert für root-Aufrufe)
ENV PATH="/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

# Brew-Wrapper kopieren (wird separat geschrieben)
COPY brew-wrapper.sh /usr/local/bin/brew
RUN chmod +x /usr/local/bin/brew

# Brew verifizieren (nur wenn erfolgreich installiert)
# gcc NICHT installieren - nur bei echtem Bedarf bauen (z.B. für Go-Skills)
USER linuxbrew
RUN if [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then \
    /home/linuxbrew/.linuxbrew/bin/brew --version && \
    echo "Homebrew verfügbar; überspringe gcc (nur bei echtem Bedarf installieren)"; \
  else \
    echo "Überspringe Homebrew-Schritte - Installation evtl. fehlgeschlagen"; \
  fi
USER root

# OpenClaw global installieren (spezifische Version für Stabilität)
RUN \
  npm config set fund false && \
  npm config set audit false && \
  npm install -g openclaw@2026.4.9

# Shell-Aliase und Farben für interaktive Nutzung
RUN tee -a /etc/bash.bashrc <<'EOF'
# Aliase
alias bat="batcat"
alias fd="fdfind"

# Farben aktivieren
alias ls="ls --color=auto"
alias grep="grep --color=auto"
alias egrep="grep -E --color=auto"
alias fgrep="grep -F --color=auto"
alias diff="diff --color=auto"
alias ip="ip --color=auto"
if [ -z "${LS_COLORS+x}" ]; then
  export LS_COLORS="di=1;34:ln=1;36:so=1;pi=33:ex=1;32:bd=1;33:cd=1;33:su=1;31:sg=1;31:tw=1;34:ow=1;34"
fi
EOF

# =============================================================================
# ZONE 4: HEALTHCHECK
# HA muss erkennen können ob Proxy wirklich bereit ist (nicht nur Container läuft)
# =============================================================================
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:48099/ || exit 1

# =============================================================================
# ZONE 5: Default Command (wird von run.sh in HA überschrieben)
# =============================================================================
CMD ["/bin/bash"]
